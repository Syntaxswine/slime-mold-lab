import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { makeNgramAdapter, tokenize } from "../lib/living-weights/adapters/ngram.ts";
import {
  buildRequest,
  DEFAULT_LOCAL_HTTP_CONFIG,
  parseResponse,
} from "../lib/living-weights/adapters/local-http.ts";
import { LivingWeightsRun } from "../lib/living-weights/generator.ts";
import { parseRun, serializeRun, toCsv } from "../lib/living-weights/log.ts";
import {
  channelSites,
  DEFAULT_MOLD_CONFIG,
  makeMoldProvider,
} from "../lib/living-weights/providers/mold.ts";
import { makeSliderProvider } from "../lib/living-weights/providers/sliders.ts";
import { rerun, verifyChain, verifyRun } from "../lib/living-weights/replay.ts";
import {
  assignChannels,
  combine,
  DEFAULT_NORMALIZE,
  normalizeSignals,
  softmax,
} from "../lib/living-weights/weights.ts";
import { GRID_H, GRID_W } from "../lib/physarum-engine.ts";

const corpus = readFileSync(new URL("../public/corpora/notebook.txt", import.meta.url), "utf8");
const adapter = () => makeNgramAdapter(corpus, { corpusId: "notebook" });

/** A provider that says exactly what a test tells it to. */
function fixedProvider(raw, quality = 1) {
  let clock = 0;
  return {
    id: "fixed",
    config: { raw },
    channelCount: raw.length,
    advance(steps) {
      clock += steps;
      return clock;
    },
    readSignals(count) {
      return raw.slice(0, count).map((v, channel) => ({
        channel,
        value: 0,
        raw: v,
        timestamp: clock,
        quality,
      }));
    },
    reset() {
      clock = 0;
    },
  };
}

/* --- the weighting model ------------------------------------------- */

test("gain 0 reproduces the language model's distribution exactly", () => {
  const logits = [-1, -2.5, -0.3, -7, -4];
  const score = [4, -3, 1.5, 9, -8];
  const combined = combine(logits, score, 0, 1, 1);
  assert.deepEqual(combined.adjustedProb, combined.baselineProb);
  assert.deepEqual(combined.adjustedLogit, logits);
  assert.equal(combined.effectiveGain, 0);
});

test("the organism cannot change the text at gain 0, whatever it is doing", async () => {
  const texts = [];
  for (const provider of [
    fixedProvider([40, 0, 0, 0, 0, 0, 0, 0]),
    fixedProvider([0, 0, 0, 0, 0, 0, 0, 40]),
    makeSliderProvider({ seed: 5 }),
  ]) {
    const run = new LivingWeightsRun({
      adapter: adapter(),
      provider,
      prompt: "The culture",
      seed: 99,
      controls: { gain: 0, moldSteps: 5 },
      now: () => 0,
    });
    await run.run(25);
    texts.push(run.text);
    assert.equal(run.divergence.diverged, 0);
  }
  assert.equal(texts[0], texts[1]);
  assert.equal(texts[1], texts[2]);
});

test("gain moves probability mass monotonically", () => {
  // Divergence alone is the wrong monotonicity to assert: with a steady signal
  // the choice saturates once the leader is decided, so gain 3 and gain 15 can
  // override the same 20% of tokens while doing very different things to the
  // distribution. Mass moved is the quantity that actually tracks the dial.
  const logits = [-0.2, -1.1, -2.4, -3.9, -4.2, -5.0, -6.1, -7.3];
  const score = [-0.9, 0.4, -1.2, 2.6, -0.3, 0.1, -0.5, -0.2];
  let previous = -1;
  for (const gain of [0, 0.5, 1, 2, 4, 8, 16]) {
    const c = combine(logits, score, gain, 1, 1);
    const moved = 0.5 * c.adjustedProb.reduce((a, p, i) => a + Math.abs(p - c.baselineProb[i]), 0);
    assert.ok(moved > previous, `gain ${gain} moved ${moved}, no more than the step below`);
    previous = moved;
  }
  assert.equal(0.5 * combine(logits, score, 0, 1, 1).adjustedProb
    .reduce((a, p, i) => a + Math.abs(p - softmax(logits, 1)[i]), 0), 0);
});

