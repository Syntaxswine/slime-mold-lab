#!/usr/bin/env node
/**
 * The culture draws what the flow decided.
 *
 * `tools/wordsearch.mjs` says which cells of the puzzle are on a supply chain
 * from the word's first letter to its last. It says it in conductances, which
 * are numbers. This turns them back into a plate: the puzzle printed as food,
 * a plasmodium inoculated over the whole of it, and the letters that stop
 * being supplied losing their tissue while the answer keeps its own.
 *
 * WHAT EACH HALF DOES. Worth being exact, because it would be easy to overclaim
 * in either direction.
 *
 *   The flow solve decides WHICH cells are worth holding. It is Tero's
 *   adaptation on the letter graph and it is not negotiable by the culture.
 *   The culture decides WHERE THE TISSUE GOES and draws the tubes between the
 *   cells. Nothing tells the agents where a chain is; they are the Jones 2010
 *   sensor-and-turn agents from `lib/physarum-engine.ts`, following an
 *   attractant field, and the line they lay between two letters is theirs.
 *
 * That is the arrangement in Tero et al.'s own Tokyo experiment: the food goes
 * where the cities are, and the organism draws the network. Here the food goes
 * where the supply chain is, and the organism draws the word.
 *
 * THE ONE COUPLING. A cell's attractant is its live supply — the largest
 * conductance of any tube meeting it — not a fixed flake. This is the owner's
 * supply-chain framing taken literally: a cell on a live tube is being fed from
 * the chain and holds tissue; a cell on a reabsorbed tube has nothing arriving
 * and cannot. The scale is chosen so the engine's own attention threshold does
 * the killing: `sampleField` ignores food below level 0.015, so at 0.09 per
 * unit of conductance a cell goes invisible to the agents at D < 0.167, and
 * the Tero solve crosses that line at about step 6 for the losers and never
 * for the answer, which converges to D = 0.5 -> level 0.045, the middle of the
 * measured usable food window of 0.02-0.06.
 *
 * WHERE THE TIME GOES. The solve converges in about 30 steps and then holds:
 * 55 candidate cells for VACATION at step 0, 21 by step 12, 14 by step 20, the
 * 8 true cells from step 30 onward. So the film spreads those first 40 steps
 * across the middle of the run and holds the rest, or the whole thing would be
 * over before the culture had finished arriving.
 *
 *     colonise    network frozen at step 0, every letter fed, culture spreads
 *     adapt       one Tero step every --adaptEvery ticks, food follows supply
 *     settle      converged; the tissue that is left is the print
 *
 * SCARS. A cell that was supplied and then fell below the attention threshold
 * leaves an aversion disc behind it. That is Reid, Latty, Dussutour & Beekman
 * (2012), PNAS 109(43):17490: the plasmodium uses its own extracellular slime
 * as externalised spatial memory and avoids it — coat an arena uniformly and
 * goal-finding collapses from 96% to 33%. It is what makes the FAILED search
 * legible in the finished plate, which was the point of the idea. Level 0.012,
 * from the measured window of 0.008-0.02: weaker than food, because there are
 * far more scars than baits and at level 1 the culture is a puppet walking
 * someone else's maze.
 *
 *   node tools/wordsearch-plate-flow.mjs --word VACATION
 *   node tools/wordsearch-plate-flow.mjs --word VACATION --control
 */
import { mkdirSync } from "node:fs";
import {
  advanceSimulation,
  makeSimulation,
  GRID_H,
  GRID_W,
  PRESETS,
} from "../lib/physarum-engine.ts";
import { writePng } from "./png.mjs";
import { GRID, H, W, adapt, supply, trueRun } from "./wordsearch-flow.mjs";

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const WORD = arg("word", "VACATION").toUpperCase();
const OUT = arg("out", "work/wordsearch");
const FRAMES = Number(arg("frames", 24));
const SEED = Number(arg("seed", 4242));
const SCALE = Number(arg("scale", 3));

