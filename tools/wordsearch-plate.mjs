#!/usr/bin/env node
/**
 * SUPERSEDED. Kept deliberately — read docs/HANDOFF-WORDSEARCH.md first.
 *
 * This is the staged-food design: reveal the word's letters one at a time,
 * give each colony a nutrient timer, and let a colony starve if the next
 * letter is not within reach. It demonstrably prunes — six V colonies fall to
 * five, then three, then two, and scars appear exactly where a colony had no
 * continuation — but it could never do both halves of the job at once:
 *
 *     drain 0.0028   17 scars, false starts die     1 of 8 true cells kept
 *     drain 0.0004    0 scars, nothing dies back    6 of 8 true cells kept
 *
 * Fast enough to kill the impostors is fast enough to starve the answer's own
 * first letters before the word completes. The tension is structural, not a
 * tuning failure: survival was a clock, and the clock cannot know whether a
 * cell is on a route to anywhere. `tools/wordsearch.mjs` replaces the clock
 * with THROUGHPUT and the tension disappears.
 *
 * Why this file survives anyway. It holds two things the flow design still
 * needs and nothing else in the repo has: the mapping of a puzzle grid onto
 * the 360x240 lattice, and the plate painter that draws living tissue, fed
 * letters and scars as a PNG. The render step of the flow design is those two
 * pieces plus a different source of truth about what should be alive.
 *
 * It also records what the measurements cost, which is the part that is
 * expensive to rediscover:
 *
 *   - Scars must be weak. Measured across 84 aversion discs on a 196-cell
 *     plate: at level 1 the culture's own trail decides 0% of its turns and it
 *     is a puppet walking someone else's maze; the usable window is 0.008-0.02,
 *     WEAKER than the food window of 0.02-0.06, because there are far more
 *     scars than baits.
 *   - `MAX_MARKERS` is 14 and `addMarker` evicts from the FRONT, so a 196-cell
 *     plate must assign `sim.markers` directly or almost every cell silently
 *     vanishes.
 *   - The engine has no persistent tube. Its trail half-life is 8 steps, so
 *     the culture follows the newest food and abandons everything behind it.
 *     Anything that needs a structure to survive across stages has to carry it
 *     itself.
 *
 *   node tools/wordsearch-plate.mjs --word VACATION --out shots
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

/* --- the puzzle ---------------------------------------------------- */

const GRID = [
  "YNCGDXRKOSMJEP", "SBZUHNOITACAVL", "OQTJWESPHYFIDM", "HARNCVBLGWXRKZ",
  "CMOTELJDIFHPSU", "AGPYLWTNLQZLXB", "ESRAHEDBFNUAML", "BHIFSOVXZKLNPE",
  "FKAPWSHACEDELT", "XVOBQUPMRJPGFO", "NOYADILOHTEIKH", "LUSXVGZWRBVCRA",
  "DJFMTICKETAYQT", "RENIHSNUSPOBWG",
].map((r) => r.split(""));

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const WORD = arg("word", "VACATION").toUpperCase();
const OUT = arg("out", "shots");
const FRAMES = Number(arg("frames", 10));
const SEED = Number(arg("seed", 4242));
const SCALE = Number(arg("scale", 3));

/** Ticks the culture is given to reach each letter before the food moves on. */
const STAGE_TICKS = Number(arg("stageTicks", 260));
/** Food strength. Measured window is 0.02-0.06; above it the disc jams solid. */
const FOOD_LEVEL = Number(arg("food", 0.045));
/**
 * Scar strength. Measured window is 0.008-0.02: at 0.06 a plate this crowded
 * is 28% marker-dominated and at level 1 it is 100%, which makes the culture a
 * puppet walking a maze someone else drew.
 */
const SCAR_LEVEL = Number(arg("scar", 0.012));
/**
 * Nutrient drained per tick from a cell that is not being fed.
 *
 * This is how long the chain REMEMBERS, and it has a hard floor. A fed cell
 * holds on for 1/DRAIN ticks, and it has to still be alive when the next
 * letter's food is placed or there is nothing for that food to be anchored to.
 * At 0.016 a cell lasts 62 ticks against a 260-tick stage, and the chain broke
 * every time at the third letter: the anchor starved a quarter of the way in,
 * the food for the next letter vanished with it, and the culture never got
 * there. Keep 1/DRAIN comfortably above `stageTicks`.
 */
const DRAIN = Number(arg("drain", 0.0028));
/** Fraction of a cell's nutrient shared with connected neighbours per tick. */
const SHARE = Number(arg("share", 0.14));
/**
 * How far the next letter may be and still count as part of the chain, in
 * cells. This is the rule that makes a chain a chain.
 */
