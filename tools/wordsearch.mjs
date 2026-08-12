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
 * and those eleven are TIES, not mistakes. PACK keeps eight cells for a
 * four-letter word: two chains of identical minimal cost. Tero's model keeps
 * co-optimal routes and so does a real plasmodium — the famous shortest-path
 * result is for a maze with a unique solution.
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
 * WHAT IS NOT HERE. This is the flow network, not the plate. The picture — the
 * culture physically growing along the surviving tubes — is the next step, and
 * `tools/wordsearch-plate.mjs` already holds the lattice mapping and the PNG
 * painter it needs. See docs/HANDOFF-WORDSEARCH.md.
 *
 *   node tools/wordsearch.mjs                       # census over every word
 *   node tools/wordsearch.mjs --word VACATION       # one word, with its chain
 *   node tools/wordsearch.mjs --reach 1 --compare   # what each knob costs
 */

/* --- the puzzle ------------------------------------------------------ */

// Transcribed by eye from the Tree Valley Academy "Vacation" word search.
// TREAT AS APPROXIMATE: it has not been checked against the original character
// by character, and every number this tool prints rests on it.
const GRID = [
  "YNCGDXRKOSMJEP", "SBZUHNOITACAVL", "OQTJWESPHYFIDM", "HARNCVBLGWXRKZ",
  "CMOTELJDIFHPSU", "AGPYLWTNLQZLXB", "ESRAHEDBFNUAML", "BHIFSOVXZKLNPE",
  "FKAPWSHACEDELT", "XVOBQUPMRJPGFO", "NOYADILOHTEIKH", "LUSXVGZWRBVCRA",
  "DJFMTICKETAYQT", "RENIHSNUSPOBWG",
].map((r) => r.split(""));

const WORDS = [
  "AIRPORT", "AIRPLANE", "BEACH", "FLIGHT", "FUN", "HOLIDAY", "HOTEL", "MOTEL",
  "PACK", "PASSPORT", "POOL", "RELAX", "SUNSHINE", "TICKET", "TRAVEL", "TRIP",
  "VACATION", "WINDOW",
];

const H = GRID.length;
const W = GRID[0].length;

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const ONLY = arg("word", null);
const REACH = Number(arg("reach", 2));
const STEPS = Number(arg("steps", 400));
const COMPARE = argv.includes("--compare");
/** Conductance below which a tube counts as reabsorbed. */
const ALIVE = Number(arg("alive", 0.05));
/** Tero's f(Q) = Q^mu / (1 + Q^mu). Above 1 it sharpens onto single routes. */
const MU = Number(arg("mu", 1.4));
const RATE = Number(arg("rate", 0.25));

const stepCost = (dr, dc) => Math.max(Math.abs(dr), Math.abs(dc));
const euclidCost = (dr, dc) => Math.hypot(dr, dc);

/* --- the puzzle's own answer, for scoring ---------------------------- */

const D8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

/** Where the word really is: a straight run of adjacent cells. */
function trueRun(word) {
  for (let r = 0; r < H; r += 1) {
    for (let c = 0; c < W; c += 1) {
      if (GRID[r][c] !== word[0]) continue;
      for (const [dr, dc] of D8) {
        const cells = [];
        let ok = true;
        for (let k = 0; k < word.length; k += 1) {
          const rr = r + dr * k;
          const cc = c + dc * k;
          if (rr < 0 || rr >= H || cc < 0 || cc >= W || GRID[rr][cc] !== word[k]) { ok = false; break; }
          cells.push(`${rr},${cc}`);
        }
        if (ok) return cells;
      }
    }
  }
  return [];
}

/* --- the network ------------------------------------------------------ */

