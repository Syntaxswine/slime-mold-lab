#!/usr/bin/env node
// Headless renderer: runs the engine and writes a PNG through app/page.tsx's
// exact pixel mapping, reading the ramp coefficient out of the source so the
// image can never drift from what the app draws.
//
// This exists because the browser preview pane does not composite when hidden,
// so requestAnimationFrame never fires and the canvas stays at T+00000. If you
// need to SEE the simulation from a terminal, this is how.
//
//   node tools/render.mjs                              # all presets, 1500 steps
//   node tools/render.mjs --preset reticulate --steps 3000 --out ./shots
//   node tools/render.mjs --light 180,120,23           # place a light disc mid-run
import { deflateSync } from "node:zlib";
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import {
  advanceSimulation, makeSimulation, addMarker, PRESETS, GRID_W, GRID_H,
} from "../lib/physarum-engine.ts";

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const OUT = arg("out", ".");
const STEPS = Number(arg("steps", 1500));
const SCALE = Number(arg("scale", 3));
const PRESET = arg("preset", null);
const LIGHT = arg("light", null);

const RAMP = Number(
  readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8")
    .match(/1 - Math\.exp\(-sim\.trail\[i\] \* ([\d.]+)\)/)[1],
);

// ---- minimal PNG encoder (truecolour, no deps) ----------------------------
const CRC = (() => {
  const t = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let crc = 0xffffffff;
  for (const b of buf) crc = CRC[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, c]);
}
function writePng(path, w, h, rgb) {
  const raw = Buffer.alloc(h * (w * 3 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  writeFileSync(path, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]));
}

// ---- app/page.tsx's pixel mapping, verbatim (frame 0) ---------------------
function paint(sim) {
  const W = GRID_W * SCALE, H = GRID_H * SCALE;
  const rgb = Buffer.alloc(W * H * 3);
  for (let i = 0; i < sim.trail.length; i += 1) {
    const intensity = 1 - Math.exp(-sim.trail[i] * RAMP);
    const x = i % GRID_W, y = (i / GRID_W) | 0;
    const wave = 0.9 + 0.1 * Math.sin(x * 0.095 - y * 0.07);
    const v = Math.min(1, intensity * wave);
    const occupied = sim.occupancy[i] !== -1;
    const r = occupied ? 247 : 8 + v * 176;
    const g = occupied ? 132 : 10 + v * (72 + v * 25);
    const b = occupied ? 48 : 11 + v * (18 + v * 15);
    for (let dy = 0; dy < SCALE; dy++) for (let dx = 0; dx < SCALE; dx++) {
      const p = ((y * SCALE + dy) * W + (x * SCALE + dx)) * 3;
      rgb[p] = r; rgb[p + 1] = g; rgb[p + 2] = b;
    }
  }
  return { rgb, W, H };
}

mkdirSync(OUT, { recursive: true });
console.log(`ramp ${RAMP} (read from app/page.tsx), ${STEPS} steps, scale ${SCALE}x`);

for (const preset of PRESET ? [PRESET] : ["forage", "reticulate", "minimal"]) {
  const s = PRESETS[preset].settings;
  const sim = makeSimulation(s.population, preset, 41721);

  if (LIGHT) {
    const [lx, ly, lr] = LIGHT.split(",").map(Number);
    for (let i = 0; i < Math.min(400, STEPS); i += 1) advanceSimulation(sim, s);
    addMarker(sim, { x: lx, y: ly, kind: "light", level: 1, radius: lr });
    console.log(`  light disc placed at (${lx},${ly}) r=${lr} at t=${sim.tick}`);
  }
  while (sim.tick < STEPS) advanceSimulation(sim, s);

  const { rgb, W, H } = paint(sim);
  const name = `${preset}${LIGHT ? "-light" : ""}.png`;
  writePng(`${OUT}/${name}`, W, H, rgb);
  console.log(`  wrote ${name}  (t=${sim.tick}, coverage ${sim.coverage.toFixed(1)}%)`);
}