const COLONISE = Number(arg("colonise", 300));
const ADAPT_STEPS = Number(arg("adaptSteps", 40));
const ADAPT_EVERY = Number(arg("adaptEvery", 12));
const SETTLE = Number(arg("settle", 320));
/**
 * Hold the network at step 0 forever: every letter of the word stays fed, and
 * nothing is ever reabsorbed. The control arm. If the finished plate looks the
 * same with this on, the flow is not doing the work and the contrast being
 * reported is a property of the letter frequencies, not of the search.
 */
const CONTROL = argv.includes("--control");

/** Attractant per unit conductance. See the header: 0.015 and 0.06 set it. */
const FOOD_SCALE = Number(arg("foodScale", 0.09));
const FOOD_CEILING = Number(arg("foodCeiling", 0.06));
/** Below this the engine's `sampleField` cannot see the cell at all. */
const ATTENTION = 0.015;
const SCAR_LEVEL = Number(arg("scar", 0.012));
const SCARS = !argv.includes("--noScars");

/* --- the puzzle on the lattice --------------------------------------- */

const CW = Math.floor(GRID_W / (W + 1));
const CH = Math.floor(GRID_H / (H + 1));
const OX = (GRID_W - (W - 1) * CW) / 2;
const OY = (GRID_H - (H - 1) * CH) / 2;
const site = (r, c) => ({ x: Math.round(OX + c * CW), y: Math.round(OY + r * CH) });
const CELL_R = Math.max(4, Math.floor(Math.min(CW, CH) * 0.42));

const cells = [];
for (let r = 0; r < H; r += 1) {
  for (let c = 0; c < W; c += 1) {
    const { x, y } = site(r, c);
    cells.push({ r, c, x, y, key: `${r},${c}`, letter: GRID[r][c], supply: 0, everFed: false, scarred: false });
  }
}
/** Only cells bearing a letter of the word can ever be a node. */
const inPlay = new Set();
for (const cell of cells) if (WORD.includes(cell.letter)) inPlay.add(cell.key);

/* --- the solve, held so the plate can be walked through it ------------ */

const answer = new Set(trueRun(WORD));
/** supplyTrace[s] is the per-cell supply map after adaptation step s. */
const supplyTrace = [];
const solved = adapt(WORD, {
  steps: Math.max(ADAPT_STEPS, 400),
  onStep: (step, net) => { if (step < ADAPT_STEPS) supplyTrace.push(supply(net)); },
});
if (supplyTrace.length === 0) {
  console.log(`\n"${WORD}" has no letters on this plate.`);
  process.exit(1);
}

/* --- the culture ------------------------------------------------------ */

/**
 * `minimal` — rapid trail loss, so the culture keeps few persistent paths.
 *
 * Chosen by measurement, and the measurement is worth keeping because the
 * three available numbers rank the four variants three different ways:
 *
 *   variant        disc contrast   ribbon fill   ribbon:substrate
 *   forage 7500          58.7x         66.5%         7.65x
 *   forage 4200         103.2x         46.8%        11.09x
 *   minimal              48.1x         88.6%         9.59x
 *   reticulate           51.0x         61.0%         4.57x
 *
 * The thin culture wins two of the three and loses the picture: at 4200 agents
 * the link between letters is a thread, so the plate reads as eight separate
 * lit rings rather than a word. Legibility needs the ribbon nearly solid AND
 * the substrate quiet, and `minimal` is the only one good at both. No single
 * number picks it, which is the honest version of this paragraph.
 */
const PRESET = arg("preset", "minimal");
const settings = { ...PRESETS[PRESET].settings };
if (arg("agents", null)) settings.population = Number(arg("agents"));
// "reticulate" here is the PLACEMENT, not the preset: it scatters the inoculum
// over the whole plate rather than dropping a disc in the middle. The piece
// starts with the culture already everywhere and takes it away.
const sim = makeSimulation(settings.population, "reticulate", SEED);