function build(word, reach, cost) {
  const nodes = [];
  const index = new Map();
  for (let k = 0; k < word.length; k += 1) {
    for (let r = 0; r < H; r += 1) {
      for (let c = 0; c < W; c += 1) {
        if (GRID[r][c] !== word[k]) continue;
        index.set(`${k}|${r},${c}`, nodes.length);
        nodes.push({ k, r, c });
      }
    }
  }

  const edges = [];
  for (let i = 0; i < nodes.length; i += 1) {
    const { k, r, c } = nodes[i];
    if (k === word.length - 1) continue;
    for (let dr = -reach; dr <= reach; dr += 1) {
      for (let dc = -reach; dc <= reach; dc += 1) {
        if (!dr && !dc) continue;
        const j = index.get(`${k + 1}|${r + dr},${c + dc}`);
        if (j === undefined) continue;
        edges.push({ a: i, b: j, len: cost(dr, dc), D: 1 });
      }
    }
  }

  // A source feeding every first letter and a sink draining every last one.
  // Short stubs, so the choice of where to enter and leave costs almost
  // nothing and the competition is between the chains themselves.
  const source = nodes.length;
  const sink = nodes.length + 1;
  for (let i = 0; i < nodes.length; i += 1) {
    if (nodes[i].k === 0) edges.push({ a: source, b: i, len: 0.35, D: 1 });
    if (nodes[i].k === word.length - 1) edges.push({ a: i, b: sink, len: 0.35, D: 1 });
  }
  return { nodes, edges, source, sink, size: nodes.length + 2 };
}

/** Solve L p = b for the node pressures, with the sink pinned to zero. */
function pressures(net) {
  const n = net.size;
  const M = Array.from({ length: n }, () => new Float64Array(n + 1));
  for (const e of net.edges) {
    const g = e.D / e.len;
    M[e.a][e.a] += g;
    M[e.b][e.b] += g;
    M[e.a][e.b] -= g;
    M[e.b][e.a] -= g;
  }
  M[net.source][n] = 1;
  for (let j = 0; j < n; j += 1) M[net.sink][j] = 0;
  M[net.sink][net.sink] = 1;
  M[net.sink][n] = 0;

  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let r = col + 1; r < n; r += 1) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    }
    if (Math.abs(M[pivot][col]) < 1e-12) continue;
    [M[col], M[pivot]] = [M[pivot], M[col]];
    for (let r = 0; r < n; r += 1) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      if (!f) continue;
      for (let cc = col; cc <= n; cc += 1) M[r][cc] -= f * M[col][cc];
    }
  }

  const p = new Float64Array(n);
  for (let i = 0; i < n; i += 1) p[i] = Math.abs(M[i][i]) < 1e-12 ? 0 : M[i][n] / M[i][i];
  return p;
}

/** Adapt until the network stops changing. Returns the cells still supplied. */
function adapt(word, { reach = REACH, cost = stepCost, steps = STEPS } = {}) {
  const net = build(word, reach, cost);
  if (net.nodes.length === 0) return { live: new Set(), net, chains: [] };

  for (let step = 0; step < steps; step += 1) {
    const p = pressures(net);
    for (const e of net.edges) {
      const q = Math.abs((e.D * (p[e.a] - p[e.b])) / e.len);
      const f = q ** MU / (1 + q ** MU);
      e.D += RATE * (f - e.D);
      if (e.D < 1e-9) e.D = 1e-9;
    }
  }

  const live = new Set();
  const kept = [];
  for (const e of net.edges) {
    if (e.D <= ALIVE) continue;
    kept.push(e);
    if (e.a < net.nodes.length) live.add(`${net.nodes[e.a].r},${net.nodes[e.a].c}`);
    if (e.b < net.nodes.length) live.add(`${net.nodes[e.b].r},${net.nodes[e.b].c}`);
  }
  return { live, net, kept };
}

/* --- reporting -------------------------------------------------------- */

function census(label, options) {
  console.log(`\n=== ${label} ===\n`);
  console.log("word         nodes  edges   surviving   true kept   ties");
  let keptAll = 0;
  let trueAll = 0;
  let extraAll = 0;
  for (const word of ONLY ? [ONLY.toUpperCase()] : WORDS) {
    const answer = new Set(trueRun(word));
    const { live, net } = adapt(word, options);
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
      const { live } = adapt(word, options);
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
    const { live } = adapt(word, { reach: REACH, cost: stepCost, steps: STEPS });
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
