/**
 * Living Weights — the generation loop.
 *
 * One token per `step()`. The UI drives it; nothing here schedules itself, so
 * start, pause, single-step and stop are the caller's business and the loop
 * stays testable headlessly.
 */
import { mulberry32 } from "../physarum-engine.ts";
import type {
  CandidateRecord,
  Controls,
  LanguageModelAdapter,
  MoldSignalProvider,
  NormalizeOptions,
  RunHeader,
  StepRecord,
} from "./types.ts";
import {
  assignChannels,
  combine,
  DEFAULT_CONTROLS,
  DEFAULT_NORMALIZE,
  normalizeSignals,
  select,
} from "./weights.ts";

export type RunOptions = {
  adapter: LanguageModelAdapter;
  provider: MoldSignalProvider;
  prompt: string;
  seed: number;
  controls?: Partial<Controls>;
  normalize?: Partial<NormalizeOptions>;
  /** Injected so replay and tests are not at the mercy of the wall clock. */
  now?: () => number;
};

export class LivingWeightsRun {
  readonly adapter: LanguageModelAdapter;
  readonly provider: MoldSignalProvider;
  readonly seed: number;
  readonly normalize: NormalizeOptions;
  readonly records: StepRecord[] = [];

  /** Live, and logged per step, so changing them mid-run does not break replay. */
  controls: Controls;

  text: string;

  private readonly now: () => number;
  private readonly selectRandom: () => number;
  /**
   * A separate stream on purpose. The engine's own seed defect is that its UI
   * draws from the physics RNG, so nudging a control forks the trajectory;
   * giving assignment its own stream means switching between persistent and
   * shuffled cannot silently change which words the sampler would have picked.
   */
  private readonly assignRandom: () => number;
  private readonly startedAtMs: number;

  constructor(options: RunOptions) {
    this.adapter = options.adapter;
    this.provider = options.provider;
    this.seed = options.seed;
    this.controls = { ...DEFAULT_CONTROLS, ...options.controls };
    this.normalize = { ...DEFAULT_NORMALIZE, ...options.normalize };
    this.text = options.prompt;
    this.now = options.now ?? Date.now;
    this.selectRandom = mulberry32(options.seed);
    this.assignRandom = mulberry32(options.seed ^ 0x9e3779b9);
    this.startedAtMs = this.now();
  }

  get header(): RunHeader {
    return {
      format: "living-weights/1",
      seed: this.seed,
      prompt: this.records[0]?.textBefore ?? this.text,
      controls: { ...this.controls },
      adapter: { id: this.adapter.id, config: this.adapter.config },
      provider: { id: this.provider.id, config: this.provider.config },
      normalize: { ...this.normalize },
      startedAtMs: this.startedAtMs,
    };
  }

  /**
   * Generate exactly one token. Returns null if the model offered nothing.
   *
   * `override` is how a live interface hands in the current dial positions
   * without reaching in and assigning to `controls`. Whatever is used is
   * copied into the record, so a run whose gain was turned mid-sentence is
   * still fully described by its own log.
   */
  async step(override?: Controls): Promise<StepRecord | null> {
    const controls: Controls = { ...(override ?? this.controls) };
    const textBefore = this.text;
    const candidates = await this.adapter.candidates(textBefore, controls.candidateCount);
    if (candidates.length === 0) return null;

    const logits = candidates.map((c) => c.logit);
    let attempts = 0;
    let committed = false;
    let chosen = 0;
    let baselineIndex = 0;
    let uniform: number | null = null;
    let channels: number[] = [];
    let raw: number[] = [];
    let quality: number[] = [];
    let candidateScore: number[] = [];
    let confidence = 0;
    let spread = 0;
    let providerClock = 0;
    let effectiveGain = 0;
    let adjustedLogit: number[] = [];
    let adjustedProb: number[] = [];
    let baselineProb: number[] = [];

    // `threshold` mode keeps letting the organism live until one channel opens
    // a real gap. Every other mode runs this once.
    do {
      attempts += 1;
      this.provider.advance(controls.moldSteps);
      const signals = this.provider.readSignals(controls.candidateCount);
      const normalized = normalizeSignals(signals, this.normalize);
      providerClock = signals[0]?.timestamp ?? 0;
      confidence = normalized.confidence;
      spread = normalized.spread;

      channels = assignChannels(
        candidates,
        controls.assignment,
        this.provider.channelCount,
        this.assignRandom,
      );
      raw = channels.map((c) => signals[c]?.raw ?? 0);
      quality = channels.map((c) => signals[c]?.quality ?? 0);
      candidateScore = channels.map((c) => normalized.score[c] ?? 0);

      const combined = combine(
        logits,
        candidateScore,
        controls.gain,
        confidence,
        controls.temperature,
      );
      adjustedLogit = combined.adjustedLogit;
      adjustedProb = combined.adjustedProb;
      baselineProb = combined.baselineProb;
      effectiveGain = combined.effectiveGain;

      // Drawn on every attempt in every mode, so the random stream depends on
      // how many attempts happened and nothing else. If the draw were
      // conditional, switching selection mode mid-run would silently reroute
      // every later token and "gain 0 reproduces the model" would be untestable.
      uniform = this.selectRandom();
      const picked = select(controls.mode, adjustedProb, uniform, controls.separation);
      chosen = picked.index;
      committed = picked.committed;
      baselineIndex = select(controls.mode, baselineProb, uniform, controls.separation).index;
    } while (!committed && attempts < controls.maxAttempts);

    const candidateRecords: CandidateRecord[] = candidates.map((c, i) => ({
      token: c.token,
      channel: channels[i],
      lmLogit: c.logit,
      lmProb: baselineProb[i],
      raw: raw[i],
      quality: quality[i],
      score: candidateScore[i],
      adjustedLogit: adjustedLogit[i],
      adjustedProb: adjustedProb[i],
    }));

    const record: StepRecord = {
      step: this.records.length,
      textBefore,
      candidates: candidateRecords,
      controls,
      effectiveGain,
      confidence,
      spread,
      uniform,
      attempts,
      committed,
      chosenIndex: chosen,
      chosenToken: candidates[chosen].token,
      baselineIndex,
      baselineToken: candidates[baselineIndex].token,
      providerClock,
      wallClockMs: this.now(),
    };

    this.text = this.adapter.append(textBefore, record.chosenToken);
    this.records.push(record);
    return record;
  }

  async run(tokens: number): Promise<StepRecord[]> {
    const produced: StepRecord[] = [];
    for (let i = 0; i < tokens; i += 1) {
      const record = await this.step();
      if (!record) break;
      produced.push(record);
    }
    return produced;
  }

  /** How often the organism overrode the model. The headline number. */
  get divergence(): { steps: number; diverged: number; fraction: number } {
    const diverged = this.records.filter((r) => r.chosenIndex !== r.baselineIndex).length;
    return {
      steps: this.records.length,
      diverged,
      fraction: this.records.length === 0 ? 0 : diverged / this.records.length,
    };
  }
}