/**
 * Markers are rebuilt every tick and assigned straight onto the simulation.
 * MAX_MARKERS is 14 and `addMarker` evicts from the FRONT, so routing a plate
 * this size through it would silently drop almost all of them.
 */
function install(stepIndex) {
  const now = supplyTrace[Math.min(stepIndex, supplyTrace.length - 1)];
  const markers = [];
  for (const cell of cells) {
    if (!inPlay.has(cell.key)) continue;
    cell.supply = now.get(cell.key) ?? 0;
    const level = Math.min(FOOD_CEILING, cell.supply * FOOD_SCALE);
    if (level > ATTENTION) {
      cell.everFed = true;
      markers.push({ x: cell.x, y: cell.y, kind: "food", level, radius: CELL_R });
    } else {
      if (cell.everFed && SCARS) cell.scarred = true;
      if (cell.scarred) markers.push({ x: cell.x, y: cell.y, kind: "light", level: SCAR_LEVEL, radius: CELL_R });
    }
  }
  sim.markers = markers;
}

/** Fraction of a cell's disc that is standing tissue. */
function occupancy(cell) {
  let taken = 0;
  let total = 0;
  for (let dy = -CELL_R; dy <= CELL_R; dy += 1) {
    for (let dx = -CELL_R; dx <= CELL_R; dx += 1) {
      if (dx * dx + dy * dy > CELL_R * CELL_R) continue;
      const x = ((cell.x + dx) % GRID_W + GRID_W) % GRID_W;
      const y = ((cell.y + dy) % GRID_H + GRID_H) % GRID_H;
      total += 1;
      if (sim.occupancy[y * GRID_W + x] !== -1) taken += 1;
    }
  }
  return total === 0 ? 0 : taken / total;
}

/* --- drawing ---------------------------------------------------------- */

// 5x7, because a cell disc is 6 lattice sites across and the plate has to be
// readable as a word search or the whole conceit is lost.
const FONT = {
  A: ".###.#...##...#######...##...##...#",
  B: "####.#...##...#####.#...##...#####.",
  C: ".#####....#....#....#....#.....####",
  D: "####.#...##...##...##...##...#####.",
  E: "######....#....####.#....#....#####",
  F: "######....#....####.#....#....#....",
  G: ".#####....#....#..###...##...#.###.",
  H: "#...##...##...#######...##...##...#",
  I: "#####..#....#....#....#....#..#####",
  J: "####....#....#....#....#.#..#..##..",
  K: "#...##..#.#.#..##...#.#..#..#.#...#",
  L: "#....#....#....#....#....#....#####",
  M: "#...###.###.#.##...##...##...##...#",
  N: "#...###..##.#.##..###...##...##...#",
  O: ".###.#...##...##...##...##...#.###.",
  P: "####.#...##...#####.#....#....#....",
  Q: ".###.#...##...##...##.#.##..#..##.#",
  R: "####.#...##...#####.#.#..#..#.#...#",
  S: ".#####....#.....###.....#....#####.",
  T: "#####..#....#....#....#....#....#..",
  U: "#...##...##...##...##...##...#.###.",
  V: "#...##...##...##...##...#.#.#...#..",
  W: "#...##...##...##...##.#.###.###...#",
  X: "#...##...#.#.#...#...#.#.#...##...#",
  Y: "#...##...#.#.#...#....#....#....#..",
  Z: "#####....#...#...#...#...#....#####",
};
// Every glyph is exactly 5 columns x 7 rows. A typo here paints a smear rather
// than throwing, so it is checked once at startup instead of never.
for (const [ch, bits] of Object.entries(FONT)) {
  if (bits.length !== 35) throw new Error(`glyph ${ch} is ${bits.length} bits, want 35`);
}
const glyphOn = (letter, gx, gy) => {
  const bits = FONT[letter];
  if (!bits || gx < 0 || gx > 4 || gy < 0 || gy > 6) return false;
  return bits[gy * 5 + gx] === "#";
};

