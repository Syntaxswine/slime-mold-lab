/**
 * Living Weights — the control arm.
 *
 * Eight channels with no organism behind them: either driven by hand from the
 * interface, or by a slow deterministic drift with no spatial structure at all.
 *
 * Its job is to be the null. Any claim that the culture bent a sentence has to
 * survive the same run driven by this, and "the text got stranger" is not that
 * evidence — smooth drift will also make text stranger. What this provider
 * cannot do is jam, consolidate, or be in one place, so it is the comparison
 * that separates the organism's dynamics from the mere fact of perturbation.
 */
import { mulberry32 } from "../../physarum-engine.ts";
import type { MoldSignalProvider, Signal } from "../types.ts";

export type SliderProviderConfig = {
  seed: number;
  channelCount: number;
  /** Ticks per cycle of the slowest component. */
  period: number;
  /** Same units as the mold provider's flux, so gains transfer between them. */
  amplitude: number;
  offset: number;
  qualityTicks: number;
  valueScale: number;
};

export const DEFAULT_SLIDER_CONFIG: SliderProviderConfig = {
  seed: 7,
  channelCount: 8,
  period: 900,
  amplitude: 14,
  offset: 15,
  qualityTicks: 15,
  valueScale: 30,
};

export type SliderProvider = MoldSignalProvider & {
  /** Live control. A held value overrides the drift until released. */
  hold(channel: number, raw: number | null): void;
  clock: number;
};

export function makeSliderProvider(
  overrides: Partial<SliderProviderConfig> = {},
): SliderProvider {
  const config: SliderProviderConfig = { ...DEFAULT_SLIDER_CONFIG, ...overrides };
  const random = mulberry32(config.seed);
  // Incommensurate periods so the bank never returns to a previous state.
  const phase = Array.from({ length: config.channelCount }, () => random() * Math.PI * 2);
  const rate = Array.from({ length: config.channelCount }, () => 0.6 + random() * 0.9);
  const held: (number | null)[] = Array.from({ length: config.channelCount }, () => null);

  let clock = 0;
  let ticks = 0;

  const drift = (channel: number, t: number) => {
    const w = (Math.PI * 2) / config.period;
    const a = Math.sin(t * w * rate[channel] + phase[channel]);
    const b = Math.sin(t * w * rate[channel] * 2.7 + phase[channel] * 1.7) * 0.4;
    return Math.max(0, config.offset + (a + b) * config.amplitude);
  };

  const provider: SliderProvider = {
    id: "sliders-null",
    config: config as unknown as Record<string, unknown>,
    channelCount: config.channelCount,
    clock: 0,

    hold(channel: number, raw: number | null) {
      if (channel >= 0 && channel < config.channelCount) held[channel] = raw;
    },

    advance(steps: number) {
      clock += steps;
      ticks += steps;
      provider.clock = clock;
      return clock;
    },

    readSignals(candidateCount: number): Signal[] {
      const served = Math.min(candidateCount, config.channelCount);
      const quality = clamp01(ticks / config.qualityTicks);
      const out: Signal[] = [];
      for (let c = 0; c < served; c += 1) {
        const raw = held[c] ?? drift(c, clock);
        out.push({
          channel: c,
          value: clamp01(raw / config.valueScale),
          raw,
          timestamp: clock,
          quality,
        });
      }
      ticks = 0;
      return out;
    },

    reset() {
      clock = 0;
      ticks = 0;
      provider.clock = 0;
      for (let c = 0; c < config.channelCount; c += 1) held[c] = null;
    },
  };

  return provider;
}

function clamp01(v: number) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
