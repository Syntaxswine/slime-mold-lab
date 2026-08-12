/**
 * Living Weights — the weighting model.
 *
 * Everything here is pure and synchronous. It is the only place where the
 * organism is allowed to change what the language model wanted to say, which
 * makes it the only place worth testing hard.
 */
import type {
  Candidate,
  Controls,
  NormalizeOptions,
  SelectionMode,
  Signal,
} from "./types.ts";

/**
 * Set from the measured spread distribution, not from taste. Run
 * `node tools/weights.mjs channels` and read the percentiles it prints: on the
 * default ring the per-read spread runs p05 9, p50 27, p95 44, and the
 * between-channel sd is 10-14.
 *
 * The first draft of these numbers was a guess an order of magnitude too small,
 * so the confidence rail carried full gain on 100% of reads and silenced 0%.
 * A guard that never fires is not a guard. These fire on the tail: a quiet
 * culture, a run that has consolidated off the ring, or a Phase 2 sensor that
 * has come unstuck.
 */
export const DEFAULT_NORMALIZE: NormalizeOptions = {
  spreadFloor: 3,
  deadband: 4,
  activeSpread: 15,
};

export const DEFAULT_CONTROLS: Controls = {
  candidateCount: 8,
  // Measured against the brief's own tiers, on the default corpus and ring:
  // 0.5 overrides 20% of tokens, 1 -> 37%, 2 -> 47%, 3 -> 83%, 8 -> 93%.
  // 2 is where "shared authorship" actually sits; 3 is already the culture
  // leading, which is not what a default should assume.
  gain: 2,
  temperature: 1,
  mode: "weighted",
  assignment: "persistent",
  moldSteps: 30,
  separation: 0.2,
  maxAttempts: 40,
};

/** Numerically stable softmax with temperature. */
export function softmax(logits: number[], temperature: number): number[] {
  const t = Math.max(1e-6, temperature);
  const scaled = logits.map((v) => v / t);
  const max = Math.max(...scaled);
  const exps = scaled.map((v) => Math.exp(v - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((v) => v / sum);
}

export type Normalized = {
  /** Centred, scale-normalised channel scores, aligned to the input order. */
  score: number[];
  /** Raw spread (max − min) in provider units. */
  spread: number;
  /** 0–1 belief that this step's spread carries information. */
  confidence: number;
};

/**
 * Turn raw channel readings into scores that are safe to add to a logit.
 *
 * Two things are load-bearing:
 *
 * 1. The normaliser is floored. Channel flux in this engine is bimodal — you
 *    are either inside the body or nowhere near it — so a plain z-score
 *    divides by ~0 on the many steps where every channel reads nothing.
 * 2. Confidence is derived from the same spread and multiplies the gain
 *    downstream, so a quiet organism is quiet rather than deafening.
 *
 * Per-channel `quality` scales each reading toward the mean, so a channel the
 * provider does not believe is pulled toward "no opinion" rather than toward
 * zero, which would itself be an opinion.
 */
export function normalizeSignals(
  signals: Signal[],
  options: NormalizeOptions = DEFAULT_NORMALIZE,
): Normalized {
  const n = signals.length;
  if (n === 0) return { score: [], spread: 0, confidence: 0 };

  const raw = signals.map((s) => s.raw);
  const mean = raw.reduce((a, b) => a + b, 0) / n;
  const variance = raw.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const sd = Math.sqrt(variance);
  const spread = Math.max(...raw) - Math.min(...raw);

  const divisor = Math.max(sd, options.spreadFloor);
  const score = signals.map((s) => ((s.raw - mean) / divisor) * clamp01(s.quality));

  const band = Math.max(1e-9, options.activeSpread - options.deadband);
  const confidence = clamp01((spread - options.deadband) / band);

  return { score, spread, confidence };
}

export type Combined = {
  baselineProb: number[];
  adjustedLogit: number[];
  adjustedProb: number[];
  effectiveGain: number;
};

/**
 * `adjusted_logit[i] = lm_logit[i] + gain × confidence × mold_score[i]`.
 *
 * Logit space, not probability space: adding in logit space is a fixed odds
 * ratio wherever it is applied, so a candidate the model gave 0.1% can be
 * lifted by the organism without the multiplier having to be absurd.
 *
 * `gain = 0` returns `adjustedProb` element-for-element equal to
 * `baselineProb`. That is an acceptance criterion, and `tests/` pins it.
 */
export function combine(
  logits: number[],
  score: number[],
  gain: number,
  confidence: number,
  temperature: number,
): Combined {
  const effectiveGain = gain * confidence;
  const adjustedLogit = logits.map((v, i) => v + effectiveGain * (score[i] ?? 0));
  return {
    baselineProb: softmax(logits, temperature),
    adjustedLogit,
    adjustedProb: softmax(adjustedLogit, temperature),
    effectiveGain,
  };
}

export type Selection = {
  index: number;
  /** False only when `threshold` mode ran out of attempts and took the leader. */
  committed: boolean;
};

/**
 * `uniform` is always consumed for `weighted`, whatever the gain, so that a
 * gain-0 run walks the same random path as a language-model-only run. If the
 * draw were conditional the acceptance criterion would be untestable.
 */
export function select(
  mode: SelectionMode,
  probs: number[],
  uniform: number,
  separation: number,
): Selection {
  if (mode === "argmax") return { index: argmax(probs), committed: true };

  if (mode === "threshold") {
    const sorted = [...probs].sort((a, b) => b - a);
    const gap = (sorted[0] ?? 0) - (sorted[1] ?? 0);
    return { index: argmax(probs), committed: gap >= separation };
  }

  let acc = 0;
  for (let i = 0; i < probs.length; i += 1) {
    acc += probs[i];
    if (uniform < acc) return { index: i, committed: true };
  }
  return { index: probs.length - 1, committed: true };
}

export function argmax(values: number[]): number {
  let best = 0;
  for (let i = 1; i < values.length; i += 1) if (values[i] > values[best]) best = i;
  return best;
}

/**
 * Candidate → channel. `persistent` is the default: the mould's inertia runs
 * to hundreds of steps, so reshuffling every token guarantees its state cannot
 * track the semantics and the influence degenerates into spatially-structured
 * noise — precisely the random-number generator this project disclaims.
 * `shuffled` is kept as the null arm: run it alongside to show the difference
 * is not an artefact of where the channels happen to sit.
 */
export function assignChannels(
  candidates: Candidate[],
  mode: Controls["assignment"],
  channelCount: number,
  random: () => number,
): number[] {
  const channels = candidates.map((_, i) => i % channelCount);
  if (mode === "persistent") return channels;
  for (let i = channels.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const swap = channels[i];
    channels[i] = channels[j];
    channels[j] = swap;
  }
  return channels;
}

function clamp01(v: number) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
