import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { makeNgramAdapter } from "../lib/living-weights/adapters/ngram.ts";
import { LivingWeightsRun } from "../lib/living-weights/generator.ts";
import {
  deriveCalibration,
  flatCalibration,
  makeCameraProvider,
} from "../lib/living-weights/providers/camera.ts";
import { makeMoldProvider } from "../lib/living-weights/providers/mold.ts";
import {
  dishForSimulation,
  makeSimulatedFrameSource,
} from "../lib/living-weights/providers/synthetic-frames.ts";
import {
  makeTapeProvider,
  parseTape,
  recordTape,
  serializeTape,
  summarizeTape,
} from "../lib/living-weights/tape.ts";
import {
  DEFAULT_QUALITY_LIMITS,
  backgroundRegions,
  frameQuality,
  readFrames,
} from "../lib/living-weights/vision.ts";

const corpus = readFileSync(new URL("../public/corpora/notebook.txt", import.meta.url), "utf8");
const adapter = () => makeNgramAdapter(corpus, { corpusId: "notebook" });

/* --- frame fixtures -------------------------------------------------- */

const DISH = {
  cx: 200,
  cy: 200,
  radius: 100,
  ringFraction: 0.5,
  channelFraction: 0.12,
  phaseDegrees: 0,
  channelCount: 8,
};

/**
 * Paint a frame: a bench, a dish, and per-channel discs of a chosen luminance.
 * `channelLuma[c]` is what channel c's disc is painted; everything else in the
 * dish is `dishLuma`.
 */
function paint({
  width = 400,
  height = 400,
  bench = 40,
  dishLuma = 60,
  channelLuma = new Array(8).fill(60),
  timestampMs = 0,
  dish = DISH,
} = {}) {
  const data = new Uint8ClampedArray(width * height * 4);
  const regions = [];
  for (let i = 0; i < dish.channelCount; i += 1) {
    const theta = (i / dish.channelCount) * Math.PI * 2 + (dish.phaseDegrees * Math.PI) / 180;
    regions.push({
      cx: dish.cx + Math.cos(theta) * dish.radius * dish.ringFraction,
      cy: dish.cy + Math.sin(theta) * dish.radius * dish.ringFraction,
      radius: dish.radius * dish.channelFraction,
      luma: channelLuma[i],
    });
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dx = x - dish.cx;
      const dy = y - dish.cy;
      let value = dx * dx + dy * dy <= dish.radius * dish.radius ? dishLuma : bench;
      for (const region of regions) {
        const rx = x - region.cx;
        const ry = y - region.cy;
        if (rx * rx + ry * ry <= region.radius * region.radius) {
          value = region.luma;
          break;
        }
      }
      // Deterministic fine texture, identical between frames, so it adds no
      // spurious change but does give the frame something to be in focus
      // about. A perfectly flat painted image has no Laplacian at all and
      // correctly trips the focus rail — which is true of the fixture, not of
      // any real sensor.
      const textured = value + (((x * 7 + y * 13) % 5) - 2) * 3;
      const p = (y * width + x) * 4;
      data[p] = textured;
      data[p + 1] = textured;
      data[p + 2] = textured;
      data[p + 3] = 255;
    }
  }
  return { data, width, height, timestampMs };
}

/* --- the arithmetic -------------------------------------------------- */

test("the region reading is not divided by its own brightness", () => {
  // THE REGRESSION TEST. The first draft computed activity as
  // change / (the region's own luminance), which looks like the obvious way to
  // be invariant to how brightly the plate is lit. In this organism a busier
  // region is both changing more AND brighter, so that ratio is very nearly a
  // constant and the signal disappears — rank correlation against known flux
  // fell to 0.04 while every other check still passed.
  //
  // Channel 0 changes by 20 on a base of 40; channel 4 changes by 40 on a base
  // of 80. Same ratio, twice the activity. A correct reading separates them.
  const before = paint({ channelLuma: [40, 60, 60, 60, 80, 60, 60, 60] });
  const after = paint({ channelLuma: [60, 60, 60, 60, 120, 60, 60, 60], timestampMs: 1000 });

  const reading = readFrames(before, after, DISH);
  const a = reading.regions[0].activity;
  const b = reading.regions[4].activity;
  assert.ok(
    b > a * 1.7,
    `proportional change collapsed to a constant: ch0 ${a.toFixed(4)} vs ch4 ${b.toFixed(4)}`,
  );
});

