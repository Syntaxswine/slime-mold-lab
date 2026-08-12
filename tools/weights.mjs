#!/usr/bin/env node
/**
 * Living Weights — the instrument.
 *
 * Every constant in lib/living-weights that could have been a guess is set
 * from a section of this file, and every claim the docs make about the piece
 * is reproducible by running one.
 *
 *   node tools/weights.mjs channels     channel fairness and the spread
 *                                       distribution the normaliser is built on
 *   node tools/weights.mjs run          generate text, write a JSONL run log
 *   node tools/weights.mjs ab           same seed, gain 0 vs gain G, side by side
 *   node tools/weights.mjs sweep        divergence against gain
 *   node tools/weights.mjs replay FILE  verify a run log three ways
 *   node tools/weights.mjs recover      does the camera recover a KNOWN flux?
 *   node tools/weights.mjs tape         record a sensor tape
 *   node tools/weights.mjs calibrate    derive the constants from a quiet tape
 *   node tools/weights.mjs pulse        alive, or merely changing?
 *
 * Flags: --seed --tokens --gain --mode --assignment --provider --preset
 *        --moldSteps --temperature --corpus --out --tape --quiet --active
 *
 * `--provider` takes mold (default), sliders, camera (the simulated culture
 * seen through the whole vision pipeline) or tape (a recording played back).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { makeNgramAdapter } from "../lib/living-weights/adapters/ngram.ts";
import { LivingWeightsRun } from "../lib/living-weights/generator.ts";
import { parseRun, serializeRun } from "../lib/living-weights/log.ts";
import { deriveCalibration, makeCameraProvider } from "../lib/living-weights/providers/camera.ts";
import { makeMoldProvider } from "../lib/living-weights/providers/mold.ts";
import { makeSliderProvider } from "../lib/living-weights/providers/sliders.ts";
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
import { rerun, verifyChain, verifyRun } from "../lib/living-weights/replay.ts";
import { DEFAULT_NORMALIZE } from "../lib/living-weights/weights.ts";

const argv = process.argv.slice(2);
const section = argv.find((a) => !a.startsWith("--")) ?? "channels";
const positional = argv.filter((a) => !a.startsWith("--")).slice(1);

function flag(name, fallback) {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const index = argv.indexOf(`--${name}`);
  if (index !== -1 && argv[index + 1] && !argv[index + 1].startsWith("--")) return argv[index + 1];
  return fallback;
}
const num = (name, fallback) => Number(flag(name, fallback));

const CORPUS = flag("corpus", "public/corpora/notebook.txt");
const PROMPT = flag("prompt", "The culture");

function adapter() {
  return makeNgramAdapter(readFileSync(new URL(`../${CORPUS}`, import.meta.url), "utf8"), {
    corpusId: CORPUS,
  });
}

function provider(seedOffset = 0) {
  const kind = flag("provider", "mold");
  const seed = num("seed", 20260811) + seedOffset;
  const tapeFile = flag("tape", null);
  // A tape wins over everything. If one was named, replaying it IS the run,
  // and quietly building a live provider alongside would make an A/B compare
  // two different organisms while claiming to compare two gains.
  if (tapeFile || kind === "tape") {
    if (!tapeFile) throw new Error("--provider tape needs --tape <file>");
    return makeTapeProvider(parseTape(readFileSync(tapeFile, "utf8")));
  }
  if (kind === "sliders") return makeSliderProvider({ seed });
  if (kind === "camera") return cameraOverSimulation(seed, { bare: argv.includes("--bare") });
  return makeMoldProvider({ seed, preset: flag("preset", "forage") });
}

/** The camera pipeline pointed at a simulated culture. The demo and the test rig. */
function cameraOverSimulation(seed, sourceOptions = {}) {
  const mold = makeMoldProvider({ seed, preset: flag("preset", "forage") });
  const source = makeSimulatedFrameSource(mold, {
    ticksPerFrame: num("ticksPerFrame", 6),
    ...sourceOptions,
  });
  const camera = makeCameraProvider(source, {
    dish: dishForSimulation(mold, source.config),
    qualityFrames: num("qualityFrames", 6),
  });
  camera.mold = mold;
  return camera;
}

function controls() {
  return {
    candidateCount: num("candidates", 8),
    gain: num("gain", 3),
    temperature: num("temperature", 1),
    mode: flag("mode", "weighted"),
    assignment: flag("assignment", "persistent"),
    moldSteps: num("moldSteps", 30),
    separation: num("separation", 0.2),
    maxAttempts: num("maxAttempts", 40),
  };
}

