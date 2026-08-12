/**
 * Living Weights — shared contracts.
 *
 * The generation engine must not know how a signal was produced. It receives
 * normalised channel readings plus provenance, and nothing else. That is what
 * lets Phase 2 swap a simulated organism for electrodes or a camera without
 * touching the loop.
 */

/** One next-token option offered by the language model. */
export type Candidate = {
  /** The token as the model emits it, including any leading space. */
  token: string;
  /** Unnormalised log-score from the model, before any influence. */
  logit: number;
};

/** One channel reading at one instant. */
export type Signal = {
  channel: number;
  /** Provider-normalised to 0–1. Present for every provider. */
  value: number;
  /**
   * The measurement in its own physical units, before the provider squashed
   * it. The generator prefers this: normalising twice throws away the spread
   * that decides how much the organism is actually saying.
   */
  raw: number;
  /** Provider clock. Simulation ticks here; sample index or ms in Phase 2. */
  timestamp: number;
  /**
   * 0–1. How much this reading should be believed. A jammed region and a
   * detached electrode both read zero; only quality tells them apart.
   */
  quality: number;
};

export type ProviderIdentity = {
  id: string;
  /** Everything needed to rebuild this provider. Serialised into the log. */
  config: Record<string, unknown>;
};

/**
 * The hardware abstraction. Phase 1 implements this with the Physarum engine
 * and with a slider bank; Phase 2 implements it against a sensor.
 */
export type MoldSignalProvider = ProviderIdentity & {
  /** How many channels this provider can serve. */
  readonly channelCount: number;
  /** Let the organism live for a while. Returns the provider clock. */
  advance(steps: number): number;
  /** Read the first `candidateCount` channels. */
  readSignals(candidateCount: number): Signal[];
  /** Restore to the exact state implied by the config and a seed. */
  reset(): void;
};

export type LanguageModelAdapter = ProviderIdentity & {
  /** Top-`count` continuations of `text`, highest logit first. */
  candidates(text: string, count: number): Promise<Candidate[]>;
  /** Join a token onto the running text. Tokenisation is the adapter's business. */
  append(text: string, token: string): string;
};

export type SelectionMode = "argmax" | "weighted" | "threshold";
export type AssignmentMode = "persistent" | "shuffled";

/** Live controls. Every one of these is logged per step, so replay survives changes. */
export type Controls = {
  candidateCount: number;
  /** 0 reproduces the language model exactly. See `combine`. */
  gain: number;
  temperature: number;
  mode: SelectionMode;
  assignment: AssignmentMode;
  /** Provider steps between tokens. */
  moldSteps: number;
  /** `threshold` mode: probability gap the leader must open up to commit. */
  separation: number;
  /** `threshold` mode: give up and take the leader after this many attempts. */
  maxAttempts: number;
};

/** One candidate as it appeared at one decision. */
export type CandidateRecord = {
  token: string;
  channel: number;
  lmLogit: number;
  lmProb: number;
  raw: number;
  quality: number;
  score: number;
  adjustedLogit: number;
  adjustedProb: number;
};

/** Everything needed to reconstruct a single decision. */
export type StepRecord = {
  step: number;
  textBefore: string;
  candidates: CandidateRecord[];
  controls: Controls;
  /** gain × confidence — what was actually applied. */
  effectiveGain: number;
  /** 0–1 belief that the channel spread carries information this step. */
  confidence: number;
  /** Raw spread across channels, in provider units. */
  spread: number;
  /** The uniform draw consumed by `weighted` selection, else null. */
  uniform: number | null;
  /** Attempts taken in `threshold` mode; 1 everywhere else. */
  attempts: number;
  /** Whether `threshold` mode committed, or timed out and took the leader. */
  committed: boolean;
  chosenIndex: number;
  chosenToken: string;
  /** What the model alone would have chosen, given the same uniform draw. */
  baselineIndex: number;
  baselineToken: string;
  providerClock: number;
  wallClockMs: number;
};

export type RunHeader = {
  format: "living-weights/1";
  seed: number;
  prompt: string;
  controls: Controls;
  adapter: ProviderIdentity;
  provider: ProviderIdentity;
  normalize: NormalizeOptions;
  startedAtMs: number;
};

export type NormalizeOptions = {
  /**
   * Floor on the normaliser, in raw provider units. Without it, a step where
   * every channel reads ~0 divides by a near-zero spread and injects enormous
   * noise from nothing — the organism appears to seize control hardest exactly
   * when it has nothing to say.
   */
  spreadFloor: number;
  /** Raw spread at or below which confidence is 0. */
  deadband: number;
  /** Raw spread at or above which confidence is 1. */
  activeSpread: number;
};