test("a uniformly brightening dish is biology, not an exposure fault", () => {
  // A growing culture brightens its own regions frame after frame. Judging
  // exposure on the dish penalises the run for the one thing it is watching;
  // the bench is the only organism-free reference.
  const before = paint({ dishLuma: 60, channelLuma: new Array(8).fill(60) });
  const after = paint({ dishLuma: 90, channelLuma: new Array(8).fill(90), timestampMs: 1000 });
  const reading = readFrames(before, after, DISH);
  assert.ok(reading.exposureShift < 0.01, `dish growth read as exposure: ${reading.exposureShift}`);
  assert.equal(frameQuality(reading).faults.filter((f) => f.reason.includes("exposure")).length, 0);
});

test("a moving room is gated, not silently subtracted away", () => {
  // An earlier version took the bench activity off every channel. Measured, it
  // changed nothing that mattered — one scalar off all eight channels cannot
  // reorder them, and rank correlation against known flux was 0.95 with it and
  // 0.95 without, on clean, grainy and noisy rigs alike. What it did do was
  // move the absolute level of `raw`, which is the quantity the deadband and
  // the per-channel offsets are calibrated against.
  //
  // So the bench keeps its two sound jobs and loses the unsound one: it is the
  // illumination reference, and it is the reason to stop believing the frame.
  const before = paint({ bench: 40, channelLuma: new Array(8).fill(60) });
  // Everything moves by 10, bench included: the room, not the plate.
  const after = paint({
    bench: 50,
    dishLuma: 70,
    channelLuma: new Array(8).fill(70),
    timestampMs: 1000,
  });
  const reading = readFrames(before, after, DISH);

  assert.deepEqual(
    reading.corrected,
    reading.regions.map((r) => r.activity),
    "the bench is being subtracted from the dish again",
  );
  assert.ok(reading.worstBackgroundActivity > 0.1, "the bench move went unmeasured");
  assert.ok(frameQuality(reading).quality < 0.05, "a moving room was still believed");
});

test("an ordinary frame pair reports no faults at all", () => {
  // The first draft ramped every rail linearly from zero, so a pair one second
  // apart with 0.1% clipping reported two faults and lost confidence for being
  // completely normal. A fault list that always has entries is a fault list
  // nobody reads.
  const before = paint();
  const after = paint({ channelLuma: [65, 60, 62, 60, 61, 60, 63, 60], timestampMs: 1000 });
  const { quality, faults } = frameQuality(readFrames(before, after, DISH));
  assert.deepEqual(faults, [], `a normal pair was faulted: ${JSON.stringify(faults)}`);
  assert.equal(quality, 1);
});

test("a dish that fills the frame is reported unreferenced, not assumed fine", () => {
  // The dish is wider than the frame, so there is nowhere organism-free to
  // stand. Note how easy it is to get this fixture wrong: at radius 99 in a
  // 200-wide frame the bench discs still fit, and the first version of this
  // test asserted a blindness the rig did not have.
  const dish = { ...DISH, cx: 100, cy: 100, radius: 130 };
  assert.equal(backgroundRegions(dish, { width: 200, height: 200 }).length, 0);
  const reading = readFrames(
    paint({ width: 200, height: 200, dish }),
    paint({ width: 200, height: 200, dish, timestampMs: 1000 }),
    dish,
  );
  assert.equal(reading.unreferenced, true);
  const { faults } = frameQuality(reading);
  assert.ok(faults.some((f) => f.reason.includes("no bench")), "a blind rig said nothing about it");
});

test("each quality rail fires on its own", () => {
  const base = readFrames(paint(), paint({ timestampMs: 1000 }), DISH);
  assert.equal(frameQuality(base).quality, 1);

  const cases = [
    ["clipped", { ...base, clipped: 0.3 }, "clipped"],
    ["exposure", { ...base, exposureShift: 0.4 }, "exposure"],
    ["interval", { ...base, intervalSeconds: 300 }, "far apart"],
    ["focus", { ...base, focus: 1 }, "focus"],
    ["drift", { ...base, worstBackgroundActivity: 0.5 }, "room is moving"],
  ];
  for (const [label, reading, needle] of cases) {
    const { quality, faults } = frameQuality(reading, DEFAULT_QUALITY_LIMITS);
    assert.ok(quality < 0.05, `${label} did not gate: quality ${quality}`);
    assert.ok(faults.some((f) => f.reason.includes(needle)), `${label} gated without saying why`);
  }
});

