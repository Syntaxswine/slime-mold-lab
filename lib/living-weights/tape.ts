/**
 * Living Weights — sensor tape.
 *
 * Phase 1 could promise that a run reproduces from its seed, because the
 * organism was a seeded simulation. A living culture in front of a camera
 * destroys that promise outright: the organism will not do the same thing
 * twice and neither will the room's lighting.
 *
 * The tape is how the promise survives. Every reading a provider hands to the
 * generator is written down as it happens, with its clock and its quality, and
 * a tape can then be played back through the same generator to reproduce the
 * run exactly. What is reproducible is no longer "the organism" but "this
 * hour of this organism" — which is the honest claim, and the one an archive
 * needs anyway.
 *
 * It also makes the fourth Phase 2 deliverable possible at all. "Recorded test
 * runs comparing model-only output with mold-influenced output" is not a fair
 * comparison against a live sensor, because the two runs would see different
 * minutes of the culture's life. Against a tape they see the same minutes, and
 * the only difference between them is the gain.
 *
 * Frames are not stored. A reading is a few hundred bytes; an hour of frames
 * is gigabytes, and the frames are not what the generator consumed.
 */
import type { MoldSignalProvider, Signal } from "./types.ts";

export type TapeRead = {
  /** Index of this reading in the tape. */
  index: number;
  /** Provider clock at the moment of the reading. */
  clock: number;
  /** Wall clock, so a tape can be lined up against a video or a lab notebook. */
  wallClockMs: number;
  /** Steps requested of `advance` before this reading. */
  steps: number;
  raw: number[];
  value: number[];
  quality: number[];
  /** Free-form provider diagnostics — camera faults, electrode drift. */
  notes?: Record<string, unknown>;
};

export type TapeHeader = {
  format: "living-weights-tape/1";
  providerId: string;
  providerConfig: Record<string, unknown>;
  channelCount: number;
  startedAtMs: number;
};

export type Tape = {
  header: TapeHeader;
  reads: TapeRead[];
};

export function serializeTape(tape: Tape): string {
  return `${[JSON.stringify(tape.header), ...tape.reads.map((r) => JSON.stringify(r))].join("\n")}\n`;
}

export function parseTape(text: string): Tape {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) throw new Error("empty tape");
  const header = JSON.parse(lines[0]) as TapeHeader;
  if (header.format !== "living-weights-tape/1") {
    throw new Error(`unknown tape format: ${String(header.format)}`);
  }
  return { header, reads: lines.slice(1).map((l) => JSON.parse(l) as TapeRead) };
}

export type Recorder = MoldSignalProvider & {
  readonly tape: Tape;
  /** Provider diagnostics to attach to the next reading. */
  note(notes: Record<string, unknown>): void;
};

/**
 * Wrap any provider so that everything it says is written down.
 *
 * A decorator rather than a feature of each provider, so that the simulated
 * culture, a camera and an electrode rig all tape identically and a tape from
 * one can be A/B'd against a tape from another without special-casing.
 */
export function recordTape(
  provider: MoldSignalProvider,
  now: () => number = Date.now,
): Recorder {
  const startedAtMs = now();
  const tape: Tape = {
    header: {
      format: "living-weights-tape/1",
      providerId: provider.id,
      providerConfig: provider.config,
      channelCount: provider.channelCount,
      startedAtMs,
    },
    reads: [],
  };
  let pendingSteps = 0;
  let pendingNotes: Record<string, unknown> | undefined;

  return {
    id: `tape-recorder:${provider.id}`,
    config: provider.config,
    channelCount: provider.channelCount,
    tape,

    note(notes: Record<string, unknown>) {
      pendingNotes = { ...pendingNotes, ...notes };
    },

    advance(steps: number) {
      pendingSteps += steps;
      return provider.advance(steps);
    },

    readSignals(candidateCount: number): Signal[] {
      const signals = provider.readSignals(candidateCount);
      tape.reads.push({
        index: tape.reads.length,
        clock: signals[0]?.timestamp ?? 0,
        wallClockMs: now(),
        steps: pendingSteps,
        raw: signals.map((s) => s.raw),
        value: signals.map((s) => s.value),
        quality: signals.map((s) => s.quality),
        ...(pendingNotes ? { notes: pendingNotes } : {}),
      });
      pendingSteps = 0;
      pendingNotes = undefined;
      return signals;
    },

    reset() {
      provider.reset();
      tape.reads.length = 0;
      pendingSteps = 0;
      pendingNotes = undefined;
    },
  };
}

/**
 * Play a tape back as a provider.
 *
 * `advance` is deliberately inert. The tape's granularity is a reading, not a
 * tick: it already records what the sensor said for the Nth token, so honouring
 * a step count would mean inventing intermediate states that were never
 * measured. The recorded `steps` are kept on each read so a replay can be
 * checked against the run that produced it.
 */
