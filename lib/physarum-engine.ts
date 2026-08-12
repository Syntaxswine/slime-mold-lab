export const GRID_W = 360;
export const GRID_H = 240;
export const MAX_AGENTS = 18_000;
export const MAX_MARKERS = 14;
export const TAU = Math.PI * 2;

export type Marker = {
  x: number;
  y: number;
  kind: "food" | "light";
  level: number;
  radius: number;
};

export type Simulation = {
  x: Int16Array;
  y: Int16Array;
  angle: Float32Array;
  trail: Float32Array;
  scratch: Float32Array;
  occupancy: Int32Array;
  order: Uint32Array;
  count: number;
  tick: number;
  seed: number;
  random: () => number;
  markers: Marker[];
  coverage: number;
};

export type Settings = {
  population: number;
  sensorAngle: number;
  turnAngle: number;
  sensorOffset: number;
  decay: number;
  deposit: number;
  wander: number;
  speed: number;
};

export type PresetId = "forage" | "reticulate" | "minimal";

export const PRESETS: Record<
  PresetId,
  { label: string; note: string; settings: Settings }
> = {
  forage: {
    label: "Foraging front",
    note: "A compact inoculum explores nutrient gradients.",
    settings: {
      population: 7_500,
      sensorAngle: 22.5,
      turnAngle: 45,
      sensorOffset: 9,
      decay: 0.915,
      deposit: 5,
      wander: 0.13,
      speed: 2,
    },
  },
  reticulate: {
    label: "Reticulate mesh",
    note: "A broad inoculation condenses into a porous network.",
    settings: {
      population: 12_000,
      sensorAngle: 45,
      turnAngle: 45,
      sensorOffset: 9,
      decay: 0.945,
      deposit: 5,
      wander: 0.09,
      speed: 2,
    },
  },
  minimal: {
    label: "Sparse transport",
    note: "Rapid trail loss favors fewer persistent paths.",
    settings: {
      population: 8_500,
      sensorAngle: 22.5,
      turnAngle: 45,
      sensorOffset: 12,
      decay: 0.885,
      deposit: 5,
      wander: 0.07,
      speed: 2,
    },
  },
};

export function mulberry32(seed: number) {
  return () => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function defaultMarkers(preset: PresetId): Marker[] {
  if (preset === "reticulate") {
    return [
      { x: 54, y: 46, kind: "food", level: 1, radius: 7 },
      { x: 301, y: 48, kind: "food", level: 1, radius: 7 },
      { x: 310, y: 193, kind: "food", level: 1, radius: 7 },
      { x: 49, y: 190, kind: "food", level: 1, radius: 7 },
      { x: 180, y: 120, kind: "food", level: 1, radius: 7 },
    ];
  }
  if (preset === "minimal") {
    return [
      { x: 52, y: 54, kind: "food", level: 1, radius: 8 },
      { x: 302, y: 48, kind: "food", level: 1, radius: 8 },
      { x: 310, y: 188, kind: "food", level: 1, radius: 8 },
      { x: 58, y: 194, kind: "food", level: 1, radius: 8 },
      { x: 180, y: 120, kind: "food", level: 1, radius: 8 },
      { x: 180, y: 72, kind: "light", level: 1, radius: 21 },
    ];
  }
  return [
    { x: 58, y: 49, kind: "food", level: 1, radius: 8 },
    { x: 302, y: 51, kind: "food", level: 1, radius: 8 },
    { x: 310, y: 188, kind: "food", level: 1, radius: 8 },
    { x: 61, y: 190, kind: "food", level: 1, radius: 8 },
    { x: 272, y: 118, kind: "light", level: 1, radius: 24 },
  ];
}

function findOpenCell(
  simulation: Simulation,
  preset: PresetId,
  index: number,
): [number, number] {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    let x: number;
    let y: number;
    if (preset === "reticulate") {
      x = 12 + Math.floor(simulation.random() * (GRID_W - 24));
      y = 12 + Math.floor(simulation.random() * (GRID_H - 24));
    } else {
      const targetDensity = 0.56;
      const radiusLimit = Math.sqrt(simulation.count / (Math.PI * targetDensity));
      const theta = simulation.random() * TAU;
      const radius = Math.sqrt(simulation.random()) * radiusLimit;
      x = Math.round(GRID_W / 2 + Math.cos(theta) * radius);
      y = Math.round(GRID_H / 2 + Math.sin(theta) * radius);
    }
    x = Math.max(0, Math.min(GRID_W - 1, x));
    y = Math.max(0, Math.min(GRID_H - 1, y));
    if (simulation.occupancy[y * GRID_W + x] === -1) return [x, y];
  }

  // Deterministic fallback guarantees an available site without overlap.
  let cell = (index * 7919) % (GRID_W * GRID_H);
  while (simulation.occupancy[cell] !== -1) cell = (cell + 1) % simulation.occupancy.length;
  return [cell % GRID_W, Math.floor(cell / GRID_W)];
}

