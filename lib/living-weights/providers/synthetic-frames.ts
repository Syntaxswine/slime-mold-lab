/**
 * Living Weights — a simulated culture, rendered to pixels.
 *
 * This exists to answer a question the camera provider cannot answer about
 * itself: does reading a plate through a lens recover what the organism is
 * actually doing, or does it recover the lighting?
 *
 * There is no ground truth for a real dish. There is one here. The Phase 1
 * simulation knows its own per-channel flux exactly, so rendering it to a
 * frame buffer, pushing those frames through the whole camera pipeline, and
 * comparing what comes out against what went in is a real end-to-end test of
 * the vision arithmetic. If the ranking the camera reports does not track the
 * ranking the simulation knows, the arithmetic is wrong — and that is a thing
 * you find out here, on a bench, rather than three hours into a gallery run.
 *
 * It is also the demo path. Someone can watch the camera provider work before
 * owning a culture, a lamp or a webcam.
 *
 * The defects are deliberate and switchable. A synthetic source that is
 * perfect tests nothing about the quality rails, so this one can be told to
 * drift its exposure, put noise on the bench, or blur.
 */
import { GRID_H, GRID_W } from "../../physarum-engine.ts";
import type { DishGeometry, Frame } from "../vision.ts";
import type { MoldProvider } from "./mold.ts";
import type { FrameSource } from "./camera.ts";

export type SyntheticConfig = {
  width: number;
  height: number;
  /** Simulation ticks between frames. */
  ticksPerFrame: number;
  /** Milliseconds of pretend wall clock between frames. */
  frameIntervalMs: number;
  /** Luminance of the bench outside the dish, 0-255. */
  benchLuma: number;
  /** Amplitude of per-frame bench noise, in luminance units. Drives the drift rail. */
  benchNoise: number;
  /** Fractional exposure change per frame. Drives the exposure rail. */
  exposureDriftPerFrame: number;
  /** 0 = sharp. 1 = one box-blur pass. Drives the focus rail. */
  blurPasses: number;
  /**
   * Render an empty plate: agar and sensor grain, no culture.
   *
   * This is the bare-plate recording every calibration needs. The per-channel
   * offsets have to be measured with nothing alive in the dish, because an
   * offset measured while the organism is working subtracts the organism —
   * and a rig calibrated that way runs beautifully and means nothing. Having
   * it here means the whole calibration workflow can be exercised, and its
   * refusals demonstrated, before anyone owns a culture.
   */
  bare: boolean;
  /**
   * Hold the disturbances off until this many frames have been rendered.
   *
   * A rig that has been noisy since before anyone looked at it is a different
   * problem from a rig that was fine and then someone walked past. The first
   * is a permanently degraded measurement; the second is the one that ruins a
   * run halfway through, and it is the one worth refusing.
   */
  disturbAfterFrames: number;
  /** Sensor grain inside the dish, in luminance units. Also a focus reference. */
  grain: number;
  seed: number;
};

export const DEFAULT_SYNTHETIC: SyntheticConfig = {
  width: 520,
  height: 400,
  ticksPerFrame: 6,
  frameIntervalMs: 1000,
  benchLuma: 34,
  benchNoise: 0,
  exposureDriftPerFrame: 0,
  blurPasses: 0,
  bare: false,
  disturbAfterFrames: 0,
  grain: 4,
  seed: 1234,
};

/**
 * Dish geometry that lands the camera's eight regions exactly on the
 * simulation's eight channel sites, so the two can be compared channel for
 * channel. Derived from the mold provider rather than restated, because a
 * hand-copied radius that drifts out of step would make the comparison
 * meaningless while still looking like it worked.
 */
export function dishForSimulation(
  mold: MoldProvider,
  config: SyntheticConfig = DEFAULT_SYNTHETIC,
): DishGeometry {
  const dishRadius = Math.min(config.width, config.height) / 2 - 90;
  return {
    cx: config.width / 2,
    cy: config.height / 2,
    radius: dishRadius,
    ringFraction: mold.moldConfig.ringRadius / dishRadius,
    channelFraction: mold.moldConfig.detectRadius / dishRadius,
    phaseDegrees: mold.moldConfig.ringPhaseDegrees,
    channelCount: mold.moldConfig.channelCount,
  };
}

