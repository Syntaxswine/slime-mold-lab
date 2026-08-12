/**
 * Living Weights — a plate in front of a camera, as eight channels.
 *
 * Satisfies the same contract as the simulated culture, so the generation
 * engine does not change: `advance` / `readSignals` / `reset`. That was the
 * Phase 1 acceptance criterion and this file is the test of it.
 *
 * Frame acquisition is behind `FrameSource` so that the arithmetic can be
 * exercised headlessly against synthetic frames. Nothing here touches the DOM;
 * `camera-source.ts` has the webcam and video-element sources.
 */
import {
  CONTRACTION_BAND,
  DEFAULT_DISH,
  DEFAULT_QUALITY_LIMITS,
  bandPower,
  dishRegions,
  frameQuality,
  logTransmittance,
  readFrames,
  type Band,
  type DishGeometry,
  type Frame,
  type QualityLimits,
  type Region,
} from "../vision.ts";
import type { MoldSignalProvider, Signal } from "../types.ts";

export type FrameSource = {
  id: string;
  config: Record<string, unknown>;
  /** The newest frame, or null if none has arrived since the last call. */
  grab(): Frame | null;
};

/**
 * Per-channel correction, measured rather than assumed.
 *
 * `offset` is subtracted from the raw reading. It is not cosmetic: a channel
 * that sits under the brighter half of the lamp, or over a scratch in the
 * agar, carries a higher activity floor forever, and the generator's z-score
 * reads a fixed floor as a permanent opinion. That is precisely the failure
 * Phase 1 named — geometry choosing the words rather than the organism.
 *
 * It must be measured on a plate with NO CULTURE ON IT, or during a period
 * when the culture is known to be dormant. Measured with the organism present
 * it subtracts the biology, and the piece will run beautifully and mean
 * nothing. `tools/weights.mjs calibrate` refuses a tape that does not look
 * quiet, for that reason.
 */
export type ChannelCalibration = {
  offset: number[];
  /** Raw value, after offset, that maps to `value` 1.0. Display only. */
  scale: number[];
};

export function flatCalibration(channelCount: number, scale = 0.05): ChannelCalibration {
  return {
    offset: new Array(channelCount).fill(0),
    scale: new Array(channelCount).fill(scale),
  };
}

export type CameraProviderConfig = {
  dish: DishGeometry;
  limits: QualityLimits;
  calibration: ChannelCalibration;
  /**
   * Frame pairs at which a reading is fully trusted.
   *
   * The camera analogue of the simulated provider's `qualityTicks`. A single
   * frame pair is one sample of a process whose period is measured in tens of
   * seconds; integrating several is the difference between a measurement and
   * a glimpse.
   */
  qualityFrames: number;
  /** Frames to consume and discard before the first reading is served. */
  warmupFrames: number;
  /**
   * How far the bench may drift from its warmup brightness before the session
   * stops being believed.
   *
   * This is a SESSION rail, not a frame rail, and it exists because the frame
   * rail structurally cannot see the failure it covers. `vision.ts` compares
   * consecutive frames, so a lamp dimming by half a percent per frame is
   * invisible to it — below 8-bit quantisation frame to frame — while over an
   * afternoon it moves the whole reading. Measured on the synthetic rig, a
   * 0.4%/frame ramp drops recovery of the known flux from Spearman 0.94 to
   * 0.73 while every frame-level rail reports the pair as clean.
   *
   * That is the camera's version of the baited channel: a confident,
   * well-structured, entirely non-biological signal. A room getting dark is
   * not the organism having an opinion.
   */
  sessionExposure: Band;
  /**
   * How a region's reading is computed.
   *
   * `band-power` is the default and the science-accurate one: the RMS
   * amplitude of the region's log-transmittance inside the plasmodium's
   * contraction band. A plasmodium's peristalsis modulates cross-section at
   * 131 +/- 43 s (Alim et al. 2013, PNAS 110(33):13306) and that modulation
   * appears directly in transmitted intensity, so restricting to the band is a
   * matched filter for an organism that is ALIVE AND PUMPING.
   *
   * `broadband` is the mean absolute frame-to-frame change. It is kept because
   * it is cheap, needs no window, and is the right fallback when the frame
   * interval is too coarse to resolve the rhythm — but it is owned by whatever
   * makes the largest change in frame, and nearly everything that goes wrong
   * with a camera makes a large broadband change. It cannot tell a pulsing
   * tube from a sclerotium, from a dead one, or from compression noise.
   */
  estimator: "band-power" | "broadband";
  /** Frequency band searched for the contraction rhythm. */
  band: { lowHz: number; highHz: number };
  /**
   * Length of the analysis window, in seconds.
   *
   * Sets both the frequency resolution and the latency of the whole piece. At
   * 1024 s the resolution is 0.98 mHz, so the 5-16.7 mHz band holds about 12
   * bins and the estimator's relative spread is roughly sqrt(2/24) = 29%.
   * Halving the window doubles that; doubling it halves it, at double the wait
   * for the first token. This is the number that decides whether a sentence
   * takes minutes or an hour.
   */
  windowSeconds: number;
};