/* ------------------------------------------------------------------ */

/**
 * Is the ring fair, and how wide is the spread the normaliser has to cope with?
 *
 * Fairness is the load-bearing question. If one channel leads because of where
 * it sits rather than what the organism did, the piece is a fixed bias with a
 * biological alibi, so this reports the per-channel time-average across
 * independent seeds and the spread of those averages.
 */
async function channels() {
  const READS = num("reads", 60);
  const TICKS = num("moldSteps", 30);
  const seeds = [4242, 77, 20260811, 31337, 909];

  console.log(`\n=== channel fairness: ${seeds.length} seeds x ${READS} reads x ${TICKS} ticks ===\n`);
  const perChannel = Array.from({ length: 8 }, () => []);
  const spreads = [];
  const leaderCounts = new Array(8).fill(0);

  for (const seed of seeds) {
    const p = makeMoldProvider({ seed, preset: flag("preset", "forage") });
    const totals = new Array(8).fill(0);
    for (let i = 0; i < READS; i += 1) {
      p.advance(TICKS);
      const row = p.readSignals(8).map((s) => s.raw);
      for (let c = 0; c < 8; c += 1) totals[c] += row[c];
      spreads.push(Math.max(...row) - Math.min(...row));
      leaderCounts[row.indexOf(Math.max(...row))] += 1;
    }
    for (let c = 0; c < 8; c += 1) perChannel[c].push(totals[c] / READS);
    process.stdout.write(`  seed ${String(seed).padStart(9)}  ` +
      totals.map((t) => (t / READS).toFixed(1).padStart(6)).join("") + "\n");
  }

  const means = perChannel.map((v) => v.reduce((a, b) => a + b, 0) / v.length);
  const grand = means.reduce((a, b) => a + b, 0) / means.length;
  const betweenChannel = Math.sqrt(means.reduce((a, b) => a + (b - grand) ** 2, 0) / means.length);
  const withinChannel =
    perChannel.reduce((acc, v) => {
      const m = v.reduce((a, b) => a + b, 0) / v.length;
      return acc + Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length);
    }, 0) / 8;

  console.log("\n  channel mean " + means.map((m) => m.toFixed(1).padStart(6)).join(""));
  console.log("  led a read   " + leaderCounts.map((n) =>
    `${((n / (seeds.length * READS)) * 100).toFixed(0)}%`.padStart(6)).join(""));
  console.log(`\n  sd between channels ${betweenChannel.toFixed(2)}   sd within a channel across seeds ${withinChannel.toFixed(2)}`);
  console.log(betweenChannel < withinChannel
    ? "  -> ring is fair: position explains less than seed does."
    : "  -> WARNING: position explains more than seed. Geometry is picking the words.");

  spreads.sort((a, b) => a - b);
  const q = (p) => spreads[Math.min(spreads.length - 1, Math.floor(p * spreads.length))];
  console.log(`\n  per-read spread (max-min flux): p05 ${q(0.05).toFixed(1)}  p25 ${q(0.25).toFixed(1)}` +
    `  p50 ${q(0.5).toFixed(1)}  p75 ${q(0.75).toFixed(1)}  p95 ${q(0.95).toFixed(1)}`);
  console.log(`  normaliser in use: deadband ${DEFAULT_NORMALIZE.deadband}, ` +
    `full confidence at ${DEFAULT_NORMALIZE.activeSpread}, sd floor ${DEFAULT_NORMALIZE.spreadFloor}`);
  const dead = spreads.filter((s) => s <= DEFAULT_NORMALIZE.deadband).length / spreads.length;
  const full = spreads.filter((s) => s >= DEFAULT_NORMALIZE.activeSpread).length / spreads.length;
  console.log(`  -> ${(dead * 100).toFixed(0)}% of reads are silenced, ${(full * 100).toFixed(0)}% carry full gain.`);
}

/* ------------------------------------------------------------------ */

async function runSection() {
  const tokens = num("tokens", 60);
  const run = new LivingWeightsRun({
    adapter: adapter(),
    provider: provider(),
    prompt: PROMPT,
    seed: num("seed", 20260811),
    controls: controls(),
  });
  await run.run(tokens);

  const d = run.divergence;
  console.log(`\n${run.text}\n`);
  console.log(`  ${d.diverged}/${d.steps} tokens differ from what the model alone would have taken ` +
    `(${(d.fraction * 100).toFixed(0)}%)`);

  const out = flag("out", null);
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, serializeRun(run.header, run.records));
    console.log(`  log -> ${out}`);
  }
}