function renderRGB(scale) {
  const w = GRID_W * scale;
  const h = GRID_H * scale;
  const rgb = Buffer.alloc(w * h * 3);

  // Which cell, if any, owns each lattice site. Cheaper and less error-prone
  // than the per-pixel scan over all 196 cells the earlier painter did.
  const owner = new Int16Array(GRID_W * GRID_H).fill(-1);
  for (let ci = 0; ci < cells.length; ci += 1) {
    const cell = cells[ci];
    for (let dy = -CELL_R - 2; dy <= CELL_R + 2; dy += 1) {
      for (let dx = -CELL_R - 2; dx <= CELL_R + 2; dx += 1) {
        const x = ((cell.x + dx) % GRID_W + GRID_W) % GRID_W;
        const y = ((cell.y + dy) % GRID_H + GRID_H) % GRID_H;
        owner[y * GRID_W + x] = ci;
      }
    }
  }

  for (let y = 0; y < GRID_H; y += 1) {
    for (let x = 0; x < GRID_W; x += 1) {
      const i = y * GRID_W + x;
      const value = 1 - Math.exp(-sim.trail[i] * 0.15);
      const occupied = sim.occupancy[i] !== -1;
      let R = occupied ? 247 : 8 + value * 176;
      let G = occupied ? 132 : 10 + value * (72 + value * 25);
      let B = occupied ? 48 : 11 + value * (18 + value * 15);

      const ci = owner[i];
      if (ci !== -1) {
        const cell = cells[ci];
        const dx = x - cell.x;
        const dy = y - cell.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        const ring = Math.abs(d - CELL_R) < 1.2;
        const live = cell.supply * FOOD_SCALE > ATTENTION;

        if (cell.scarred) {
          R = Math.round(R * 0.4 + 14); G = Math.round(G * 0.4 + 24); B = Math.round(B * 0.4 + 34);
          if (ring) { R = 44; G = 66; B = 82; }
        } else if (live) {
          if (ring) { R = 210; G = 232; B = 120; }
        } else if (ring && inPlay.has(cell.key)) {
          R = Math.round(R * 0.75 + 26); G = Math.round(G * 0.75 + 26); B = Math.round(B * 0.75 + 22);
        }

        // The letter last, over everything, because the plate has to stay
        // readable as a puzzle even where the tissue is thickest.
        if (glyphOn(cell.letter, dx + 2, dy + 3)) {
          if (cell.scarred) { R = 96; G = 122; B = 140; }
          else if (live) { R = 255; G = 244; B = 196; }
          else if (inPlay.has(cell.key)) { R = 108; G = 100; B = 84; }
          else { R = 74; G = 70; B = 64; }
        }
      }

      for (let sy = 0; sy < scale; sy += 1) {
        for (let sx = 0; sx < scale; sx += 1) {
          const p = ((y * scale + sy) * w + x * scale + sx) * 3;
          rgb[p] = R; rgb[p + 1] = G; rgb[p + 2] = B;
        }
      }
    }
  }
  return rgb;
}

function paint(label) {
  mkdirSync(OUT, { recursive: true });
  writePng(`${OUT}/${label}.png`, GRID_W * SCALE, GRID_H * SCALE, renderRGB(SCALE));
}

/**
 * Every frame on one sheet, reading left to right and top to bottom.
 *
 * The answer is one image; the SEARCH is only visible as a sequence, and a
 * directory of PNGs is not something anyone looks at in order. A 2px gutter,
 * because without one the plates run together and the columns stop reading as
 * separate moments.
 */
