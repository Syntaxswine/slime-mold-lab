#!/usr/bin/env node
/**
 * A word search solved by transport, not by search.
 *
 * The puzzle grid becomes a supply chain. Every cell bearing a letter of the
 * target word is a node; an edge runs from a cell bearing letter k to a nearby
 * cell bearing letter k+1, and its length is what it costs to move material
 * along it. Flow is injected at every cell bearing the first letter and drawn
 * off at every cell bearing the last. Then the one rule that matters:
 *
 *     dD/dt = f(|Q|) - D
 *
 * A tube carrying flow thickens; a tube carrying none is reabsorbed. That is
 * Tero, Takagi, Saigusa, Ito, Bebber, Fricker, Yumiki, Kobayashi & Nakagaki
 * (2010), "Rules for Biologically Inspired Adaptive Network Design", Science
 * 327(5964):439-442, doi:10.1126/science.1177894 — the model behind Physarum
 * solving mazes and reproducing the Tokyo rail network. It is already in this
 * repo's README as a reference; here it is doing the work.
 *
 * NOTHING SEARCHES. There is no path enumeration, no backtracking, no
 * bookkeeping about which chain a cell belongs to. Each step solves Kirchhoff
 * for the pressures, reads the flows, and adjusts every conductance by a local
 * rule. The answer precipitates: cells with no route from the first letter to
 * the last carry no flow and are reabsorbed, however many of the word's
 * letters happen to sit near them.
 *
 * WHAT IT MEASURES ON THE PACKAGED PUZZLE
 *
 *   105 of 105 true cells kept across all eighteen words
 *   11 surviving cells out of 196 that are not in any answer
 *
 * and those eleven are TIES, not mistakes. They fall on six words, not one —
 * PACK 4, AIRPORT 2, PASSPORT 2, FLIGHT 1, HOTEL 1, MOTEL 1 — with PACK the
 * clearest case: eight cells kept for a four-letter word, two chains of
 * identical minimal cost. Tero's model keeps co-optimal routes and so does a
 * real plasmodium; the famous shortest-path result is for a maze with a unique
 * solution. `tests/wordsearch.test.mjs` pins that distribution, so a change to
 * it has to be re-argued rather than absorbed.
 *
 * WHICH CONSTANT DECIDES THE ANSWER
 *
 *   `reach` bounds the graph; it does NOT decide the answer. Reach 1, 2, 3 and
 *   5 all score 105/105 with the same 11 ties, because a long hop costs more
 *   and never wins — transport cost subsumes the cap. Keep it small for speed:
 *   VACATION goes from 67 edges to 228 between reach 2 and reach 5.
 *
 *   That is a correction to how this was first reasoned about. A hard distance
 *   cap IS load-bearing in a design with no cost function — the staged-food
 *   and local-density versions both needed one — and introducing transport
 *   cost is what made it redundant here. It still does not rescue proximity as
 *   a substitute for linkage: a purely areal rule, "all the word's letters
 *   within radius r", cannot work at all. A word is a line and a window is a
 *   blob, so any window large enough to hold an eight-cell run holds 81 cells,
 *   and at that size 148 of 196 positions on this plate qualify.
 *
 *   Transport cost is in LATTICE STEPS, not Euclidean distance. On a square
 *   lattice a mould moves one cell per step whichever way it goes, so a
 *   straight diagonal must not cost 1.41 per letter while a straight
 *   orthogonal costs 1. Under Euclidean cost PACK is lost outright (0 of 4
 *   cells): its answer is diagonal at 4.24 while a bent path costs 3.83, so
 *   the physics correctly finds the shortest chain and it is not the puzzle's.
 *   Euclidean scores 99/105; lattice steps score 105/105.
 *
 * WHERE THE CODE IS. The network and the adaptation live in
 * `tools/wordsearch-flow.mjs`, shared with `tools/wordsearch-plate-flow.mjs`,
 * which grows a culture on the answer. This file is the census over it.
 *
 *   node tools/wordsearch.mjs                       # census over every word
 *   node tools/wordsearch.mjs --word VACATION       # one word, with its chain
 *   node tools/wordsearch.mjs --reach 1 --compare   # what each knob costs
 */