/* ------------------------------------------------------------------ */

/** The acceptance criterion, run as an experiment rather than asserted. */
async function ab() {
  const tokens = num("tokens", 60);
  const gain = num("gain", 3);
  const seed = num("seed", 20260811);

  const runs = {};
  for (const [label, g] of [["gain 0", 0], [`gain ${gain}`, gain]]) {
    const run = new LivingWeightsRun({
      adapter: adapter(),
      provider: provider(),
      prompt: PROMPT,
      seed,
      controls: { ...controls(), gain: g },
    });
    await run.run(tokens);
    runs[label] = run;
  }

  console.log(`\n=== same seed (${seed}), same organism, one control turned ===\n`);
  for (const [label, run] of Object.entries(runs)) {
    console.log(`--- ${label} ---`);
    console.log(run.text.trim().replace(/^/gm, "    "));
    console.log("");
  }

  const a = runs["gain 0"].records;
  const b = runs[`gain ${gain}`].records;
  let first = null;
  let differ = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    if (a[i].chosenToken !== b[i].chosenToken) {
      differ += 1;
      if (first === null) first = i;
    }
  }
  // These two numbers mean different things and only one of them is evidence.
  // Once a single token is overridden the texts have forked and everything
  // downstream differs for context reasons, so the token-difference count is
  // not a count of interventions.
  const overrides = runs[`gain ${gain}`].divergence.diverged;
  console.log(`  first override at token ${first ?? "never"}.`);
  console.log(`  ${overrides}/${b.length} decisions went against the model's own pick.`);
  console.log(`  ${differ}/${Math.min(a.length, b.length)} tokens end up different, most of them` +
    ` because the text had already forked, not because the culture chose them.`);
}

/* ------------------------------------------------------------------ */

/** Gain is the dial the piece is played on. This is what it does. */
async function sweep() {
  const tokens = num("tokens", 80);
  const seed = num("seed", 20260811);
  console.log(`\n=== influence gain sweep (${tokens} tokens, seed ${seed}) ===\n`);
  console.log("  gain   overridden   text");
  for (const gain of [0, 0.5, 1, 2, 3, 5, 8, 15]) {
    const run = new LivingWeightsRun({
      adapter: adapter(),
      provider: provider(),
      prompt: PROMPT,
      seed,
      controls: { ...controls(), gain },
    });
    await run.run(tokens);
    const d = run.divergence;
    const preview = run.text.replace(/\s+/g, " ").slice(0, 76);
    console.log(`  ${String(gain).padStart(4)}   ${`${(d.fraction * 100).toFixed(0)}%`.padStart(9)}   ${preview}`);
  }
}

/* ------------------------------------------------------------------ */

async function replay() {
  const file = positional[0] ?? flag("file", null);
  if (!file) throw new Error("usage: node tools/weights.mjs replay <run.jsonl>");
  const parsed = parseRun(readFileSync(file, "utf8"));
  console.log(`\n=== ${file} — ${parsed.records.length} decisions ===\n`);

  const math = verifyRun(parsed);
  console.log(`  1. every decision follows from its own logged inputs: ${math.ok ? "OK" : "FAILED"}`);
  for (const d of math.discrepancies.slice(0, 8)) {
    console.log(`       step ${d.step} ${d.field}: logged ${d.logged} recomputed ${d.recomputed}`);
  }

  const chain = verifyChain(parsed, adapter());
  console.log(`  2. the text chain is consistent: ${chain.length === 0 ? "OK" : `FAILED (${chain.length})`}`);
  for (const d of chain.slice(0, 4)) console.log(`       step ${d.step}: ${d.logged} vs ${d.recomputed}`);

  const again = await rerun(parsed, () => ({ adapter: adapter(), provider: provider() }));
  console.log(`  3. the seed alone reproduces it: ${again.matched}/${again.total} tokens` +
    (again.firstMismatch === null ? " — OK" : `, first divergence at ${again.firstMismatch}`));

  process.exitCode = math.ok && chain.length === 0 && again.firstMismatch === null ? 0 : 1;
}

/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */

/**
 * Does looking at the plate recover what the plate is doing?
 *
 * There is no ground truth for a real dish, so this asks the question where
 * there is one: the simulation knows its own per-channel flux exactly, so
 * rendering it to frames, reading those frames back through the whole vision
 * pipeline, and correlating the two is a direct test of the arithmetic.
 *
 * The first version of that arithmetic scored 0.04 here while passing every
 * other check in the repo, which is the entire reason this section exists.
 */
async function recover() {
  const READS = num("reads", 12);
  const FRAMES = num("qualityFrames", 8);

  const rank = (v) => {
    const order = v.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]);
    const out = new Array(v.length);
    order.forEach(([, i], k) => { out[i] = k; });
    return out;
  };
  const spearman = (a, b) => {
    const ra = rank(a), rb = rank(b), m = (a.length - 1) / 2;
    let acc = 0, da = 0, db = 0;
    for (let i = 0; i < a.length; i += 1) {
      acc += (ra[i] - m) * (rb[i] - m);
      da += (ra[i] - m) ** 2;
      db += (rb[i] - m) ** 2;
    }
    return acc / Math.sqrt(da * db);
  };

  console.log(`\n=== can the camera see what the culture is doing? (${READS} reads) ===\n`);
  console.log("  rig                  spearman   leader   quality   faults");
  for (const [label, options] of [
    ["clean", {}],
    ["grainy but steady", { grain: 10 }],
    ["someone walks past", { benchNoise: 8, disturbAfterFrames: 40 }],
    ["light ramps mid-run", { exposureDriftPerFrame: 0.006, disturbAfterFrames: 40 }],
    ["defocused", { blurPasses: 2 }],
  ]) {
    const camera = cameraOverSimulation(num("seed", 4242), options);
    camera.advance(20);
    camera.readSignals(8);
    camera.mold.readSignals(8);

    let s = 0, q = 0, hits = 0;
    for (let i = 0; i < READS; i += 1) {
      camera.advance(FRAMES);
      const seen = camera.readSignals(8);
      const truth = camera.mold.readSignals(8).map((x) => x.raw);
      const raw = seen.map((x) => x.raw);
      s += spearman(raw, truth);
      q += seen[0].quality;
      if (raw.indexOf(Math.max(...raw)) === truth.indexOf(Math.max(...truth))) hits += 1;
    }
    // A correlation computed on a refused reading is meaningless: quality zero
    // means every channel came back zero, and ranking a constant vector
    // produces whatever the sort happened to do. Say refused, not 0.59.
    const meanQuality = q / READS;
    const score = meanQuality < 0.05 ? "REFUSED" : (s / READS).toFixed(2);
    console.log(`  ${label.padEnd(20)} ${score.padStart(8)} ` +
      `${(meanQuality < 0.05 ? "-" : `${((hits / READS) * 100).toFixed(0)}%`).padStart(8)} ` +
      `${meanQuality.toFixed(2).padStart(9)}   ` +
      (camera.lastFaults.map((f) => f.reason).join("; ") || "none"));
  }
  console.log("\n  A clean rig should track the truth; the other three should be REFUSED,");
  console.log("  not merely score worse. A confident wrong answer is the failure mode.");
}

/* ------------------------------------------------------------------ */

/** Record what a provider says, so a run against it can be replayed forever. */
async function tape() {
  const reads = num("reads", 60);
  const steps = num("moldSteps", 30);
  const inner = provider();
  const recorder = recordTape(inner);
  for (let i = 0; i < reads; i += 1) {
    recorder.advance(steps);
    // Camera diagnostics ride along on the tape so `calibrate` can set the
    // focus rail from what this rig actually produced, rather than from a
    // constant that means nothing outside the bench it was written on.
    if (typeof inner.lastFocus === "number") {
      recorder.note({
        focus: inner.lastFocus,
        sessionDrift: inner.lastSessionDrift,
        faults: inner.lastFaults.map((f) => f.reason),
      });
    }
    recorder.readSignals(8);
  }

  const summary = summarizeTape(recorder.tape);
  console.log(`\n=== ${recorder.tape.header.providerId} — ${summary.reads} reads ===\n`);
  console.log("  channel mean " + summary.channelMeans.map((m) => m.toFixed(3).padStart(9)).join(""));
  console.log("  channel sd   " + summary.channelSds.map((m) => m.toFixed(3).padStart(9)).join(""));
  console.log(`\n  between channels ${summary.betweenChannel.toFixed(4)}   within a channel ${summary.withinChannel.toFixed(4)}`);
  console.log(summary.betweenChannel < summary.withinChannel
    ? "  -> fair: where a channel sits explains less than what the organism did."
    : "  -> WARNING: position explains more than time. The rig is choosing the words.");
  console.log(`  spread p05 ${summary.spread.p05.toFixed(4)}  p50 ${summary.spread.p50.toFixed(4)}  p95 ${summary.spread.p95.toFixed(4)}`);
  console.log(`  mean quality ${summary.meanQuality.toFixed(2)}`);

  const out = flag("out", null);
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, serializeTape(recorder.tape));
    console.log(`\n  tape -> ${out}`);
  }
}