export function makeTapeProvider(tape: Tape): MoldSignalProvider & { exhausted: boolean } {
  let cursor = 0;

  const provider = {
    id: `tape:${tape.header.providerId}`,
    config: { ...tape.header.providerConfig, tapeReads: tape.reads.length },
    channelCount: tape.header.channelCount,
    exhausted: false,

    // Takes no step count on purpose; see the note above. Callers still pass
    // one, and TypeScript is happy to ignore it.
    advance() {
      return tape.reads[Math.min(cursor, tape.reads.length - 1)]?.clock ?? 0;
    },

    readSignals(candidateCount: number): Signal[] {
      const served = Math.min(candidateCount, tape.header.channelCount);
      const read = tape.reads[cursor];
      cursor += 1;
      if (!read) {
        // Past the end the tape says nothing, at quality zero, and means it.
        // Serving the last reading again would be the sensor equivalent of a
        // frozen frame: perfectly confident and completely stale.
        provider.exhausted = true;
        return Array.from({ length: served }, (_, channel) => ({
          channel,
          value: 0,
          raw: 0,
          timestamp: tape.reads[tape.reads.length - 1]?.clock ?? 0,
          quality: 0,
        }));
      }
      return Array.from({ length: served }, (_, channel) => ({
        channel,
        value: read.value[channel] ?? 0,
        raw: read.raw[channel] ?? 0,
        timestamp: read.clock,
        quality: read.quality[channel] ?? 0,
      }));
    },

    reset() {
      cursor = 0;
      provider.exhausted = false;
    },
  };

  return provider;
}

/** Per-channel summary of a tape. What `calibrate` and the fairness test read. */
export function summarizeTape(tape: Tape) {
  const n = tape.header.channelCount;
  const perChannel = Array.from({ length: n }, () => [] as number[]);
  const spreads: number[] = [];
  const qualities: number[] = [];

  /**
   * Only reads the provider vouched for.
   *
   * A camera discards its first frames while the exposure settles, so the
   * opening reads of a tape come back all-zero at quality zero. Those are not
   * quiet measurements, they are the absence of a measurement, and averaging
   * them in poisons every statistic here. It poisoned one badly: a pair of
   * leading zeros in a 25-read tape sits far below the mean on every channel
   * at once, which is a correlated residual, which drove the pattern-inertia
   * figure on a BARE PLATE from -0.06 to 0.82 — indistinguishable from a
   * living culture, and it would have silently disarmed the calibration
   * refusal that depends on it.
   */
  const scored = tape.reads.filter(
    (read) => read.quality.length > 0 && read.quality.some((q) => q > 0),
  );

  for (const read of scored) {
    for (let c = 0; c < n; c += 1) perChannel[c].push(read.raw[c] ?? 0);
    const row = read.raw.slice(0, n);
    if (row.length > 0) spreads.push(Math.max(...row) - Math.min(...row));
    qualities.push(read.quality.reduce((a, b) => a + b, 0) / Math.max(1, read.quality.length));
  }

  /**
   * Lag-1 correlation of the channel pattern, after each channel's own time
   * mean is removed. The one statistic that tells a bare plate from a working
   * culture without a second recording to compare against.
   *
   * Sensor noise is white, so successive residual patterns are uncorrelated
   * and this sits near 0. An organism has spatial inertia measured in minutes,
   * so whatever pattern it had a moment ago is still mostly there. Measured on
   * this rig: bare plate -0.06, live culture 0.87.
   *
   * Removing the per-channel mean first is essential — it strips a fixed
   * lighting gradient, which is exactly what the calibration offsets exist to
   * cancel and must never be mistaken for life.
   *
   * The obvious statistic, a coefficient of variation, is not merely weaker
   * here but INVERTED: a quiet rig has a near-zero mean, so its relative
   * variation is enormous. The first version of the calibration refusal used
   * it and confidently rejected the bare plate while accepting the culture.
   */
  const inertia = (() => {
    if (scored.length < 3) return 0;
    const times = Array.from({ length: n }, (_, c) => perChannel[c]);
    const channelMean = times.map((v) => (v.length === 0 ? 0 : v.reduce((a, b) => a + b, 0) / v.length));
    let total = 0;
    let pairs = 0;
    for (let i = 1; i < scored.length; i += 1) {
      let dot = 0;
      let na = 0;
      let nb = 0;
      for (let c = 0; c < n; c += 1) {
        const a = (times[c][i - 1] ?? 0) - channelMean[c];
        const b = (times[c][i] ?? 0) - channelMean[c];
        dot += a * b;
        na += a * a;
        nb += b * b;
      }
      if (na > 0 && nb > 0) {
        total += dot / Math.sqrt(na * nb);
        pairs += 1;
      }
    }
    return pairs === 0 ? 0 : total / pairs;
  })();

  const mean = (v: number[]) => (v.length === 0 ? 0 : v.reduce((a, b) => a + b, 0) / v.length);
  const sd = (v: number[]) => {
    if (v.length === 0) return 0;
    const m = mean(v);
    return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length);
  };
  const quantile = (v: number[], p: number) => {
    if (v.length === 0) return 0;
    const sorted = [...v].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  };

  return {
    reads: scored.length,
    /** Reads discarded for carrying no quality at all — usually the warmup. */
    unscored: tape.reads.length - scored.length,
    channelMeans: perChannel.map(mean),
    channelSds: perChannel.map(sd),
    grandMean: mean(perChannel.map(mean)),
    /** Variation explained by which channel it is. Should be the smaller one. */
    betweenChannel: sd(perChannel.map(mean)),
    /** Variation of a channel over time. Should be the larger one. */
    withinChannel: mean(perChannel.map(sd)),
    /** Near 0 for an apparatus talking to itself; high for something alive. */
    inertia,
    spread: {
      p01: quantile(spreads, 0.01),
      p05: quantile(spreads, 0.05),
      p50: quantile(spreads, 0.5),
      p95: quantile(spreads, 0.95),
    },
    meanQuality: mean(qualities),
  };
}
