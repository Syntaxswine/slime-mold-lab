/**
 * Living Weights — the Physarum engine as an eight-channel signal provider.
 *
 * The brief proposes eight sliders for Phase 1. Sliders are here too (see
 * `sliders.ts`), as the control arm, but they are the wrong thing to build
 * against: a slider has no jamming, no 8-step trail half-life, and no body
 * that can only be in one place at a time. Build the loop against those
 * properties now and Phase 2 is a swap; build it against sliders and Phase 2
 * is a rewrite.
 */
import {
  advanceSimulation,
  GRID_H,
  GRID_W,
  makeSimulation,
  PRESETS,
  type Marker,
  type PresetId,
  type Simulation,
} from "../../physarum-engine.ts";
import type { MoldSignalProvider, Signal } from "../types.ts";

export type MoldProviderConfig = {
  seed: number;
  preset: PresetId;
  channelCount: number;
  /** Channels sit on a ring so every one is the same distance from the inoculum. */
  ringRadius: number;
  /**
   * Rotation of the ring, in degrees.
   *
   * 0, and that is the measured answer rather than the reasoned one. The
   * culture grows lobes locked to the lattice, so at radius 80 the eight sites
   * split into two classes the lattice treats differently -- 19-21 mean flux on
   * the axes against 9-11 on the diagonals -- and rotating by half a sector
   * fixes it, because 22.5 + k*45 is a single orbit of the lattice point group.
   * At radius 45 that reasoning simply does not apply: the lobe structure is
   * much weaker near the core (angular CV 0.21 against 0.70 at r=85) and the
   * rotation makes fairness worse, not better -- bias 0.35 at phase 0 against
   * 0.62 at 22.5, measured the same way over five seeds.
   *
   * Kept as a knob because the right value tracks the radius. If you move the
   * ring out, re-run `node tools/weights.mjs channels` and read the bias line;
   * do not carry this default with you.
   */
  ringPhaseDegrees: number;
  centerX: number;
  centerY: number;
  /** Radius of the food disc itself. */
  markerRadius: number;
  /** Radius over which landings are counted. Larger than the disc on purpose. */
  detectRadius: number;
  /**
   * Food strength at each channel site, or 0 for passive channels.
   *
   * 0 is the default and it is not a shortcut. Baiting a channel measures our
   * own stimulus, not the organism: each disc servos its own patch to the same
   * saturation and the between-channel structure collapses. Measured over 20
   * reads, sd/noise falls from 11-14 (passive) to about 2 (baited) and the
   * leading channel stops persisting. A passive region is also the honest
   * Phase 2 analogue, because an electrode does not feed the culture.
   *
   * If you do bait them, the usable window is 0.02-0.06: sampleField ignores
   * food below 0.015, and above about 0.06 the disc packs solid, stops
   * accepting landings, and reads as a dead sensor forever (HANDOFF.md 3).
   */
  level: number;
  /**
   * Ticks per full orbit of a light disc around the centre, or 0 for none.
   *
   * Off by default, and that is a measured decision rather than a simpler one.
   * A moving light was meant to stop the network consolidating, since under
   * the reticulate preset the number of distinct leading channels falls to 2
   * over 2700 ticks. It does not work: stirring the culture drives it off the
   * ring faster than it re-forms, and mean channel flux over the last third of
   * a run falls from 12.6 (no light) to 2.6 (orbit 900) — the organism goes
   * quiet instead of changing its mind. Kept because it is the right hook for
   * a Phase 3 installation that wants a visible lamp, but it costs signal.
   */
  lightOrbitTicks: number;
  lightOrbitRadius: number;
  lightRadius: number;
  /**
   * Ticks to live through before the first reading is taken.
   *
   * A freshly inoculated plate has nothing to say and says it at full volume.
   * Measured across five seeds, the between-channel spread of a single read is
   * indistinguishable from Poisson counting noise until about tick 200:
   *
   *     warmup     0   sd/noise 0.6 - 1.4     (noise)
   *     warmup   200   sd/noise 4.6 - 7.2
   *     warmup   400   sd/noise 7.2 - 11.5
   *
   * Without this the opening sentence of every run is driven by nothing, at
   * whatever gain the operator set, and the confidence rail does not catch it
   * because an undifferentiated culture still has a wide absolute spread.
   * Reading a plate the moment you inoculate it was never the protocol.
   */
  warmupTicks: number;
  /** Ticks of integration at which a reading is fully trusted. */
  qualityTicks: number;
  /** Flux (landings/tick) mapped to value 1.0. Display only; raw is the truth. */
  valueScale: number;
};