export const DEFAULT_CAMERA_CONFIG: CameraProviderConfig = {
  dish: DEFAULT_DISH,
  limits: DEFAULT_QUALITY_LIMITS,
  calibration: flatCalibration(DEFAULT_DISH.channelCount),
  qualityFrames: 6,
  sessionExposure: { good: 0.05, ceiling: 0.35 },
  estimator: "band-power",
  band: CONTRACTION_BAND,
  windowSeconds: 1024,
  // A camera has the same startup problem the simulation had, for a different
  // reason: consumer auto-exposure and auto-white-balance take seconds to
  // settle, and every frame while they settle is a large, confident, entirely
  // non-biological change. Phase 1 measured the simulated equivalent — a fresh
  // culture reads as pure counting noise for ~200 ticks — and the lesson
  // transfers even though the number does not.
  warmupFrames: 8,
};

export type CameraProvider = MoldSignalProvider & {
  cameraConfig: CameraProviderConfig;
  regions: Region[];
  /** Diagnostics from the most recent frame pair, for the UI and the tape. */
  lastFaults: { reason: string; severity: number }[];
  lastFocus: number;
  lastBackgroundActivity: number;
  /** Bench luminance at the end of warmup. The session's illumination datum. */
  benchReference: number;
  /** Bench frame-to-frame activity at rest. The rig's own grain floor. */
  benchActivityFloor: number;
  /** Samples currently in the analysis window. */
  windowFill: number;
  /** Seconds between frames, measured rather than assumed. */
  frameIntervalSeconds: number;
  /** |bench now - bench at warmup| / bench at warmup. */
  lastSessionDrift: number;
  framesSeen: number;
};

