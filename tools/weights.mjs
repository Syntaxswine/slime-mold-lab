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
 *
 * Flags: --seed --tokens --gain --mode --assignment --provider --preset
 *        --moldSteps --temperature --corpus --out
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { makeNgramAdapter } from "../lib/living-weights/adapters/ngram.ts";
import { LivingWeightsRun } from "../lib/living-weights/generator.ts";
import { parseRun, serializeRun } from "../lib/living-weights/log.ts";
import { makeMoldProvider } from "../lib/living-weights/providers/mold.ts";
import { makeSliderProvider } from "../lib/living-weights/providers/sliders.ts";
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
  if (kind === "sliders") return makeSliderProvider({ seed });
  return makeMoldProvider({ seed, preset: flag("preset", "forage") });
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

const sections = { channels, run: runSection, ab, sweep, replay };
const chosen = sections[section];
if (!chosen) {
  console.error(`unknown section "${section}". try: ${Object.keys(sections).join(", ")}`);
  process.exit(2);
}
await chosen();