export const DEFAULT_MOLD_CONFIG: MoldProviderConfig = {
  seed: 20260811,
  preset: "forage",
  channelCount: 8,
  ringRadius: 45,
  ringPhaseDegrees: 0,
  centerX: GRID_W / 2,
  centerY: GRID_H / 2,
  markerRadius: 7,
  detectRadius: 12,
  level: 0,
  warmupTicks: 400,
  lightOrbitTicks: 0,
  lightOrbitRadius: 45,
  lightRadius: 22,
  qualityTicks: 15,
  valueScale: 80,
};

/**
 * Eight sites on a circle of radius 80 about the centre of a 360 x 240 torus.
 *
 * Neither the radius nor the phase is free. The lattice wraps, so a ring placed
 * much wider folds the top and bottom channels into each other: at r = 80 and
 * phase 22.5 the adjacent spacing is 61 cells and the tightest wrapped pair is
 * 92, so the ring order is the true neighbour order. A square arrangement of
 * eight sites would be tidier on the torus but would sit at two different
 * distances from a central inoculum, and then geometry, not the organism,
 * decides which words win. See `ringPhaseDegrees` for the other half of that.
 */
export function channelSites(config: MoldProviderConfig): { x: number; y: number }[] {
  const sites = [];
  for (let i = 0; i < config.channelCount; i += 1) {
    const theta =
      (i / config.channelCount) * Math.PI * 2 + (config.ringPhaseDegrees * Math.PI) / 180;
    sites.push({
      x: wrap(config.centerX + Math.cos(theta) * config.ringRadius, GRID_W),
      y: wrap(config.centerY + Math.sin(theta) * config.ringRadius, GRID_H),
    });
  }
  return sites;
}

export type MoldProvider = MoldSignalProvider & {
  simulation: Simulation;
  sites: { x: number; y: number }[];
  moldConfig: MoldProviderConfig;
};