/* ------------------------------------------------------------------ */

/**
 * Derive the constants from recordings instead of inheriting them.
 *
 * Nothing calibrated on the lattice transfers. There `raw` was landings per
 * tick, in the tens; here it is a dimensionless relative change three orders
 * of magnitude smaller. Every threshold downstream has to be re-derived
 * against the actual rig, and this is where that happens.
 */
async function calibrate() {
  const quietFile = flag("quiet", positional[0] ?? null);
  if (!quietFile) {
    throw new Error("usage: node tools/weights.mjs calibrate --quiet <tape> [--active <tape>]");
  }
  const quiet = parseTape(readFileSync(quietFile, "utf8"));
  const activeFile = flag("active", null);
  const active = activeFile ? parseTape(readFileSync(activeFile, "utf8")) : null;
  const quietSummary = summarizeTape(quiet);

  console.log(`\n=== calibration from ${quietFile} (${quietSummary.reads} reads) ===\n`);

  // A quiet tape must actually be quiet. Offsets measured while the culture is
  // working subtract the culture, and the piece then runs beautifully and
  // means nothing — so this refuses rather than obliges.
  //
  // Judged on pattern inertia, not on magnitude and not on relative variation.
  // A bare plate's residuals are white noise and score near zero; a culture
  // scores high because whatever it was doing a moment ago it is still mostly
  // doing. Measured on this rig: -0.06 bare against 0.87 live.
  const INERTIA_LIMIT = 0.35;
  console.log(`  pattern inertia ${quietSummary.inertia.toFixed(3)} ` +
    `(a bare rig scores near 0; something alive scores well above ${INERTIA_LIMIT})`);
  if (quietSummary.inertia > INERTIA_LIMIT) {
    console.log("\n  REFUSED. Something in this recording has spatial memory, so it is not a");
    console.log("  quiet rig. Record the offsets on a bare plate, or on a dormant culture:");
    console.log("  an offset measured with the organism working subtracts the organism.");
    process.exitCode = 1;
    return;
  }
  if (active) {
    const activeSummary = summarizeTape(active);
    if (activeSummary.grandMean > 0 && quietSummary.grandMean > activeSummary.grandMean * 0.25) {
      console.log("\n  REFUSED. The quiet tape reads within a factor of four of the live one.");
      console.log(`  quiet ${quietSummary.grandMean.toExponential(2)} against live ` +
        `${activeSummary.grandMean.toExponential(2)}. One of the two is mislabelled.`);
      process.exitCode = 1;
      return;
    }
  }

  const focusSamples = quiet.reads
    .map((r) => (typeof r.notes?.focus === "number" ? r.notes.focus : null))
    .filter((v) => v !== null);

  const derived = deriveCalibration(
    quiet.reads.map((r) => r.raw),
    (active ?? quiet).reads.map((r) => r.raw),
    focusSamples,
  );

  console.log("  offset " + derived.calibration.offset.map((v) => v.toFixed(4).padStart(9)).join(""));
  console.log("  scale  " + derived.calibration.scale.map((v) => v.toFixed(4).padStart(9)).join(""));
  console.log("\n  suggested NormalizeOptions:");
  console.log(`    spreadFloor   ${derived.suggestedNormalize.spreadFloor.toExponential(3)}`);
  console.log(`    deadband      ${derived.suggestedNormalize.deadband.toExponential(3)}`);
  console.log(`    activeSpread  ${derived.suggestedNormalize.activeSpread.toExponential(3)}`);
  console.log(derived.suggestedFocus
    ? `    focus band    good ${derived.suggestedFocus.good.toFixed(0)}, ceiling ${derived.suggestedFocus.ceiling.toFixed(0)}`
    : "    focus band    NOT DERIVED — this tape carried no focus samples, so the\n" +
      "                  default is still a number from another bench. Record a\n" +
      "                  camera tape before trusting the focus rail.");
  if (!active) {
    console.log("\n  No --active tape, so scale and activeSpread were derived from the quiet");
    console.log("  recording itself. They describe silence. Record a live tape.");
  }
}