export function makeSimulation(count: number, preset: PresetId, seed: number): Simulation {
  const safeCount = Math.min(MAX_AGENTS, Math.max(1, Math.round(count)));
  const simulation: Simulation = {
    x: new Int16Array(MAX_AGENTS),
    y: new Int16Array(MAX_AGENTS),
    angle: new Float32Array(MAX_AGENTS),
    trail: new Float32Array(GRID_W * GRID_H),
    scratch: new Float32Array(GRID_W * GRID_H),
    occupancy: new Int32Array(GRID_W * GRID_H),
    order: new Uint32Array(MAX_AGENTS),
    count: safeCount,
    tick: 0,
    seed,
    random: mulberry32(seed),
    markers: defaultMarkers(preset),
    coverage: 0,
  };
  simulation.occupancy.fill(-1);

  for (let i = 0; i < safeCount; i += 1) {
    const [x, y] = findOpenCell(simulation, preset, i);
    simulation.x[i] = x;
    simulation.y[i] = y;
    simulation.angle[i] = simulation.random() * TAU;
    simulation.occupancy[y * GRID_W + x] = i;
    simulation.order[i] = i;
  }
  return simulation;
}

export function addMarker(simulation: Simulation, marker: Marker) {
  simulation.markers.push(marker);
  if (simulation.markers.length > MAX_MARKERS) {
    simulation.markers.splice(0, simulation.markers.length - MAX_MARKERS);
  }
}

export function resizePopulation(simulation: Simulation, nextCount: number) {
  const safeCount = Math.min(MAX_AGENTS, Math.max(1, Math.round(nextCount)));
  const previousCount = simulation.count;
  if (safeCount < previousCount) {
    for (let i = safeCount; i < previousCount; i += 1) {
      simulation.occupancy[simulation.y[i] * GRID_W + simulation.x[i]] = -1;
    }
  } else if (safeCount > previousCount) {
    simulation.count = safeCount;
    for (let i = previousCount; i < safeCount; i += 1) {
      const [x, y] = findOpenCell(simulation, "reticulate", i);
      simulation.x[i] = x;
      simulation.y[i] = y;
      simulation.angle[i] = simulation.random() * TAU;
      simulation.occupancy[y * GRID_W + x] = i;
      simulation.order[i] = i;
    }
  }
  simulation.count = safeCount;
  for (let i = 0; i < safeCount; i += 1) simulation.order[i] = i;
}

/** Squared distance to a marker across the periodic lattice. */
function wrappedD2(marker: Marker, x: number, y: number) {
  const rawDx = Math.abs(x - marker.x);
  const rawDy = Math.abs(y - marker.y);
  const dx = Math.min(rawDx, GRID_W - rawDx);
  const dy = Math.min(rawDy, GRID_H - rawDy);
  return dx * dx + dy * dy;
}

function insideMarker(marker: Marker, x: number, y: number) {
  return wrappedD2(marker, x, y) < marker.radius * marker.radius;
}

export function sampleField(simulation: Simulation, x: number, y: number) {
  const xi = ((Math.round(x) % GRID_W) + GRID_W) % GRID_W;
  const yi = ((Math.round(y) % GRID_H) + GRID_H) % GRID_H;
  let value = simulation.trail[yi * GRID_W + xi];

  for (const marker of simulation.markers) {
    const d2 = wrappedD2(marker, xi, yi);
    // Explicit visual-model extensions: positive food and negative light fields.
    if (marker.kind === "food" && marker.level > 0.015) {
      value += (marker.level * 4300) / (d2 + 42);
    } else if (marker.kind === "light") {
      value -= (marker.level * 8500) / (d2 + 65);
    }
  }
  return value;
}