test("raising the gain visibly changes the text", async () => {
  const seen = new Map();
  for (const gain of [0, 3, 15]) {
    const run = new LivingWeightsRun({
      adapter: adapter(),
      // A steady signal saturates: past the point where the leader is decided,
      // more gain changes the distribution but not the pick. A drifting signal
      // is what shows the dial doing something to the words.
      provider: makeSliderProvider({ seed: 5 }),
      prompt: "The culture",
      seed: 99,
      controls: { gain, moldSteps: 5 },
      now: () => 0,
    });
    await run.run(30);
    seen.set(gain, { text: run.text, diverged: run.divergence.fraction });
  }
  assert.equal(seen.get(0).diverged, 0, "gain 0 must never override the model");
  assert.ok(seen.get(3).diverged > 0, "gain 3 overrode nothing");
  assert.ok(seen.get(15).diverged > 0, "gain 15 overrode nothing");
  assert.equal(new Set([...seen.values()].map((v) => v.text)).size, 3, "two gains produced the same text");
});

test("a silent organism is silent, not deafening", () => {
  // The failure this pins: a plain z-score divides by a near-zero spread when
  // every channel reads nothing, and injects enormous scores from noise.
  const flat = normalizeSignals(
    Array.from({ length: 8 }, (_, channel) => ({
      channel,
      value: 0,
      raw: 1e-7 * channel,
      timestamp: 0,
      quality: 1,
    })),
    DEFAULT_NORMALIZE,
  );
  assert.equal(flat.confidence, 0);
  assert.ok(Math.max(...flat.score.map(Math.abs)) < 1e-6, `scores blew up: ${flat.score}`);

  const combined = combine([-1, -2, -3, -4, -5, -6, -7, -8], flat.score, 50, flat.confidence, 1);
  assert.deepEqual(combined.adjustedProb, combined.baselineProb);
});

test("a channel the provider does not believe is pulled toward no-opinion", () => {
  const raw = [30, 0, 0, 0, 0, 0, 0, 0];
  const trusted = normalizeSignals(
    raw.map((v, channel) => ({ channel, value: 0, raw: v, timestamp: 0, quality: 1 })),
  );
  const doubted = normalizeSignals(
    raw.map((v, channel) => ({ channel, value: 0, raw: v, timestamp: 0, quality: channel === 0 ? 0 : 1 })),
  );
  assert.ok(trusted.score[0] > 2, `expected a strong score, got ${trusted.score[0]}`);
  assert.equal(doubted.score[0], 0);
});

test("logit space lifts a candidate the model had all but ruled out", () => {
  const logits = [0, -7];
  const before = softmax(logits, 1);
  assert.ok(before[1] < 0.002, `fixture is wrong: ${before[1]}`);
  const after = combine(logits, [-1, 1], 5, 1, 1).adjustedProb;
  assert.ok(after[1] > before[1] * 100, `no meaningful lift: ${before[1]} -> ${after[1]}`);
});

/* --- candidate assignment ------------------------------------------ */