const LINK_REACH = Number(arg("reach", 2));
/**
 * Ticks of consolidation once the last letter is reached.
 *
 * Completing the word does not stop the earlier letters starving: from the
 * second letter to the eighth is over 1500 ticks, and a fed cell only holds
 * for 1/DRAIN. So on completion the final letter becomes an inexhaustible
 * source and nutrient runs BACK down the tube that connects it to the start.
 *
 * Nothing walks the chain to do this — that would be the graph search again.
 * The surge simply flows through living tissue, so the run that is actually
 * connected end to end is kept alive and every branch hanging off it gets
 * nothing and is reabsorbed. That is Tero's reinforcement rule, and it is why
 * the finished plate shows a word rather than a scatter of lit letters.
 */
const CONSOLIDATE_TICKS = Number(arg("consolidate", 700));

const N = GRID.length;
const CW = Math.floor(GRID_W / (N + 1));
const CH = Math.floor(GRID_H / (N + 1));
const OX = (GRID_W - (N - 1) * CW) / 2;
const OY = (GRID_H - (N - 1) * CH) / 2;
const site = (r, c) => ({ x: Math.round(OX + c * CW), y: Math.round(OY + r * CH) });

const CELL_R = Math.max(4, Math.floor(Math.min(CW, CH) * 0.42));

/* --- the substrate -------------------------------------------------- */

const cells = [];
for (let r = 0; r < N; r += 1) {
  for (let c = 0; c < N; c += 1) {
    const { x, y } = site(r, c);
    cells.push({
      r, c, x, y,
      letter: GRID[r][c],
      /** How much of the word this cell could be. Set when it is fed. */
      stage: -1,
      nutrient: 0,
      scarred: false,
      everFed: false,
      anchor: false,
      /** The cell this one linked back to when it was fed. Its tube. */
      feeder: null,
    });
  }
}
const cellAt = (r, c) => (r >= 0 && r < N && c >= 0 && c < N ? cells[r * N + c] : null);

const settings = PRESETS.forage.settings;
const sim = makeSimulation(settings.population, "reticulate", SEED);

/** Occupancy of a cell's disc, 0-1. This is "is the culture here". */
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

/**
 * Markers are rebuilt every tick and assigned straight onto the simulation.
 * MAX_MARKERS is 14 and `addMarker` evicts from the FRONT, so routing a
 * 196-cell plate through it would silently drop almost all of them.
 */
/** The live predecessor this cell could hang off, or null. */
function anchorFor(cell, stage) {
  if (stage === 0) return cell;                       // the first letter anchors itself
  let best = null;
  for (let dr = -LINK_REACH; dr <= LINK_REACH; dr += 1) {
    for (let dc = -LINK_REACH; dc <= LINK_REACH; dc += 1) {
      const other = cellAt(cell.r + dr, cell.c + dc);
      if (!other || other.scarred || other.stage !== stage - 1 || other.nutrient <= 0) continue;
      if (!best || other.nutrient > best.nutrient) best = other;
    }
  }
  return best;
}
const withinReach = (cell, stage) => anchorFor(cell, stage) !== null;

/**
 * A cell already spent on an earlier letter is not available again.
 *
 * Without this the chain doubles back: VACATION would happily use the same A
 * for letter 1 and letter 3, since that A sits right beside the C between
 * them. A tube can pass over ground it has used, but a letter cannot be two
 * places in one word.
 */
function unspent(cell, stage) {
  // "Not spent on an EARLIER letter". The first version of this said simply
  // `stage === -1`, which also stopped a cell being fed during its own stage:
  // it took one mouthful, became spent, and starved eighteen ticks later.
  return cell.stage === -1 || cell.stage === stage;
}

function install(stage) {
  const markers = [];
  for (const cell of cells) {
    if (!cell.scarred && unspent(cell, stage) && cell.letter === WORD[stage] && withinReach(cell, stage)) {
      markers.push({ x: cell.x, y: cell.y, kind: "food", level: FOOD_LEVEL, radius: CELL_R });
    } else if (cell.scarred) {
      markers.push({ x: cell.x, y: cell.y, kind: "light", level: SCAR_LEVEL, radius: CELL_R });
    } else if (cell.nutrient > 0.2) {
      // A nourished cell holds the culture on itself. Without this the loop is
      // only half built: nutrient can only move where tissue connects two
      // cells, but nothing was keeping tissue on the chain, and the engine has
      // no persistent tube to fall back on — its trail half-life is 8 steps.
      // So the culture followed the newest food, abandoned everything behind
      // it, and the surge from the completed word had nothing to run back
      // along. Flow maintains the tube and the tube carries the flow; this is
      // the second half.
      markers.push({
        x: cell.x, y: cell.y, kind: "food",
        level: FOOD_LEVEL * 0.55 * Math.min(1, cell.nutrient), radius: CELL_R,
      });
    }
  }
  sim.markers = markers;
}

