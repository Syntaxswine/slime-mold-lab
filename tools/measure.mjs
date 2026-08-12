#!/usr/bin/env node
// Characterisation suite for the Physarum engine.
//
// Every number quoted in docs/HANDOFF.md comes from one of these sections.
// Re-run after any engine change; the operating windows are not intuitions,
// they are measurements, and they move when the engine moves.
//
//   node tools/measure.mjs              # everything
//   node tools/measure.mjs crater       # one section
//
// Sections: blocked, crater, persistence, arrival, dominance, ramp
import { readFileSync } from "node:fs";
import {
  advanceSimulation, makeSimulation, sampleField, PRESETS, GRID_W, GRID_H,
} from "../lib/physarum-engine.ts";

const PRESET_NAMES = ["forage", "reticulate", "minimal"];
const pct = (n) => `${(n * 100).toFixed(1)}%`;

/** Fraction of agents that actually move. The engine is a jammed lattice gas:
 *  a blocked agent deposits nothing and has its heading randomised, so most
 *  "turn decisions" any metric counts were never executed. */
function blocked() {
  console.log("=== move-success rate ===");
  console.log("    a blocked agent deposits nothing and its heading is discarded\n");
  for (const preset of PRESET_NAMES) {
    const s = PRESETS[preset].settings;
    const sim = makeSimulation(s.population, preset, 41721);
    for (let i = 0; i < 400; i += 1) advanceSimulation(sim, s);
    const px = new Int16Array(sim.count), py = new Int16Array(sim.count);
    let moved = 0, total = 0;
    for (let t = 0; t < 200; t += 1) {
      for (let i = 0; i < sim.count; i += 1) { px[i] = sim.x[i]; py[i] = sim.y[i]; }
      advanceSimulation(sim, s);
      for (let i = 0; i < sim.count; i += 1) {
        if (sim.x[i] !== px[i] || sim.y[i] !== py[i]) moved += 1;
        total += 1;
      }
    }
    console.log(`  ${preset.padEnd(11)} pop ${String(s.population).padStart(5)}  ` +
      `move-success ${pct(moved / total)}  blocked ${pct(1 - moved / total)}`);
  }
}

/** THE CRATER. A strong food marker packs the lattice solid; because blocked
 *  moves never deposit, the marker switches its own trail off and throughput
 *  goes to zero. This sweep is what sets the usable `level` window. */
function crater() {
  console.log("\n=== crater: a bright marker is a tomb, not a target ===");
  console.log("    landings/tick = successful moves ending inside r=6\n");
  const s = PRESETS.forage.settings;
  for (const level of [1, 0.25, 0.1, 0.06, 0.04, 0.02]) {
    const sim = makeSimulation(s.population, "forage", 4242);
    sim.markers = [{ x: 180, y: 120, kind: "food", level, radius: 7 }];
    for (let i = 0; i < 500; i += 1) advanceSimulation(sim, s);

    let occ = 0, cells = 0, trailIn = 0;
    for (let y = 104; y <= 136; y += 1) for (let x = 164; x <= 196; x += 1) {
      if ((x - 180) ** 2 + (y - 120) ** 2 > 256) continue;
      cells += 1;
      if (sim.occupancy[y * GRID_W + x] !== -1) occ += 1;
      trailIn += sim.trail[y * GRID_W + x];
    }
    const px = new Int16Array(sim.count), py = new Int16Array(sim.count);
    let land = 0;
    for (let t = 0; t < 60; t += 1) {
      for (let i = 0; i < sim.count; i += 1) { px[i] = sim.x[i]; py[i] = sim.y[i]; }
      advanceSimulation(sim, s);
      for (let i = 0; i < sim.count; i += 1) {
        if (sim.x[i] === px[i] && sim.y[i] === py[i]) continue;
        if ((sim.x[i] - 180) ** 2 + (sim.y[i] - 120) ** 2 < 36) land += 1;
      }
    }
    console.log(`  level ${String(level).padEnd(5)} peak field ${String((level * 4300 / 42).toFixed(1)).padStart(6)}  ` +
      `occupancy ${pct(occ / cells).padStart(6)}  trail inside ${(trailIn / cells).toFixed(2).padStart(5)}  ` +
      `landings/tick ${(land / 60).toFixed(2).padStart(5)}`);
  }
  console.log("\n  -> usable window is peak 2-6, i.e. level 0.02-0.06.");
}

/** Trail half-life. Governs whether an accumulated network can exist at all. */
function persistence() {
  console.log("\n=== trail persistence ===\n");
  for (const preset of PRESET_NAMES) {
    const s = PRESETS[preset].settings;
    const sim = makeSimulation(400, preset, 5);
    sim.markers = [];
    for (let i = 0; i < 120; i += 1) advanceSimulation(sim, s);
    let field = Float32Array.from(sim.trail);
    const half = Math.max(...field) / 2;
    let steps = 0;
    while (Math.max(...field) > half && steps < 500) {
      for (let i = 0; i < field.length; i += 1) field[i] *= s.decay;
      steps += 1;
    }
    const survives = 500 * Math.log10(s.decay);
    console.log(`  ${preset.padEnd(11)} decay ${s.decay}  half-life ${String(steps).padStart(2)} steps  ` +
      `(a 500-step hop leaves 10^${survives.toFixed(0)} of it)`);
  }
  console.log("\n  -> a network cannot accumulate across a long sequence on this field alone.");
}

/** What does the board's NATURAL clumping look like? Any arrival test scored
 *  against an absolute count must beat this, or it fires on empty substrate. */