import {
  GRID, WORDS, H, W, MU, RATE, ALIVE,
  stepCost, euclidCost, trueRun, adapt,
} from "./wordsearch-flow.mjs";

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const ONLY = arg("word", null);
const REACH = Number(arg("reach", 2));
const STEPS = Number(arg("steps", 400));
const COMPARE = argv.includes("--compare");
const TUNING = {
  alive: Number(arg("alive", ALIVE)),
  mu: Number(arg("mu", MU)),
  rate: Number(arg("rate", RATE)),
};

/* --- reporting -------------------------------------------------------- */

function census(label, options) {
  console.log(`\n=== ${label} ===\n`);
  console.log("word         nodes  edges   surviving   true kept   ties");
  let keptAll = 0;
  let trueAll = 0;
  let extraAll = 0;
  for (const word of ONLY ? [ONLY.toUpperCase()] : WORDS) {
    const answer = new Set(trueRun(word));
    const { live, net } = adapt(word, { ...TUNING, ...options });
    const kept = [...answer].filter((c) => live.has(c)).length;
    const extra = [...live].filter((c) => !answer.has(c)).length;
    keptAll += kept;
    trueAll += answer.size;
    extraAll += extra;
    console.log(
      word.padEnd(12) + String(net.nodes.length).padStart(6) + String(net.edges.length).padStart(7) +
      String(live.size).padStart(12) + `${kept}/${answer.size}`.padStart(12) + String(extra).padStart(7),
    );
  }
  console.log(`\n  true cells kept ${keptAll}/${trueAll}` +
    `   surviving cells not in any answer: ${extraAll}`);
  console.log("  (extras are co-optimal chains, not errors: a plasmodium keeps ties too)");
  return { keptAll, trueAll, extraAll };
}

if (COMPARE) {
  console.log("\nWhat each knob is worth. Recall is the number that matters;");
  console.log("a design that loses true cells is wrong however few extras it keeps.");
  const rows = [
    ["lattice steps, reach 2  (the default)", { cost: stepCost, reach: 2 }],
    ["euclidean cost, reach 2", { cost: euclidCost, reach: 2 }],
    ["lattice steps, reach 1", { cost: stepCost, reach: 1 }],
    ["lattice steps, reach 3", { cost: stepCost, reach: 3 }],
  ];
  const out = [];
  for (const [label, options] of rows) {
    let keptAll = 0;
    let trueAll = 0;
    let extraAll = 0;
    for (const word of WORDS) {
      const answer = new Set(trueRun(word));
      const { live } = adapt(word, { ...TUNING, ...options });
      keptAll += [...answer].filter((c) => live.has(c)).length;
      trueAll += answer.size;
      extraAll += [...live].filter((c) => !answer.has(c)).length;
    }
    out.push([label, keptAll, trueAll, extraAll]);
  }
  console.log("\n  variant                                recall     ties");
  for (const [label, kept, total, extra] of out) {
    console.log(`  ${label.padEnd(38)}${`${kept}/${total}`.padStart(7)}${String(extra).padStart(9)}`);
  }
} else {
  census(`Tero adaptation, reach ${REACH}, ${STEPS} steps, lattice-step transport`,
    { reach: REACH, cost: stepCost, steps: STEPS });

  if (ONLY) {
    const word = ONLY.toUpperCase();
    const { live } = adapt(word, { ...TUNING, reach: REACH, cost: stepCost, steps: STEPS });
    const answer = new Set(trueRun(word));
    console.log(`\n  ${word} — surviving cells, . = reabsorbed, # = also in the puzzle's own run\n`);
    for (let r = 0; r < H; r += 1) {
      let line = "    ";
      for (let c = 0; c < W; c += 1) {
        const key = `${r},${c}`;
        line += live.has(key) ? (answer.has(key) ? ` ${GRID[r][c]}` : ` ${GRID[r][c].toLowerCase()}`) : " .";
      }
      console.log(line);
    }
    console.log("\n    upper case: on the puzzle's straight run.  lower case: a co-optimal tie.");
  }
}