/**
 * One tick of substrate chemistry.
 *
 * Fed cells gain nutrient. Everything drains. Nutrient moves between
 * neighbouring cells only where the culture actually connects them, which is
 * what lets a live chain keep its earlier letters alive and lets an isolated
 * colony starve however much food it once had.
 */
function metabolise(stage) {
  const held = cells.map((cell) => occupancy(cell));

  for (let i = 0; i < cells.length; i += 1) {
    const cell = cells[i];
    if (cell.scarred) continue;
    if (cell.letter === WORD[stage] && unspent(cell, stage) && held[i] > 0.12 && withinReach(cell, stage)) {
      cell.nutrient = Math.min(1, cell.nutrient + 0.05);
      if (cell.stage !== stage) cell.feeder = anchorFor(cell, stage);
      cell.stage = stage;
      cell.everFed = true;
      if (stage === WORD.length - 1) cell.anchor = true;
    }
    // An anchor is a completed word's last letter, still sitting on food. It
    // does not drain, and everything upstream lives on what flows back from it.
    if (!cell.anchor) cell.nutrient = Math.max(0, cell.nutrient - DRAIN);
    else cell.nutrient = 1;
  }

  // Sharing, on a snapshot so it is symmetric and order-independent.
  const before = cells.map((cell) => cell.nutrient);
  for (let i = 0; i < cells.length; i += 1) {
    const cell = cells[i];
    if (cell.scarred) continue;
    // Sharing uses the SAME reach as linking, so a chain that bridges a gap
    // can also feed back across it. A shorter sharing radius would let a
    // legitimate two-cell link starve the letter behind it.
    for (let dr = -LINK_REACH; dr <= LINK_REACH; dr += 1) {
      for (let dc = -LINK_REACH; dc <= LINK_REACH; dc += 1) {
        if (!dr && !dc) continue;
        const other = cellAt(cell.r + dr, cell.c + dc);
        if (!other || other.scarred) continue;
        const link = Math.min(held[i], held[other.r * N + other.c]);
        // No tissue between them, no streaming. This is the whole mechanism.
        if (link < 0.12) continue;
        const flow = (before[other.r * N + other.c] - before[i]) * SHARE * link;
        if (flow > 0) cell.nutrient = Math.min(1, cell.nutrient + flow);
      }
    }
  }

  /**
   * "Each letter in a row extends the time." A cell that is currently fed
   * pushes life back down the tube it arrived along.
   *
   * The link is REMEMBERED, not re-derived from whoever happens to be standing
   * on the cells right now. That was the previous version and it failed for a
   * reason the engine makes unavoidable: its trail half-life is 8 steps, so
   * there is no persistent tube, the culture follows the newest food, and the
   * connection a chain was built on evaporates behind it. A real plasmodium
   * keeps its tubes. This is that tube, and nothing else in the engine can be.
   *
   * Measured without it: at a drain fast enough to kill false starts, 1 of the
   * 8 true cells survived; at a drain slow enough to keep the chain, 12 false
   * colonies survived and nothing scarred at all.
   */
  for (let pass = 0; pass < WORD.length; pass += 1) {
    for (const cell of cells) {
      if (cell.scarred || cell.nutrient < 0.35) continue;
      const up = cell.feeder;
      if (!up || up === cell || up.scarred) continue;
      up.nutrient = Math.max(up.nutrient, cell.nutrient * 0.94);
    }
  }

  for (const cell of cells) {
    if (!cell.scarred && cell.everFed && cell.nutrient <= 0) cell.scarred = true;
  }
}

/* --- drawing --------------------------------------------------------- */