test("persistent assignment is the identity; shuffled is a permutation of it", () => {
  const candidates = Array.from({ length: 8 }, (_, i) => ({ token: `t${i}`, logit: -i }));
  const random = (() => {
    let i = 0;
    const draws = [0.9, 0.1, 0.8, 0.2, 0.7, 0.3, 0.6];
    return () => draws[i++ % draws.length];
  })();
  const persistent = assignChannels(candidates, "persistent", 8, random);
  assert.deepEqual(persistent, [0, 1, 2, 3, 4, 5, 6, 7]);

  const shuffled = assignChannels(candidates, "shuffled", 8, random);
  assert.deepEqual([...shuffled].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.notDeepEqual(shuffled, persistent);
});

test("switching assignment mode does not reroute the sampler", async () => {
  // The engine's own seed defect is exactly this shape: the UI draws from the
  // physics stream, so touching a control forks the trajectory.
  const texts = [];
  for (const assignment of ["persistent", "shuffled"]) {
    const run = new LivingWeightsRun({
      adapter: adapter(),
      provider: fixedProvider([5, 5, 5, 5, 5, 5, 5, 5]),
      prompt: "The culture",
      seed: 4242,
      controls: { gain: 0, assignment, moldSteps: 5 },
      now: () => 0,
    });
    await run.run(20);
    texts.push(run.text);
  }
  assert.equal(texts[0], texts[1]);
});

/* --- the language model adapter ------------------------------------ */

test("the n-gram adapter offers exactly N ranked candidates, deterministically", async () => {
  const a = adapter();
  const b = adapter();
  const first = await a.candidates("The culture was", 8);
  const second = await b.candidates("The culture was", 8);
  assert.equal(first.length, 8);
  assert.deepEqual(first, second);
  for (let i = 1; i < first.length; i += 1) {
    assert.ok(first[i - 1].logit >= first[i].logit, "candidates must be ranked");
  }
});

test("every step offers real competition, not a single continuation", async () => {
  // A trigram context in a corpus this small is usually unique. If the adapter
  // returned only the longest matching order the model would replay the corpus
  // and the organism would have nothing to choose between, so the whole piece
  // rests on the backoff mixture being present.
  const a = adapter();
  let thin = 0;
  const probes = ["The culture", "The culture was", "It solves the", "We placed", "Flow is the"];
  for (const probe of probes) {
    const candidates = await a.candidates(probe, 8);
    const probs = softmax(candidates.map((c) => c.logit), 1);
    if (probs[1] < 0.02) thin += 1;
  }
  assert.equal(thin, 0, "some contexts offered no real second choice");
});

test("an unseen context still produces candidates instead of stopping the run", async () => {
  const candidates = await adapter().candidates("xyzzy plugh frotz", 8);
  assert.equal(candidates.length, 8);
});

test("sentence boundaries reset the context rather than conditioning across them", async () => {
  const a = adapter();
  const fresh = await a.candidates("", 8);
  const afterNewline = await a.candidates("Some earlier sentence.\n", 8);
  assert.deepEqual(afterNewline, fresh);
});

/* --- the local-model adapter (no server; contract only) ------------- */

test("the local-model request does not ask for a pre-truncated distribution", () => {
  // llama.cpp defaults top_k to 40. Leaving it would silently cap the
  // candidate list and quietly make "the model's own distribution" false.
  const llama = buildRequest(DEFAULT_LOCAL_HTTP_CONFIG, "hello", 8);
  assert.equal(llama.top_k, 0);
  assert.equal(llama.top_p, 1);
  assert.equal(llama.temperature, 1);
  assert.equal(llama.n_probs, 8);

  const openai = buildRequest({ ...DEFAULT_LOCAL_HTTP_CONFIG, shape: "openai" }, "hello", 8);
  assert.equal(openai.logprobs, 8);
  assert.equal(openai.max_tokens, 1);
});

test("both server response shapes parse to ranked candidates", () => {
  const llama = parseResponse(
    DEFAULT_LOCAL_HTTP_CONFIG,
    { completion_probabilities: [{ probs: [{ tok_str: " the", prob: 0.5 }, { tok_str: " a", prob: 0.25 }] }] },
    8,
  );
  assert.equal(llama[0].token, " the");
  assert.ok(Math.abs(llama[0].logit - Math.log(0.5)) < 1e-12);

  const openai = parseResponse(
    { ...DEFAULT_LOCAL_HTTP_CONFIG, shape: "openai" },
    { choices: [{ logprobs: { top_logprobs: [{ " a": -1.5, " the": -0.4 }] } }] },
    8,
  );
  assert.equal(openai[0].token, " the");
  assert.equal(openai[0].logit, -0.4);
});

test("a zero-probability candidate stays impossible instead of being invented", () => {
  const parsed = parseResponse(
    DEFAULT_LOCAL_HTTP_CONFIG,
    { completion_probabilities: [{ probs: [{ tok_str: "a", prob: 0.9 }, { tok_str: "b", prob: 0 }] }] },
    8,
  );
  assert.equal(parsed[1].logit, -Infinity);
  assert.equal(softmax(parsed.map((c) => c.logit), 1)[1], 0);
});

/* --- the mold provider --------------------------------------------- */

test("the channel ring is equidistant and non-overlapping", () => {
  const sites = channelSites(DEFAULT_MOLD_CONFIG);
  assert.equal(sites.length, 8);

  const wrapped = (a, b, n) => {
    const d = Math.abs(a - b);
    return Math.min(d, n - d);
  };

  // Equidistant from the inoculum, or geometry decides which words win before
  // the culture has said anything.
  for (const site of sites) {
    const dx = wrapped(site.x, DEFAULT_MOLD_CONFIG.centerX, GRID_W);
    const dy = wrapped(site.y, DEFAULT_MOLD_CONFIG.centerY, GRID_H);
    assert.ok(
      Math.abs(Math.hypot(dx, dy) - DEFAULT_MOLD_CONFIG.ringRadius) <= 1,
      `a channel is off the ring: ${JSON.stringify(site)}`,
    );
  }

  // Detection discs must not overlap: a landing is credited to the first
  // matching channel, so overlap would quietly hand shared ground to whichever
  // channel has the lower index.
  let closest = Infinity;
  for (let i = 0; i < sites.length; i += 1) {
    for (let j = i + 1; j < sites.length; j += 1) {
      const dx = wrapped(sites[i].x, sites[j].x, GRID_W);
      const dy = wrapped(sites[i].y, sites[j].y, GRID_H);
      closest = Math.min(closest, Math.hypot(dx, dy));
    }
  }
  assert.ok(
    closest > 2.5 * DEFAULT_MOLD_CONFIG.detectRadius,
    `channels are too close to separate: ${closest.toFixed(1)} apart, radius ${DEFAULT_MOLD_CONFIG.detectRadius}`,
  );

  // The ring must fit inside the torus without folding: if the wrapped
  // distance across the lattice were shorter than the ring spacing, opposite
  // channels would be neighbours and the ring order would be a fiction.
  assert.ok(
    GRID_H - 2 * DEFAULT_MOLD_CONFIG.ringRadius > closest,
    "the ring wraps into itself across the short axis",
  );
});

test("reading a channel consumes its integration window", () => {
  const provider = makeMoldProvider({ seed: 1 });
  provider.advance(20);
  const first = provider.readSignals(8);
  assert.ok(first.every((s) => s.quality > 0));
  const second = provider.readSignals(8);
  assert.ok(second.every((s) => s.quality === 0 && s.raw === 0), "stale flux was served twice");
});

test("the mold provider says different things on different channels", () => {
  const provider = makeMoldProvider({ seed: 4242 });
  provider.advance(60);
  const raw = provider.readSignals(8).map((s) => s.raw);
  const mean = raw.reduce((a, b) => a + b, 0) / raw.length;
  const sd = Math.sqrt(raw.reduce((a, b) => a + (b - mean) ** 2, 0) / raw.length);
  // Against the counting noise of a Poisson process at this rate. A provider
  // reporting nothing but body background scores about 1. Measured minimum
  // across five seeds at this protocol is 8.8.
  const noise = Math.sqrt(Math.max(mean, 1e-9) / 60);
  assert.ok(sd / noise > 4, `channels are not discriminating: sd/noise ${(sd / noise).toFixed(2)}`);
});

test("an unwarmed culture is refused rather than believed", () => {
  // The reason the warmup exists, stated as a test so removing it fails here
  // rather than quietly making the first sentence of every run noise-driven.
  const cold = makeMoldProvider({ seed: 4242, warmupTicks: 0 });
  cold.advance(60);
  const raw = cold.readSignals(8).map((s) => s.raw);
  const mean = raw.reduce((a, b) => a + b, 0) / raw.length;
  const sd = Math.sqrt(raw.reduce((a, b) => a + (b - mean) ** 2, 0) / raw.length);
  assert.ok(
    sd / Math.sqrt(Math.max(mean, 1e-9) / 60) < 3,
    "a cold culture now discriminates, so the warmup measurement is stale — re-run tools/weights.mjs channels",
  );
});

/* --- provenance, replay, and the log -------------------------------- */

test("a run log verifies three ways: math, text chain, and reproduction from seed", async () => {
  const run = new LivingWeightsRun({
    adapter: adapter(),
    provider: makeSliderProvider({ seed: 11 }),
    prompt: "The culture",
    seed: 20260811,
    controls: { gain: 4, moldSteps: 10 },
    now: () => 0,
  });
  await run.run(30);

  const parsed = parseRun(serializeRun(run.header, run.records));
  assert.equal(parsed.records.length, 30);

  const math = verifyRun(parsed);
  assert.ok(math.ok, `math check failed: ${JSON.stringify(math.discrepancies.slice(0, 3))}`);
  assert.deepEqual(verifyChain(parsed, adapter()), []);

  const again = await rerun(parsed, () => ({
    adapter: adapter(),
    provider: makeSliderProvider({ seed: 11 }),
  }));
  assert.equal(again.firstMismatch, null);
  assert.equal(again.matched, 30);
  assert.equal(again.text, run.text);
});

test("verification actually refuses a tampered log", async () => {
  const run = new LivingWeightsRun({
    adapter: adapter(),
    provider: makeSliderProvider({ seed: 11 }),
    prompt: "The culture",
    seed: 7,
    controls: { gain: 4, moldSteps: 10 },
    now: () => 0,
  });
  await run.run(12);
  const clean = serializeRun(run.header, run.records);
  assert.ok(verifyRun(parseRun(clean)).ok);

  // A green verifier that green-lights anything is decoration. Move one
  // reading and the recomputed decision must stop matching the logged one.
  const tampered = parseRun(clean);
  tampered.records[5].candidates[3].raw += 25;
  const report = verifyRun(tampered);
  assert.equal(report.ok, false);
  assert.ok(report.discrepancies.some((d) => d.step === 5));
});

test("the log records everything needed to say where the organism bent it", async () => {
  const run = new LivingWeightsRun({
    adapter: adapter(),
    provider: makeSliderProvider({ seed: 3 }),
    prompt: "The culture",
    seed: 5,
    controls: { gain: 6, moldSteps: 10 },
    now: () => 1234,
  });
  await run.run(10);
  const record = run.records[0];
  for (const field of [
    "textBefore", "candidates", "controls", "effectiveGain", "confidence", "spread",
    "uniform", "attempts", "chosenIndex", "chosenToken", "baselineIndex", "baselineToken",
    "providerClock", "wallClockMs",
  ]) {
    assert.ok(field in record, `run log is missing ${field}`);
  }
  for (const field of ["token", "channel", "lmLogit", "lmProb", "raw", "quality", "score", "adjustedLogit", "adjustedProb"]) {
    assert.ok(field in record.candidates[0], `candidate record is missing ${field}`);
  }
  assert.equal(run.header.provider.id, "sliders-null");
  assert.equal(run.header.adapter.id, "ngram-stupid-backoff");

  const csv = toCsv(parseRun(serializeRun(run.header, run.records)));
  assert.equal(csv.trim().split("\n").length, 1 + 10 * 8);
});

test("threshold mode waits for a gap instead of taking the first thing offered", async () => {
  const run = new LivingWeightsRun({
    adapter: adapter(),
    provider: makeSliderProvider({ seed: 2 }),
    prompt: "The culture",
    seed: 8,
    controls: { gain: 4, mode: "threshold", separation: 0.35, moldSteps: 5, maxAttempts: 25 },
    now: () => 0,
  });
  await run.run(15);
  const attempts = run.records.map((r) => r.attempts);
  assert.ok(Math.max(...attempts) > 1, "threshold mode never had to wait");
  for (const record of run.records) {
    if (!record.committed) continue;
    const sorted = [...record.candidates.map((c) => c.adjustedProb)].sort((a, b) => b - a);
    assert.ok(sorted[0] - sorted[1] >= record.controls.separation - 1e-12);
  }
});

test("tokenize keeps punctuation as its own token", () => {
  assert.deepEqual(tokenize("The plate, and the lamp."), ["The", "plate", ",", "and", "the", "lamp", "."]);
});