export function makeCameraProvider(
  source: FrameSource,
  overrides: Partial<CameraProviderConfig> = {},
): CameraProvider {
  const config: CameraProviderConfig = { ...DEFAULT_CAMERA_CONFIG, ...overrides };
  const regions = dishRegions(config.dish);
  const n = config.dish.channelCount;

  let previous: Frame | null = null;
  let weighted = new Float64Array(n);
  let weight = 0;
  let pairs = 0;
  let clock = 0;
  let warmed = 0;
  let warmupBenchSum = 0;
  let warmupBenchCount = 0;
  let warmupActivitySum = 0;

  // A rolling window of each region's log transmittance, one sample per frame,
  // spanning many readings. Band power needs to see whole cycles of a rhythm
  // whose period is longer than the interval between tokens, so unlike the
  // broadband accumulator this must NOT be cleared by a read.
  const MAX_WINDOW = 4096;
  const history = Array.from({ length: n }, () => new Float64Array(MAX_WINDOW));
  const historyTime = new Float64Array(MAX_WINDOW);
  const historyQuality = new Float64Array(MAX_WINDOW);
  let historyCount = 0;
  let historyHead = 0;

  const provider: CameraProvider = {
    id: `camera:${source.id}`,
    config: { ...config, source: source.config } as unknown as Record<string, unknown>,
    channelCount: n,
    cameraConfig: config,
    regions,
    lastFaults: [],
    lastFocus: 0,
    lastBackgroundActivity: 0,
    benchReference: 0,
    benchActivityFloor: 0,
    windowFill: 0,
    frameIntervalSeconds: 0,
    lastSessionDrift: 0,
    framesSeen: 0,

    /**
     * Consume up to `steps` newly arrived frames.
     *
     * A live camera cannot be asked to hurry, so this takes what is there and
     * reports how little that was through `quality`. A short integration is a
     * real measurement of low confidence, not an error.
     */
    advance(steps: number) {
      for (let i = 0; i < steps; i += 1) {
        const frame = source.grab();
        if (!frame) break;
        provider.framesSeen += 1;
        clock = frame.timestampMs;

        if (!previous) {
          previous = frame;
          continue;
        }
        if (warmed < config.warmupFrames) {
          warmed += 1;
          // The warmup is also where the illumination datum comes from, so it
          // is not wasted time even on a source that needs no settling.
          const warmupReading = readFrames(previous, frame, config.dish, regions);
          if (warmupReading.referenceLuminance > 0) {
            warmupBenchSum += warmupReading.referenceLuminance;
            warmupActivitySum += warmupReading.worstBackgroundActivity;
            warmupBenchCount += 1;
            provider.benchReference = warmupBenchSum / warmupBenchCount;
            provider.benchActivityFloor = warmupActivitySum / warmupBenchCount;
          }
          previous = frame;
          continue;
        }

        const reading = readFrames(previous, frame, config.dish, regions);
        const frameCheck = frameQuality(reading, config.limits, provider.benchActivityFloor);
        const faults = [...frameCheck.faults];

        // The session rail: how far the light has moved since calibration.
        let sessionFactor = 1;
        if (provider.benchReference > 0 && reading.referenceLuminance > 0) {
          const drift =
            Math.abs(reading.referenceLuminance - provider.benchReference) / provider.benchReference;
          provider.lastSessionDrift = drift;
          const { good, ceiling } = config.sessionExposure;
          sessionFactor = clamp01(1 - Math.max(0, drift - good) / Math.max(1e-9, ceiling - good));
          if (sessionFactor < 1) {
            faults.push({ reason: "lighting has drifted since calibration", severity: 1 - sessionFactor });
          }
        }

        const quality = frameCheck.quality * sessionFactor;
        faults.sort((a, b) => b.severity - a.severity);
        provider.lastFaults = faults;
        provider.lastFocus = reading.focus;
        provider.lastBackgroundActivity = reading.backgroundActivity;

        // Weighted by the frame's own quality, so a frame taken while someone
        // walked past contributes nothing rather than contributing a lie. If
        // every frame in the window is bad the weight is zero and the reading
        // is zero, which the generator's confidence rail then silences.
        for (let c = 0; c < n; c += 1) weighted[c] += (reading.corrected[c] ?? 0) * quality;
        weight += quality;
        pairs += 1;

        for (let c = 0; c < n; c += 1) {
          history[c][historyHead] = logTransmittance(
            reading.regions[c]?.luminance ?? 0,
            reading.referenceLuminance,
          );
        }
        historyTime[historyHead] = frame.timestampMs / 1000;
        historyQuality[historyHead] = quality;
        historyHead = (historyHead + 1) % MAX_WINDOW;
        historyCount = Math.min(historyCount + 1, MAX_WINDOW);

        previous = frame;
      }
      return clock;
    },

    readSignals(candidateCount: number): Signal[] {
      const served = Math.min(candidateCount, n);
      const out: Signal[] = [];

      // Ordered oldest-to-newest slice of the rolling window.
      const ordered = (channel: number, want: number) => {
        const take = Math.min(want, historyCount);
        const values = new Array<number>(take);
        for (let i = 0; i < take; i += 1) {
          const index = (historyHead - take + i + MAX_WINDOW) % MAX_WINDOW;
          values[i] = history[channel][index];
        }
        return values;
      };
      const orderedMeta = (want: number) => {
        const take = Math.min(want, historyCount);
        let firstTime = 0;
        let lastTime = 0;
        let qualitySum = 0;
        for (let i = 0; i < take; i += 1) {
          const index = (historyHead - take + i + MAX_WINDOW) % MAX_WINDOW;
          if (i === 0) firstTime = historyTime[index];
          lastTime = historyTime[index];
          qualitySum += historyQuality[index];
        }
        return {
          take,
          dt: take > 1 ? (lastTime - firstTime) / (take - 1) : 0,
          meanQuality: take === 0 ? 0 : qualitySum / take,
        };
      };

      if (config.estimator === "band-power") {
        // Measured, never assumed: a live camera does not deliver frames on
        // the interval you asked for, and getting dt wrong shifts the band.
        const spanFrames = (() => {
          const probe = orderedMeta(Math.min(historyCount, MAX_WINDOW));
          if (probe.dt <= 0) return config.qualityFrames;
          return Math.max(16, Math.min(MAX_WINDOW, Math.round(config.windowSeconds / probe.dt)));
        })();
        const meta = orderedMeta(spanFrames);
        provider.windowFill = meta.take / spanFrames;
        provider.frameIntervalSeconds = meta.dt;

        // The window must hold whole cycles of the slowest rhythm searched for,
        // or the lowest bins do not exist and the estimator quietly reports
        // whatever the next bins up happen to contain.
        const cyclesHeld = meta.dt > 0 ? (meta.take * meta.dt) / (1 / config.band.lowHz) : 0;
        const readiness = clamp01(cyclesHeld / 2);

        for (let c = 0; c < served; c += 1) {
          const amplitude =
            meta.take >= 8 && meta.dt > 0
              ? bandPower(ordered(c, spanFrames), meta.dt, config.band.lowHz, config.band.highHz)
              : 0;
          const raw = Math.max(0, amplitude - config.calibration.offset[c]);
          out.push({
            channel: c,
            value: clamp01(raw / Math.max(1e-12, config.calibration.scale[c])),
            raw,
            timestamp: clock,
            quality: readiness * meta.meanQuality,
          });
        }
      } else {
        const integration = clamp01(pairs / config.qualityFrames);
        const meanFrameQuality = pairs === 0 ? 0 : weight / pairs;
        const quality = integration * meanFrameQuality;
        provider.windowFill = integration;

        for (let c = 0; c < served; c += 1) {
          const raw =
            weight > 0 ? Math.max(0, weighted[c] / weight - config.calibration.offset[c]) : 0;
          out.push({
            channel: c,
            value: clamp01(raw / Math.max(1e-9, config.calibration.scale[c])),
            raw,
            timestamp: clock,
            quality,
          });
        }
      }

      // Only the broadband accumulator resets. The band-power window spans
      // many readings by design: clearing it here would leave every read
      // analysing a fraction of one cycle.
      weighted = new Float64Array(n);
      weight = 0;
      pairs = 0;
      return out;
    },

    reset() {
      previous = null;
      weighted = new Float64Array(n);
      weight = 0;
      pairs = 0;
      warmed = 0;
      clock = 0;
      warmupBenchSum = 0;
      warmupBenchCount = 0;
      warmupActivitySum = 0;
      historyCount = 0;
      historyHead = 0;
      provider.benchReference = 0;
      provider.benchActivityFloor = 0;
      provider.windowFill = 0;
      provider.frameIntervalSeconds = 0;
      provider.lastSessionDrift = 0;
      provider.framesSeen = 0;
      provider.lastFaults = [];
    },
  };

  return provider;
}