function contactSheet(frames, cols) {
  const rows = Math.ceil(frames.length / cols);
  const gap = 2;
  const w = cols * GRID_W + (cols - 1) * gap;
  const h = rows * GRID_H + (rows - 1) * gap;
  const sheet = Buffer.alloc(w * h * 3);
  for (let i = 0; i < frames.length; i += 1) {
    const ox = (i % cols) * (GRID_W + gap);
    const oy = Math.floor(i / cols) * (GRID_H + gap);
    for (let y = 0; y < GRID_H; y += 1) {
      frames[i].copy(sheet, ((oy + y) * w + ox) * 3, y * GRID_W * 3, (y + 1) * GRID_W * 3);
    }
  }
  mkdirSync(OUT, { recursive: true });
  writePng(`${OUT}/${stamp}-sheet.png`, w, h, sheet);
  return `${OUT}/${stamp}-sheet.png`;
}

/* --- the run ---------------------------------------------------------- */

const TOTAL = COLONISE + ADAPT_STEPS * ADAPT_EVERY + SETTLE;
const frameEvery = Math.max(1, Math.floor(TOTAL / FRAMES));
const stamp = WORD.toLowerCase() + (CONTROL ? "-control" : "");

console.log(`\n=== the plate draws ${WORD}${CONTROL ? "   [CONTROL: the network never adapts]" : ""} ===\n`);
console.log(`${H}x${W} puzzle on a ${GRID_W}x${GRID_H} lattice, cell radius ${CELL_R}, ${settings.population} agents`);
console.log(`${inPlay.size} cells bear a letter of the word; ${answer.size} of them are the answer`);
console.log(`colonise ${COLONISE}  adapt ${ADAPT_STEPS}x${ADAPT_EVERY}  settle ${SETTLE}  = ${TOTAL} ticks\n`);
console.log("  tick   step    fed  scarred   tissue on answer   on other letters   bare plate");

let frame = 0;
const sheetFrames = [];
const started = Date.now();
for (let tick = 0; tick < TOTAL; tick += 1) {
  // Clamped, so the settle phase reports the step it is actually holding
  // rather than a counter running on past the end of the trace.
  const step = CONTROL ? 0
    : Math.min(supplyTrace.length - 1, Math.floor(Math.max(0, tick - COLONISE) / ADAPT_EVERY));
  install(step);
  advanceSimulation(sim, settings);
  if (tick % frameEvery === 0 || tick === TOTAL - 1) {
    report(tick, step);
    paint(`${stamp}-${String(frame).padStart(2, "0")}`);
    sheetFrames.push(renderRGB(1));
    frame += 1;
  }
}
paint(`${stamp}-print`);
const sheet = contactSheet(sheetFrames, Number(arg("sheetCols", 3)));

function meanOccupancy(list) {
  if (list.length === 0) return 0;
  return list.reduce((sum, cell) => sum + occupancy(cell), 0) / list.length;
}

/**
 * Tissue in the gaps BETWEEN consecutive cells of a chain — the tube.
 *
 * Disc occupancy is not the right measurement for this piece and finding that
 * out cost a wrong ranking. It scores how packed the letters are, and by that
 * number a thinner culture wins: fewer agents, less spare tissue, a higher
 * ratio. But what makes a word legible on the plate is the unbroken ribbon
 * joining its letters, and that lies in the gaps, which disc occupancy never
 * looks at. This walks the straight segment between each consecutive pair,
 * skips the discs at both ends, and counts the band around it.
 */
function tubeOccupancy(chain, band = 2) {
  if (chain.length < 2) return 0;
  let taken = 0;
  let total = 0;
  for (let i = 0; i + 1 < chain.length; i += 1) {
    const a = chain[i];
    const b = chain[i + 1];
    const span = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    for (let s = 0; s <= span; s += 1) {
      const px = a.x + ((b.x - a.x) * s) / span;
      const py = a.y + ((b.y - a.y) * s) / span;
      // Inside either disc this measures the letter, not the link.
      if (Math.hypot(px - a.x, py - a.y) <= CELL_R || Math.hypot(px - b.x, py - b.y) <= CELL_R) continue;
      // Unit normal to the segment, so a diagonal link is sampled across its
      // width rather than along it.
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const nx = -(b.y - a.y) / len;
      const ny = (b.x - a.x) / len;
      for (let d = -band; d <= band; d += 1) {
        const x = ((Math.round(px + nx * d) % GRID_W) + GRID_W) % GRID_W;
        const y = ((Math.round(py + ny * d) % GRID_H) + GRID_H) % GRID_H;
        total += 1;
        if (sim.occupancy[y * GRID_W + x] !== -1) taken += 1;
      }
    }
  }
  return total === 0 ? 0 : taken / total;
}