/* ------------------------------------------------------------------ */

/**
 * Alive, or merely changing?
 *
 * The distinction the whole camera provider turns on. Frame-to-frame change is
 * produced by a growing culture, a dead tube under a flickering lamp, sensor
 * grain and a compression artefact alike. The plasmodium's peristaltic
 * contraction, at 131 +/- 43 s (Alim et al. 2013, PNAS 110(33):13306), is
 * produced by none of those, so restricting the reading to that band is a
 * matched filter for an organism that is still working.
 *
 * This runs the same culture with its rhythm on and off and reports what each
 * estimator makes of the difference.
 */
async function pulse() {
  const FRAME_MS = num("frameMs", 6000);
  const WINDOW = num("windowSeconds", 512);
  const READS = num("reads", 8);
  const PER_READ = num("moldSteps", 10);

  const rank = (v) => {
    const order = v.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]);
    const out = new Array(v.length);
    order.forEach(([, i], k) => { out[i] = k; });
    return out;
  };
  const spearman = (a, b) => {
    const ra = rank(a), rb = rank(b), m = (a.length - 1) / 2;
    let acc = 0, da = 0, db = 0;
    for (let i = 0; i < a.length; i += 1) {
      acc += (ra[i] - m) * (rb[i] - m);
      da += (ra[i] - m) ** 2;
      db += (rb[i] - m) ** 2;
    }
    return da === 0 || db === 0 ? 0 : acc / Math.sqrt(da * db);
  };

  const measure = (estimator, options) => {
    const mold = makeMoldProvider({ seed: num("seed", 4242) });
    const source = makeSimulatedFrameSource(mold, {
      frameIntervalMs: FRAME_MS,
      ticksPerFrame: 6,
      ...options,
    });
    const camera = makeCameraProvider(source, {
      dish: dishForSimulation(mold, source.config),
      estimator,
      windowSeconds: WINDOW,
      qualityFrames: PER_READ,
    });
    camera.advance(Math.round(WINDOW / (FRAME_MS / 1000)) + 12);
    camera.readSignals(8);
    mold.readSignals(8);

    let level = 0, s = 0;
    for (let i = 0; i < READS; i += 1) {
      camera.advance(PER_READ);
      const raw = camera.readSignals(8).map((x) => x.raw);
      const truth = mold.readSignals(8).map((x) => x.raw);
      level += raw.reduce((a, b) => a + b, 0) / 8 / READS;
      s += spearman(raw, truth) / READS;
    }
    return { level, spearman: s };
  };

  console.log(`\n=== alive, or merely changing? (${WINDOW}s window, ${FRAME_MS / 1000}s frames) ===\n`);
  console.log("  estimator     rig                    mean raw   vs flux");
  const seen = {};
  for (const estimator of ["band-power", "broadband"]) {
    for (const [label, options] of [
      ["pulsing culture", {}],
      ["same culture, no rhythm", { contractionAmplitude: 0 }],
      ["bare plate, grain", { bare: true, grain: 8 }],
    ]) {
      const r = measure(estimator, options);
      seen[`${estimator}|${label}`] = r.level;
      console.log(`  ${estimator.padEnd(13)} ${label.padEnd(23)} ${r.level.toExponential(2).padStart(9)} ` +
        `${r.spearman.toFixed(2).padStart(9)}`);
    }
  }

  console.log("\n  telling a living region from a still one:");
  for (const estimator of ["band-power", "broadband"]) {
    const on = seen[`${estimator}|pulsing culture`];
    const off = seen[`${estimator}|same culture, no rhythm`];
    console.log(`    ${estimator.padEnd(13)} ${(on / Math.max(off, 1e-12)).toFixed(1)}x`);
  }
  console.log("\n  Broadband scores slightly better against FLUX, and should: flux is agent");
  console.log("  movement and broadband change is a direct image of it. But a real plate");
  console.log("  offers no ground-truth flux, and a sclerotium, a dead tube and a JPEG");
  console.log("  artefact all produce change. Only the band asks whether it is still alive.");
}

const sections = { channels, run: runSection, ab, sweep, replay, recover, tape, calibrate, pulse };
const chosen = sections[section];
if (!chosen) {
  console.error(`unknown section "${section}". try: ${Object.keys(sections).join(", ")}`);
  process.exit(2);
}
await chosen();