function arrival() {
  console.log("\n=== background clumping (what an arrival test must beat) ===\n");
  const s = PRESETS.forage.settings;
  const sim = makeSimulation(s.population, "forage", 41721);
  sim.markers = [];
  for (let i = 0; i < 400; i += 1) advanceSimulation(sim, s);

  for (const r of [6, 8, 12]) {
    const counts = [];
    for (let t = 0; t < 300; t += 1) {
      const cx = 8 + ((t * 7919) % (GRID_W - 16));
      const cy = 8 + ((t * 104729) % (GRID_H - 16));
      let n = 0;
      for (let i = 0; i < sim.count; i += 1) {
        const rx = Math.abs(sim.x[i] - cx), ry = Math.abs(sim.y[i] - cy);
        const dx = Math.min(rx, GRID_W - rx), dy = Math.min(ry, GRID_H - ry);
        if (dx * dx + dy * dy < r * r) n += 1;
      }
      counts.push(n);
    }
    counts.sort((a, b) => a - b);
    const q = (p) => counts[Math.floor((counts.length - 1) * p)];
    console.log(`  r=${String(r).padStart(2)}  p50 ${String(q(0.5)).padStart(3)}  p90 ${String(q(0.9)).padStart(3)}  ` +
      `p99 ${String(q(0.99)).padStart(3)}  max ${String(counts[counts.length - 1]).padStart(3)}  ` +
      `(disc holds ~${Math.round(Math.PI * r * r)} cells)`);
  }
  console.log("\n  -> bimodal: you are either inside the body or nowhere near it.");
  console.log("     Score arrival as excess over this distribution, or on FLUX (see crater).");
}

/** How much of the steering is the trail the agents built, and how much is the
 *  static marker field? Compares each turn decision against the same decision
 *  computed from the trail alone. */
function dominance() {
  console.log("\n=== stigmergy vs. marker geometry ===\n");
  const decide = (f, l, r) => {
    if (f > l && f > r) return "hold";
    if (f < l && f < r) return "random";
    if (l > r) return "left";
    if (r > l) return "right";
    return "hold";
  };
  for (const preset of ["forage", "reticulate"]) {
    const s = PRESETS[preset].settings;
    const sensorAngle = (s.sensorAngle * Math.PI) / 180;
    const sim = makeSimulation(s.population, preset, 41721);
    for (let i = 0; i < 1500; i += 1) advanceSimulation(sim, s);
    const bare = { ...sim, markers: [] };

    let differ = 0, trailSpread = 0, markerSpread = 0;
    for (let i = 0; i < sim.count; i += 1) {
      const a = sim.angle[i], px = sim.x[i], py = sim.y[i];
      const at = (obj, off) => sampleField(obj,
        px + Math.cos(a + off) * s.sensorOffset,
        py + Math.sin(a + off) * s.sensorOffset);
      const full = [at(sim, 0), at(sim, -sensorAngle), at(sim, sensorAngle)];
      const only = [at(bare, 0), at(bare, -sensorAngle), at(bare, sensorAngle)];
      if (decide(...full) !== decide(...only)) differ += 1;
      trailSpread += Math.max(...only) - Math.min(...only);
      markerSpread += Math.abs((Math.max(...full) - Math.min(...full)) -
                               (Math.max(...only) - Math.min(...only)));
    }
    console.log(`  ${preset.padEnd(11)} decisions set by the marker field: ${pct(differ / sim.count).padStart(6)}   ` +
      `mean sensor spread - trail ${(trailSpread / sim.count).toFixed(2)}, marker ${(markerSpread / sim.count).toFixed(2)}`);
  }
  console.log("\n  -> marker-driven behaviour is not emergent behaviour. OPEN ISSUE.");
}

/** Is the render ramp calibrated against the field the sim actually produces? */
function ramp() {
  console.log("\n=== trail distribution vs. the render ramp ===\n");
  const page = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
  const m = page.match(/1 - Math\.exp\(-sim\.trail\[i\] \* ([\d.]+)\)/);
  const k = m ? Number(m[1]) : null;
  console.log(`  ramp coefficient in app/page.tsx: ${k ?? "NOT FOUND"}\n`);

  for (const preset of PRESET_NAMES) {
    const s = PRESETS[preset].settings;
    const sim = makeSimulation(s.population, preset, 41721);
    for (let i = 0; i < 1500; i += 1) advanceSimulation(sim, s);
    const t = Float32Array.from(sim.trail).sort();
    const q = (p) => t[Math.floor((t.length - 1) * p)];
    console.log(`  ${preset.padEnd(11)} p50 ${q(0.5).toFixed(2)}  p90 ${q(0.9).toFixed(2)}  ` +
      `p99 ${q(0.99).toFixed(2)}  max ${t[t.length - 1].toFixed(1)}`);
  }
  if (k) {
    console.log("\n  red channel at that ramp (plate is 9):");
    for (const tr of [0.5, 2, 3, 6, 12, 20]) {
      const v = Math.min(1, 1 - Math.exp(-tr * k));
      console.log(`    trail ${String(tr).padStart(4)} -> ${Math.round(8 + v * 176)}`);
    }
  }
}

const SECTIONS = { blocked, crater, persistence, arrival, dominance, ramp };
const want = process.argv[2];
if (want && !SECTIONS[want]) {
  console.error(`unknown section "${want}". one of: ${Object.keys(SECTIONS).join(", ")}`);
  process.exit(1);
}
for (const [name, fn] of Object.entries(SECTIONS)) {
  if (!want || want === name) fn();
}