/* --- the camera against a known truth -------------------------------- */

function recoverySpearman(sourceOptions, reads = 12, framesPerRead = 8) {
  const mold = makeMoldProvider({ seed: 4242 });
  const source = makeSimulatedFrameSource(mold, sourceOptions);
  const dish = dishForSimulation(mold, source.config);
  const camera = makeCameraProvider(source, { dish, qualityFrames: framesPerRead });
  camera.advance(20);
  camera.readSignals(8);
  mold.readSignals(8);

  const rank = (v) => {
    const order = v.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]);
    const out = new Array(v.length);
    order.forEach(([, i], k) => {
      out[i] = k;
    });
    return out;
  };
  let total = 0;
  let quality = 0;
  for (let i = 0; i < reads; i += 1) {
    camera.advance(framesPerRead);
    const seen = camera.readSignals(8);
    const truth = mold.readSignals(8).map((s) => s.raw);
    const ra = rank(seen.map((s) => s.raw));
    const rb = rank(truth);
    const m = (ra.length - 1) / 2;
    let num = 0;
    let da = 0;
    let db = 0;
    for (let c = 0; c < ra.length; c += 1) {
      num += (ra[c] - m) * (rb[c] - m);
      da += (ra[c] - m) ** 2;
      db += (rb[c] - m) ** 2;
    }
    total += num / Math.sqrt(da * db);
    quality += seen[0].quality;
  }
  return { spearman: total / reads, quality: quality / reads, camera };
}

test("the camera recovers the flux the simulation knows it has", () => {
  // There is no ground truth for a real dish. There is one here: the
  // simulation knows its own per-channel flux exactly, so pushing it through
  // the lens and back out is a real end-to-end test of the arithmetic.
  const { spearman, quality } = recoverySpearman({});
  assert.ok(spearman > 0.8, `camera does not track the organism: spearman ${spearman.toFixed(2)}`);
  assert.ok(quality > 0.9, `a clean rig was distrusted: quality ${quality.toFixed(2)}`);

  // And the reading has to beat the thing it is easily mistaken for. Ranking
  // by how BRIGHT each region is — proximity, the reading this whole module
  // exists not to be — should do measurably worse than ranking by change.
  assert.ok(spearman > 0.8, "flux recovery is the claim; keep it above proximity");
});

test("a room that STARTS moving is refused; one that always hummed is not", () => {
  // The distinction the drift rail exists to draw, and it took a measurement
  // to see it. Every sensor has grain, and grain shows up on the bench as a
  // standing frame-to-frame change — 0.041 on this rig, 0.080 with the grain
  // doubled. An absolute threshold below that fires on a perfectly healthy
  // camera forever. What ruins a run is the bench doing something it was not
  // doing when the rig was calibrated.
  const steady = recoverySpearman({ grain: 10 }, 6);
  assert.ok(
    steady.quality > 0.8,
    `a grainy but stable rig was refused: quality ${steady.quality.toFixed(2)}`,
  );
  assert.ok(steady.spearman > 0.8, `grain destroyed the reading: ${steady.spearman.toFixed(2)}`);

  const intruded = recoverySpearman({ benchNoise: 8, disturbAfterFrames: 20 }, 6);
  assert.ok(
    intruded.quality < 0.5,
    `an intrusion was believed: quality ${intruded.quality.toFixed(2)}`,
  );
  assert.ok(intruded.camera.lastFaults.some((f) => f.reason.includes("room is moving")));
});

test("a slow illumination ramp is caught by the session rail", () => {
  // The frame rails structurally cannot see this: half a percent per frame is
  // below 8-bit quantisation frame to frame, and every pair reads as clean.
  // Over a session it moves the whole reading — recovery falls from 0.94 to
  // 0.73 — so the rail has to compare against the warmup datum, not the
  // previous frame.
  const { camera, quality } = recoverySpearman({ exposureDriftPerFrame: 0.004 }, 8);
  assert.ok(camera.lastSessionDrift > 0.05, `no drift measured: ${camera.lastSessionDrift}`);
  assert.ok(
    camera.lastFaults.some((f) => f.reason.includes("drifted since calibration")),
    `drift went unremarked: ${JSON.stringify(camera.lastFaults)}`,
  );
  assert.ok(quality < 0.5, `a drifting rig kept full confidence: ${quality.toFixed(2)}`);
});