/**
 * Occupancy of the substrate itself: every site that is not inside a cell disc.
 * The background the tube has to stand out from.
 */
function plateOccupancy() {
  let taken = 0;
  let total = 0;
  for (let y = 0; y < GRID_H; y += 1) {
    for (let x = 0; x < GRID_W; x += 1) {
      let onDisc = false;
      for (const cell of cells) {
        const dx = x - cell.x;
        const dy = y - cell.y;
        if (dx * dx + dy * dy <= (CELL_R + 2) * (CELL_R + 2)) { onDisc = true; break; }
      }
      if (onDisc) continue;
      total += 1;
      if (sim.occupancy[y * GRID_W + x] !== -1) taken += 1;
    }
  }
  return total === 0 ? 0 : taken / total;
}

/** The answer's cells in word order, which is the order the tube runs in. */
const answerChain = trueRun(WORD).map((key) => cells.find((c) => c.key === key)).filter(Boolean);

function report(tick, step) {
  const onAnswer = meanOccupancy(cells.filter((c) => answer.has(c.key)));
  const onOther = meanOccupancy(cells.filter((c) => inPlay.has(c.key) && !answer.has(c.key)));
  const bare = meanOccupancy(cells.filter((c) => !inPlay.has(c.key)));
  const fed = cells.filter((c) => c.supply * FOOD_SCALE > ATTENTION).length;
  const scarred = cells.filter((c) => c.scarred).length;
  console.log(
    String(tick).padStart(6) + String(step).padStart(7) + String(fed).padStart(7) + String(scarred).padStart(9) +
    (onAnswer * 100).toFixed(1).padStart(19) + (onOther * 100).toFixed(1).padStart(19) +
    (bare * 100).toFixed(1).padStart(13),
  );
}

const onAnswer = meanOccupancy(cells.filter((c) => answer.has(c.key)));
const onOther = meanOccupancy(cells.filter((c) => inPlay.has(c.key) && !answer.has(c.key)));
const bare = meanOccupancy(cells.filter((c) => !inPlay.has(c.key)));
const survivors = [...solved.live];
console.log(`\n  the solve kept ${survivors.filter((k) => answer.has(k)).length}/${answer.size} true cells` +
  ` and ${survivors.filter((k) => !answer.has(k)).length} co-optimal ties`);
console.log(`  final tissue: ${(onAnswer * 100).toFixed(1)}% on the answer,` +
  ` ${(onOther * 100).toFixed(1)}% on the other letters of the word,` +
  ` ${(bare * 100).toFixed(1)}% on the rest of the plate`);
console.log(`  contrast answer:others = ${onOther > 0 ? (onAnswer / onOther).toFixed(2) : "inf"}x` +
  `   answer:bare = ${bare > 0 ? (onAnswer / bare).toFixed(2) : "inf"}x`);

const tube = tubeOccupancy(answerChain);
const plate = plateOccupancy();
console.log(`  the ribbon: ${(tube * 100).toFixed(1)}% tissue in the gaps between the answer's letters,` +
  ` against ${(plate * 100).toFixed(1)}% on open substrate  (${plate > 0 ? (tube / plate).toFixed(2) : "inf"}x)`);
console.log("  that ratio, not the disc contrast, is whether the culture DREW the word");
console.log(`\n  ${frame + 1} frames in ${OUT}/, the whole search on ${sheet}` +
  `  (${((Date.now() - started) / 1000).toFixed(1)}s)`);