/**
 * Derive a calibration and the quality limits from a quiet recording.
 *
 * The Phase 1 constants were measured on a lattice and none of them transfer:
 * `raw` there was landings per tick, here it is a dimensionless relative
 * change per frame, three orders of magnitude smaller. Everything downstream
 * of `raw` — the normaliser's deadband, its full-confidence spread, the
 * per-channel offsets — has to be re-derived against the actual rig, and this
 * is the function that does it.
 *
 * `quiet` should be a tape of the rig running with no culture, or with a
 * dormant one: it measures what the apparatus says when the organism is
 * saying nothing.
 */
export function deriveCalibration(
  quietRaw: number[][],
  activeRaw: number[][] = [],
  focusSamples: number[] = [],
): {
  calibration: ChannelCalibration;
  suggestedNormalize: { spreadFloor: number; deadband: number; activeSpread: number };
  suggestedFocus: Band | null;
} {
  const n = quietRaw[0]?.length ?? 0;
  const column = (rows: number[][], c: number) => rows.map((row) => row[c] ?? 0);
  const mean = (v: number[]) => (v.length === 0 ? 0 : v.reduce((a, b) => a + b, 0) / v.length);
  const sd = (v: number[]) => {
    if (v.length === 0) return 0;
    const m = mean(v);
    return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length);
  };

  // The floor a channel reports with nothing alive in front of it, plus two
  // standard deviations of its own noise, so ordinary quiet does not read as
  // a faint opinion.
  const offset = Array.from({ length: n }, (_, c) => {
    const q = column(quietRaw, c);
    return mean(q) + 2 * sd(q);
  });

  const corrected = (rows: number[][]) =>
    rows.map((row) => row.map((v, c) => Math.max(0, v - offset[c])));

  const activeCorrected = corrected(activeRaw.length > 0 ? activeRaw : quietRaw);
  const spreads = activeCorrected.map((row) => Math.max(...row) - Math.min(...row));
  const quietSpreads = corrected(quietRaw).map((row) => Math.max(...row) - Math.min(...row));
  const quantile = (v: number[], p: number) => {
    if (v.length === 0) return 0;
    const s = [...v].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(p * s.length))];
  };

  // Full scale is the 95th percentile of what the rig actually produced, not
  // a round number: a `value` axis that never reaches 1 is as misleading as
  // one that clips.
  const scale = Array.from({ length: n }, (_, c) => {
    const a = column(activeCorrected, c);
    return Math.max(1e-6, quantile(a, 0.95));
  });

  // The focus rail cannot have a universal constant. Variance of the
  // Laplacian is in squared luminance units and depends on the lens, the
  // sensor, the magnification and how textured the subject is: the synthetic
  // rig reads about 8700 sharp and 220 after one blur pass, and a real webcam
  // on a wet plate will read nothing like either. The only honest threshold is
  // relative to what THIS rig produced when someone confirmed it was in focus.
  const sortedFocus = [...focusSamples].sort((a, b) => a - b);
  const medianFocus = sortedFocus.length === 0 ? 0 : sortedFocus[Math.floor(sortedFocus.length / 2)];

  return {
    calibration: { offset, scale },
    suggestedFocus: medianFocus > 0 ? { good: medianFocus * 0.6, ceiling: medianFocus * 0.1 } : null,
    suggestedNormalize: {
      // Floor the normaliser at the apparatus's own between-channel noise.
      spreadFloor: Math.max(1e-9, mean(Array.from({ length: n }, (_, c) => sd(column(corrected(quietRaw), c))))),
      // Below what a quiet rig produces 95% of the time, the organism is not
      // the thing being measured.
      deadband: quantile(quietSpreads, 0.95),
      // Full confidence where a live culture spends most of its time.
      activeSpread: Math.max(quantile(spreads, 0.25), quantile(quietSpreads, 0.95) * 2),
    },
  };
}

function clamp01(v: number) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