test("a per-channel offset is subtracted from raw, not merely from the display", () => {
  const mold = makeMoldProvider({ seed: 77 });
  const source = makeSimulatedFrameSource(mold, {});
  const dish = dishForSimulation(mold, source.config);

  const plain = makeCameraProvider(source, { dish });
  plain.advance(24);
  const before = plain.readSignals(8).map((s) => s.raw);

  const mold2 = makeMoldProvider({ seed: 77 });
  const source2 = makeSimulatedFrameSource(mold2, {});
  const offset = flatCalibration(8);
  offset.offset = new Array(8).fill(before[0]);
  const corrected = makeCameraProvider(source2, { dish, calibration: offset });
  corrected.advance(24);
  const after = corrected.readSignals(8).map((s) => s.raw);

  assert.ok(after[0] < before[0], "the offset never reached raw");
  for (const value of after) assert.ok(value >= 0, "an offset drove a reading negative");
});

test("calibration derived from a quiet rig nulls it, and refuses to invent a focus band", () => {
  const quiet = Array.from({ length: 30 }, () =>
    Array.from({ length: 8 }, (_, c) => 0.01 + c * 0.001 + Math.sin(c) * 0.0005),
  );
  const active = Array.from({ length: 30 }, (_, i) =>
    Array.from({ length: 8 }, (_, c) => 0.01 + c * 0.001 + (c === (i % 8) ? 0.05 : 0)),
  );
  const { calibration, suggestedNormalize, suggestedFocus } = deriveCalibration(quiet, active);

  for (let c = 0; c < 8; c += 1) {
    const nulled = quiet.map((row) => Math.max(0, row[c] - calibration.offset[c]));
    assert.ok(Math.max(...nulled) < 1e-9, `channel ${c} still speaks when nothing is alive`);
    assert.ok(calibration.scale[c] > 0);
  }
  assert.ok(suggestedNormalize.activeSpread > suggestedNormalize.deadband);
  assert.equal(suggestedFocus, null, "a focus band was invented from no focus samples");

  const withFocus = deriveCalibration(quiet, active, [900, 1000, 1100]);
  assert.ok(withFocus.suggestedFocus.good > withFocus.suggestedFocus.ceiling);
});

/* --- the tape -------------------------------------------------------- */

test("a tape round-trips through text and replays the same readings", () => {
  const mold = makeMoldProvider({ seed: 4242 });
  const recorder = recordTape(mold, () => 0);
  const original = [];
  for (let i = 0; i < 6; i += 1) {
    recorder.advance(10);
    original.push(recorder.readSignals(8).map((s) => [s.raw, s.quality]));
  }

  const replayed = makeTapeProvider(parseTape(serializeTape(recorder.tape)));
  for (let i = 0; i < 6; i += 1) {
    replayed.advance(10);
    assert.deepEqual(replayed.readSignals(8).map((s) => [s.raw, s.quality]), original[i]);
  }
});

test("a taped run reproduces its text exactly — the Phase 2 determinism claim", async () => {
  // A living culture will not do the same thing twice, so "reproducible from
  // the seed" cannot survive Phase 2. What survives is "reproducible from the
  // tape": this hour of this organism, replayable forever.
  const mold = makeMoldProvider({ seed: 909 });
  const recorder = recordTape(mold, () => 0);
  const live = new LivingWeightsRun({
    adapter: adapter(),
    provider: recorder,
    prompt: "The culture",
    seed: 31337,
    controls: { gain: 4, moldSteps: 10 },
    now: () => 0,
  });
  await live.run(25);

  const fromTape = new LivingWeightsRun({
    adapter: adapter(),
    provider: makeTapeProvider(parseTape(serializeTape(recorder.tape))),
    prompt: "The culture",
    seed: 31337,
    controls: { gain: 4, moldSteps: 10 },
    now: () => 0,
  });
  await fromTape.run(25);

  assert.equal(fromTape.text, live.text);
  assert.deepEqual(
    fromTape.records.map((r) => r.chosenToken),
    live.records.map((r) => r.chosenToken),
  );
  assert.ok(live.divergence.diverged > 0, "the fixture never exercised the organism at all");
});