function paint(label) {
  const w = GRID_W * SCALE;
  const h = GRID_H * SCALE;
  const rgb = Buffer.alloc(w * h * 3);

  for (let y = 0; y < GRID_H; y += 1) {
    for (let x = 0; x < GRID_W; x += 1) {
      const i = y * GRID_W + x;
      const value = 1 - Math.exp(-sim.trail[i] * 0.15);
      const occupied = sim.occupancy[i] !== -1;
      let R = occupied ? 247 : 8 + value * 176;
      let G = occupied ? 132 : 10 + value * (72 + value * 25);
      let B = occupied ? 48 : 11 + value * (18 + value * 15);

      for (const cell of cells) {
        const dx = x - cell.x;
        const dy = y - cell.y;
        const d2 = dx * dx + dy * dy;
        if (d2 > (CELL_R + 2) * (CELL_R + 2)) continue;
        const ring = Math.abs(Math.sqrt(d2) - CELL_R) < 1.2;
        if (cell.scarred) {
          // Scar: a cold bruise, and the letter still legible under it.
          R = Math.round(R * 0.35 + 18);
          G = Math.round(G * 0.35 + 26);
          B = Math.round(B * 0.35 + 34);
          if (ring) { R = 42; G = 62; B = 78; }
        } else if (cell.everFed && cell.nutrient > 0) {
          const heat = Math.min(1, cell.nutrient * 1.6);
          R = Math.min(255, Math.round(R + heat * 90));
          G = Math.min(255, Math.round(G + heat * 70));
          B = Math.min(255, Math.round(B * (1 - heat * 0.5)));
          if (ring) { R = 232; G = 255; B = 120; }
        } else if (ring) {
          R = Math.round(R * 0.7 + 30); G = Math.round(G * 0.7 + 34); B = Math.round(B * 0.7 + 30);
        }
        break;
      }

      for (let sy = 0; sy < SCALE; sy += 1) {
        for (let sx = 0; sx < SCALE; sx += 1) {
          const p = ((y * SCALE + sy) * w + x * SCALE + sx) * 3;
          rgb[p] = R; rgb[p + 1] = G; rgb[p + 2] = B;
        }
      }
    }
  }

  mkdirSync(OUT, { recursive: true });
  writePng(`${OUT}/${label}.png`, w, h, rgb);
}

/* --- the run --------------------------------------------------------- */

console.log(`\n=== the plate hunts ${WORD} ===\n`);
console.log(`grid ${N}x${N} on a ${GRID_W}x${GRID_H} lattice, cell radius ${CELL_R}`);
console.log(`food ${FOOD_LEVEL}  scar ${SCAR_LEVEL}  drain ${DRAIN}/tick  share ${SHARE}\n`);
console.log("stage  letter  bearing  in reach  fed  alive  scarred   note");

let frame = 0;
const frameEvery = Math.max(1, Math.floor((WORD.length * STAGE_TICKS) / FRAMES));
let tick = 0;

for (let stage = 0; stage < WORD.length; stage += 1) {
  const bearing = cells.filter((c) => !c.scarred && unspent(c, stage) && c.letter === WORD[stage]).length;
  // Measured now, at the start of the stage. Measuring it afterwards reports
  // whatever had drained away by then, which is a different question.
  const reachable = cells.filter(
    (c) => !c.scarred && unspent(c, stage) && c.letter === WORD[stage] && withinReach(c, stage),
  ).length;
  for (let t = 0; t < STAGE_TICKS; t += 1) {
    install(stage);
    advanceSimulation(sim, settings);
    metabolise(stage);
    if (tick % frameEvery === 0) paint(`${WORD.toLowerCase()}-${String(frame++).padStart(2, "0")}`);
    tick += 1;
  }
  const fed = cells.filter((c) => c.stage === stage).length;
  const alive = cells.filter((c) => !c.scarred && c.everFed && c.nutrient > 0).length;
  const scarred = cells.filter((c) => c.scarred).length;
  console.log(
    String(stage).padStart(5) + WORD[stage].padStart(8) + String(bearing).padStart(9) +
    String(reachable).padStart(10) + String(fed).padStart(5) + String(alive).padStart(7) +
    String(scarred).padStart(9) +
    (reachable === 0 ? "   the chain has nowhere to go" : fed === 0 ? "   in reach, but nothing got there" : ""),
  );
}

// Consolidation: the food stays on the last letter and the tube is fed from
// the far end. What is connected survives; what is merely nearby does not.
const anchors = cells.filter((c) => c.anchor).length;
if (anchors > 0) {
  console.log(`
  ${WORD} completed at ${anchors} anchor${anchors === 1 ? "" : "s"}; ` +
    `consolidating for ${CONSOLIDATE_TICKS} ticks`);
  for (let t = 0; t < CONSOLIDATE_TICKS; t += 1) {
    install(WORD.length - 1);
    advanceSimulation(sim, settings);
    metabolise(WORD.length - 1);
    if (t % Math.max(1, Math.floor(CONSOLIDATE_TICKS / 3)) === 0) {
      paint(`${WORD.toLowerCase()}-${String(frame++).padStart(2, "0")}`);
    }
  }
} else {
  console.log(`
  ${WORD} was never completed; nothing to consolidate.`);
}

paint(`${WORD.toLowerCase()}-final`);

const survivors = cells.filter((c) => !c.scarred && c.everFed && c.nutrient > 0);
const scarred = cells.filter((c) => c.scarred);
console.log(`\n  ${survivors.length} cells still alive, ${scarred.length} scarred, ` +
  `${cells.length - survivors.length - scarred.length} never touched`);
console.log("  survivors: " + survivors.map((c) => `${c.letter}(${c.r},${c.c})`).join(" "));
console.log(`\n  frames -> ${OUT}/${WORD.toLowerCase()}-*.png`);