export function advanceSimulation(simulation: Simulation, settings: Settings) {
  const sensorAngle = (settings.sensorAngle * Math.PI) / 180;
  const turnAngle = (settings.turnAngle * Math.PI) / 180;

  // A true Fisher–Yates permutation implements the randomized Jones scheduler.
  for (let i = simulation.count - 1; i > 0; i -= 1) {
    const j = Math.floor(simulation.random() * (i + 1));
    const swap = simulation.order[i];
    simulation.order[i] = simulation.order[j];
    simulation.order[j] = swap;
  }

  for (let n = 0; n < simulation.count; n += 1) {
    const i = simulation.order[n];
    let angle = simulation.angle[i];
    const px = simulation.x[i];
    const py = simulation.y[i];
    const sense = (offset: number) => {
      const a = angle + offset;
      return sampleField(
        simulation,
        px + Math.cos(a) * settings.sensorOffset,
        py + Math.sin(a) * settings.sensorOffset,
      );
    };

    const forward = sense(0);
    const left = sense(-sensorAngle);
    const right = sense(sensorAngle);
    // Jones 2010 §2.1. `forwardBest` is load-bearing: without it an agent
    // heading straight up-gradient falls through to the flank comparison and
    // rotates away from its best sample, so no agent can ever hold a heading
    // and veins never consolidate. It is spelled out as a named condition
    // rather than an empty leading branch so that nothing downstream — a
    // minifier, a no-empty autofix — can quietly collapse the chain and put
    // the defect back. The two cases are mutually exclusive by construction.
    const forwardBest = forward > left && forward > right;
    const forwardWorst = forward < left && forward < right;
    if (forwardWorst) {
      angle += simulation.random() < 0.5 ? -turnAngle : turnAngle;
    } else if (!forwardBest && left > right) {
      angle -= turnAngle;
    } else if (!forwardBest && right > left) {
      angle += turnAngle;
    }
    angle += (simulation.random() - 0.5) * settings.wander;

    // The lattice is periodic. Only a move into an unoccupied site succeeds.
    const nx = ((Math.round(px + Math.cos(angle)) % GRID_W) + GRID_W) % GRID_W;
    const ny = ((Math.round(py + Math.sin(angle)) % GRID_H) + GRID_H) % GRID_H;
    const nextCell = ny * GRID_W + nx;
    let blocked = simulation.occupancy[nextCell] !== -1;

    for (const marker of simulation.markers) {
      if (marker.kind !== "light") continue;
      // A light disc is a barrier to entry, not a cage. An agent that was
      // already standing inside one when it was placed must be able to walk
      // back out: the radius is many cells wide and a step is one cell, so
      // testing the destination alone rejects every escape route and freezes
      // the agent in place forever.
      if (insideMarker(marker, px, py)) continue;
      if (insideMarker(marker, nx, ny)) {
        blocked = true;
        break;
      }
    }

    if (blocked) {
      simulation.angle[i] = simulation.random() * TAU;
      continue;
    }

    simulation.occupancy[py * GRID_W + px] = -1;
    simulation.occupancy[nextCell] = i;
    simulation.x[i] = nx;
    simulation.y[i] = ny;
    simulation.angle[i] = angle;
    simulation.trail[nextCell] = Math.min(90, simulation.trail[nextCell] + settings.deposit);

    for (const marker of simulation.markers) {
      if (marker.kind !== "food") continue;
      if (insideMarker(marker, nx, ny)) {
        marker.level = Math.max(0, marker.level - 0.0000012);
      }
    }
  }

  const source = simulation.trail;
  const target = simulation.scratch;
  for (let y = 0; y < GRID_H; y += 1) {
    const ym = (y + GRID_H - 1) % GRID_H;
    const yp = (y + 1) % GRID_H;
    for (let x = 0; x < GRID_W; x += 1) {
      const xm = (x + GRID_W - 1) % GRID_W;
      const xp = (x + 1) % GRID_W;
      const i = y * GRID_W + x;
      target[i] =
        ((source[ym * GRID_W + xm] +
          source[ym * GRID_W + x] +
          source[ym * GRID_W + xp] +
          source[y * GRID_W + xm] +
          source[i] +
          source[y * GRID_W + xp] +
          source[yp * GRID_W + xm] +
          source[yp * GRID_W + x] +
          source[yp * GRID_W + xp]) /
          9) *
        settings.decay;
    }
  }
  simulation.trail = target;
  simulation.scratch = source;
  simulation.tick += 1;

  if (simulation.tick % 30 === 0) {
    let occupiedField = 0;
    for (let i = 0; i < simulation.trail.length; i += 6) {
      if (simulation.trail[i] > 0.9) occupiedField += 1;
    }
    simulation.coverage = (occupiedField / (simulation.trail.length / 6)) * 100;
  }
}