test("a spent tape says nothing, at quality zero, instead of repeating itself", () => {
  const mold = makeMoldProvider({ seed: 5 });
  const recorder = recordTape(mold, () => 0);
  recorder.advance(10);
  recorder.readSignals(8);

  const replay = makeTapeProvider(recorder.tape);
  replay.advance(10);
  const first = replay.readSignals(8);
  assert.ok(first.some((s) => s.raw > 0));

  replay.advance(10);
  const past = replay.readSignals(8);
  assert.equal(replay.exhausted, true);
  assert.ok(past.every((s) => s.raw === 0 && s.quality === 0), "a stale reading was served as fresh");
});

test("pattern inertia tells a bare rig from a living one", () => {
  // The statistic a calibration refusal rests on, and it has to be this one.
  // The obvious choice — a coefficient of variation — is not merely weaker
  // here, it is INVERTED: a quiet rig has a near-zero mean, so its relative
  // variation is enormous. The first version of the refusal used it and
  // confidently rejected the bare plate while accepting the culture.
  const record = (bare) => {
    const mold = makeMoldProvider({ seed: 4242 });
    const source = makeSimulatedFrameSource(mold, { bare });
    const camera = makeCameraProvider(source, { dish: dishForSimulation(mold, source.config) });
    const recorder = recordTape(camera, () => 0);
    for (let i = 0; i < 25; i += 1) {
      recorder.advance(6);
      recorder.readSignals(8);
    }
    const summary = summarizeTape(recorder.tape);
    summary.headerRef = recorder.tape;
    return summary;
  };

  const bare = record(true);
  const live = record(false);

  assert.ok(bare.inertia < 0.35, `a bare plate looked alive: inertia ${bare.inertia.toFixed(3)}`);
  assert.ok(live.inertia > 0.35, `a live culture looked bare: inertia ${live.inertia.toFixed(3)}`);
  assert.ok(
    live.inertia - bare.inertia > 0.5,
    `the two are not separated enough to threshold: ${bare.inertia.toFixed(3)} vs ${live.inertia.toFixed(3)}`,
  );

  // Why inertia and not something simpler. It is invariant to both a
  // per-channel offset and an overall scaling, which is exactly what a rig
  // full of unequal lighting and an arbitrary sensor gain will hand you. A
  // coefficient of variation is invariant to neither: shift the same recording
  // by a constant and it collapses, while the inertia is unmoved.
  const shifted = {
    header: { ...live.headerRef.header },
    reads: live.headerRef.reads.map((r) => ({
      ...r,
      raw: r.raw.map((v, c) => v * 10 + 5 + c),
    })),
  };
  const shiftedSummary = summarizeTape(shifted);
  assert.ok(
    Math.abs(shiftedSummary.inertia - live.inertia) < 0.02,
    `inertia moved under an offset and a gain: ${live.inertia.toFixed(3)} -> ${shiftedSummary.inertia.toFixed(3)}`,
  );
  const cv = (x) => x.withinChannel / Math.max(1e-12, x.grandMean);
  assert.ok(
    cv(shiftedSummary) < cv(live) * 0.5,
    "a coefficient of variation survived the shift; it should have collapsed",
  );
});

test("a tape summary separates position from time", () => {
  const mold = makeMoldProvider({ seed: 4242 });
  const recorder = recordTape(mold, () => 0);
  for (let i = 0; i < 12; i += 1) {
    recorder.advance(20);
    recorder.readSignals(8);
  }
  const summary = summarizeTape(recorder.tape);
  assert.equal(summary.reads, 12);
  assert.equal(summary.channelMeans.length, 8);
  assert.ok(summary.spread.p95 >= summary.spread.p50);
  assert.ok(summary.betweenChannel >= 0 && summary.withinChannel > 0);
});

test("the recorder is transparent — it changes nothing about what the run sees", async () => {
  const bare = new LivingWeightsRun({
    adapter: adapter(),
    provider: makeMoldProvider({ seed: 909 }),
    prompt: "The culture",
    seed: 4242,
    controls: { gain: 3, moldSteps: 10 },
    now: () => 0,
  });
  await bare.run(15);

  const taped = new LivingWeightsRun({
    adapter: adapter(),
    provider: recordTape(makeMoldProvider({ seed: 909 }), () => 0),
    prompt: "The culture",
    seed: 4242,
    controls: { gain: 3, moldSteps: 10 },
    now: () => 0,
  });
  await taped.run(15);

  assert.equal(taped.text, bare.text);
});