export function makeSimulatedFrameSource(
  mold: MoldProvider,
  overrides: Partial<SyntheticConfig> = {},
): FrameSource & { dish: DishGeometry; framesRendered: number } {
  const config: SyntheticConfig = { ...DEFAULT_SYNTHETIC, ...overrides };
  const dish = dishForSimulation(mold, config);
  const { width, height } = config;
  const buffer = new Uint8ClampedArray(width * height * 4);
  const scratch = new Uint8ClampedArray(width * height * 4);

  let timestampMs = 0;
  let exposure = 1;
  let noiseState = config.seed >>> 0;
  const noise = () => {
    noiseState = (noiseState * 1664525 + 1013904223) >>> 0;
    return noiseState / 4294967296;
  };

  const source = {
    id: "synthetic-culture",
    config: config as unknown as Record<string, unknown>,
    dish,
    framesRendered: 0,

    grab(): Frame {
      mold.advance(config.ticksPerFrame);
      const simulation = mold.simulation;
      const disturbed = source.framesRendered >= config.disturbAfterFrames;
      const benchNoise = disturbed ? config.benchNoise : 0;
      if (disturbed) exposure *= 1 + config.exposureDriftPerFrame;

      const r2 = dish.radius * dish.radius;
      for (let y = 0; y < height; y += 1) {
        const dy = y - dish.cy;
        for (let x = 0; x < width; x += 1) {
          const dx = x - dish.cx;
          const pixel = (y * width + x) * 4;
          let value: number;

          if (config.bare && dx * dx + dy * dy <= r2) {
            value = 52;
          } else if (dx * dx + dy * dy <= r2) {
            // Inside the dish, show the culture with the same ramp the app
            // uses. The occupancy layer is what carries movement frame to
            // frame, which is exactly the quantity the camera is meant to
            // recover; the trail layer is the slow structure behind it.
            const sx = ((Math.round(dx + GRID_W / 2) % GRID_W) + GRID_W) % GRID_W;
            const sy = ((Math.round(dy + GRID_H / 2) % GRID_H) + GRID_H) % GRID_H;
            const cell = sy * GRID_W + sx;
            const trail = 1 - Math.exp(-simulation.trail[cell] * 0.15);
            const occupied = simulation.occupancy[cell] !== -1;
            value = occupied ? 210 : 14 + trail * 150;
          } else {
            value = config.benchLuma + (benchNoise > 0 ? (noise() - 0.5) * 2 * benchNoise : 0);
          }

          // Fixed-pattern texture plus a little per-frame grain. The pattern
          // gives the frame something to be in focus about; the grain is the
          // noise floor a real sensor puts under every reading, and it is what
          // the per-channel offsets exist to cancel.
          const textured = value + (((x * 7 + y * 13) % 5) - 2) * 3;
          const grained = config.grain > 0 ? textured + (noise() - 0.5) * config.grain : textured;
          const shown = clamp255(grained * exposure);
          buffer[pixel] = shown;
          buffer[pixel + 1] = shown;
          buffer[pixel + 2] = shown;
          buffer[pixel + 3] = 255;
        }
      }

      for (let pass = 0; pass < config.blurPasses; pass += 1) boxBlur(buffer, scratch, width, height);

      timestampMs += config.frameIntervalMs;
      source.framesRendered += 1;
      // A copy per frame: the camera provider holds the previous frame and
      // would otherwise be diffing a buffer against itself, which reads as a
      // perfectly still, perfectly confident plate.
      return { data: new Uint8ClampedArray(buffer), width, height, timestampMs };
    },
  };

  return source;
}

function boxBlur(data: Uint8ClampedArray, scratch: Uint8ClampedArray, width: number, height: number) {
  scratch.set(data);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const p = (y * width + x) * 4;
      const w = width * 4;
      const sum =
        scratch[p - w - 4] + scratch[p - w] + scratch[p - w + 4] +
        scratch[p - 4] + scratch[p] + scratch[p + 4] +
        scratch[p + w - 4] + scratch[p + w] + scratch[p + w + 4];
      const value = sum / 9;
      data[p] = value;
      data[p + 1] = value;
      data[p + 2] = value;
    }
  }
}

function clamp255(v: number) {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}