export function makeMoldProvider(overrides: Partial<MoldProviderConfig> = {}): MoldProvider {
  const config: MoldProviderConfig = { ...DEFAULT_MOLD_CONFIG, ...overrides };
  const settings = PRESETS[config.preset].settings;
  const sites = channelSites(config);

  let simulation = makeSimulation(settings.population, config.preset, config.seed);
  let landings = new Float64Array(config.channelCount);
  let ticks = 0;
  const prevX = new Int16Array(simulation.count);
  const prevY = new Int16Array(simulation.count);

  /**
   * Rebuild the marker list from scratch each tick.
   *
   * Assigned directly, never through addMarker: MAX_MARKERS is 14 and
   * addMarker evicts from the FRONT, so routing eight channels plus a moving
   * light plus a preset's own five defaults through it silently drops
   * channels. Rebuilding also re-asserts food level, which landings otherwise
   * deplete by 1.2e-6 each until the channel drops below the 0.015 field
   * cutoff and dies mid-run for no reason the piece can see. Channels are
   * stimuli, not lunch.
   */
  const install = () => {
    const markers: Marker[] = [];
    if (config.level > 0) {
      for (const site of sites) {
        markers.push({
          x: site.x,
          y: site.y,
          kind: "food",
          level: config.level,
          radius: config.markerRadius,
        });
      }
    }
    if (config.lightOrbitTicks > 0) {
      const theta = (simulation.tick / config.lightOrbitTicks) * Math.PI * 2;
      markers.push({
        x: wrap(config.centerX + Math.cos(theta) * config.lightOrbitRadius, GRID_W),
        y: wrap(config.centerY + Math.sin(theta) * config.lightOrbitRadius, GRID_H),
        kind: "light",
        level: 1,
        radius: config.lightRadius,
      });
    }
    simulation.markers = markers;
  };
  install();

  const provider: MoldProvider = {
    id: "physarum-jones-2010",
    config: config as unknown as Record<string, unknown>,
    channelCount: config.channelCount,
    simulation,
    sites,
    moldConfig: config,

    advance(steps: number) {
      const detect2 = config.detectRadius * config.detectRadius;
      for (let t = 0; t < steps; t += 1) {
        for (let i = 0; i < simulation.count; i += 1) {
          prevX[i] = simulation.x[i];
          prevY[i] = simulation.y[i];
        }
        install();

        advanceSimulation(simulation, settings);

        for (let i = 0; i < simulation.count; i += 1) {
          if (simulation.x[i] === prevX[i] && simulation.y[i] === prevY[i]) continue;
          for (let c = 0; c < sites.length; c += 1) {
            if (wrappedD2(sites[c].x, sites[c].y, simulation.x[i], simulation.y[i]) < detect2) {
              landings[c] += 1;
              break;
            }
          }
        }
        ticks += 1;
      }
      return simulation.tick;
    },

    readSignals(candidateCount: number): Signal[] {
      const served = Math.min(candidateCount, config.channelCount);
      const quality = clamp01(ticks / config.qualityTicks);
      const out: Signal[] = [];
      for (let c = 0; c < served; c += 1) {
        // Flux, not proximity. Proximity is near-binary on this lattice and
        // fires on empty substrate 13% of the time; flux is the quantity that
        // separates a fed channel from a jammed one.
        const raw = ticks > 0 ? landings[c] / ticks : 0;
        out.push({
          channel: c,
          value: clamp01(raw / config.valueScale),
          raw,
          timestamp: simulation.tick,
          quality,
        });
      }
      landings = new Float64Array(config.channelCount);
      ticks = 0;
      return out;
    },

    reset() {
      simulation = makeSimulation(settings.population, config.preset, config.seed);
      provider.simulation = simulation;
      install();
      landings = new Float64Array(config.channelCount);
      ticks = 0;
      warm();
    },
  };

  /** Live through the warmup and throw the readings away. */
  function warm() {
    if (config.warmupTicks <= 0) return;
    provider.advance(config.warmupTicks);
    landings = new Float64Array(config.channelCount);
    ticks = 0;
  }
  warm();

  return provider;
}

/** Occupancy fraction inside each detection disc. Diagnostics and the UI overlay. */
export function channelOccupancy(
  simulation: Simulation,
  sites: { x: number; y: number }[],
  detectRadius: number,
): number[] {
  const detect2 = detectRadius * detectRadius;
  return sites.map((site) => {
    let cells = 0;
    let taken = 0;
    for (let dy = -detectRadius; dy <= detectRadius; dy += 1) {
      for (let dx = -detectRadius; dx <= detectRadius; dx += 1) {
        if (dx * dx + dy * dy >= detect2) continue;
        const x = wrap(site.x + dx, GRID_W);
        const y = wrap(site.y + dy, GRID_H);
        cells += 1;
        if (simulation.occupancy[y * GRID_W + x] !== -1) taken += 1;
      }
    }
    return cells === 0 ? 0 : taken / cells;
  });
}

function wrappedD2(ax: number, ay: number, bx: number, by: number) {
  const rawDx = Math.abs(ax - bx);
  const rawDy = Math.abs(ay - by);
  const dx = Math.min(rawDx, GRID_W - rawDx);
  const dy = Math.min(rawDy, GRID_H - rawDy);
  return dx * dx + dy * dy;
}

function wrap(v: number, n: number) {
  return ((Math.round(v) % n) + n) % n;
}

function clamp01(v: number) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
