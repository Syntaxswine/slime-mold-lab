/**
 * The word search as a flow network. Shared by the census and the plate.
 *
 * Extracted verbatim from `tools/wordsearch.mjs` so that the renderer can
 * watch the adaptation happen rather than re-implementing it. The extraction
 * was verified by diffing the census and the VACATION plate against the output
 * of the single-file version: byte identical.
 *
 * The physics and the reasons for it are in `tools/wordsearch.mjs` and
 * `docs/HANDOFF-WORDSEARCH.md`. In one line: every cell bearing letter k of
 * the word is a node, an edge runs to a nearby cell bearing letter k+1 and its
 * length is what transport costs, flow is injected at the first letter and
 * drawn off at the last, and then dD/dt = f(|Q|) - D reabsorbs whatever
 * carries nothing. Tero et al. (2010), Science 327(5964):439-442.
 */

/* --- the puzzle ------------------------------------------------------ */

// Transcribed by eye from the Tree Valley Academy "Vacation" word search.
// TREAT AS APPROXIMATE: it has not been checked against the original character
// by character, and every number these tools print rests on it.
export const GRID = [
  "YNCGDXRKOSMJEP", "SBZUHNOITACAVL", "OQTJWESPHYFIDM", "HARNCVBLGWXRKZ",
  "CMOTELJDIFHPSU", "AGPYLWTNLQZLXB", "ESRAHEDBFNUAML", "BHIFSOVXZKLNPE",
  "FKAPWSHACEDELT", "XVOBQUPMRJPGFO", "NOYADILOHTEIKH", "LUSXVGZWRBVCRA",
  "DJFMTICKETAYQT", "RENIHSNUSPOBWG",
].map((r) => r.split(""));

export const WORDS = [
  "AIRPORT", "AIRPLANE", "BEACH", "FLIGHT", "FUN", "HOLIDAY", "HOTEL", "MOTEL",
  "PACK", "PASSPORT", "POOL", "RELAX", "SUNSHINE", "TICKET", "TRAVEL", "TRIP",
  "VACATION", "WINDOW",
];

export const H = GRID.length;
export const W = GRID[0].length;

/** Tero's f(Q) = Q^mu / (1 + Q^mu). Above 1 it sharpens onto single routes. */
export const MU = 1.4;
export const RATE = 0.25;
/** Conductance below which a tube counts as reabsorbed. */
export const ALIVE = 0.05;

/**
 * Transport cost in LATTICE STEPS, not Euclidean distance. On a square lattice
 * a mould moves one cell per step whichever way it goes. Under Euclidean cost
 * PACK is lost outright: its answer is diagonal at 4.24 while a bent path costs
 * 3.83, so the physics correctly finds the shortest chain and it is not the
 * one the puzzle intends. Euclidean scores 99/105; lattice steps score 105/105.
 */
export const stepCost = (dr, dc) => Math.max(Math.abs(dr), Math.abs(dc));
export const euclidCost = (dr, dc) => Math.hypot(dr, dc);

/* --- the answer the puzzle intends, for scoring ---------------------- */

const D8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

/** Where the word really is: a straight run of adjacent cells. */
export function trueRun(word) {
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

export function build(word, reach, cost) {
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
export function pressures(net) {
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

/**
 * Adapt until the network stops changing. Returns the cells still supplied.
 *
 * `onStep(step, net)` is called after each conductance update, which is how
 * the plate watches the search instead of only its answer. It observes; it
 * must not mutate, and the arithmetic is identical whether it is passed or not.
 */
export function adapt(word, {
  reach = 2, cost = stepCost, steps = 400,
  mu = MU, rate = RATE, alive = ALIVE, onStep = null,
} = {}) {
  const net = build(word, reach, cost);
  if (net.nodes.length === 0) return { live: new Set(), net, kept: [] };

  for (let step = 0; step < steps; step += 1) {
    const p = pressures(net);
    for (const e of net.edges) {
      const q = Math.abs((e.D * (p[e.a] - p[e.b])) / e.len);
      const f = q ** mu / (1 + q ** mu);
      e.D += rate * (f - e.D);
      if (e.D < 1e-9) e.D = 1e-9;
    }
    if (onStep) onStep(step, net);
  }

  const live = new Set();
  const kept = [];
  for (const e of net.edges) {
    if (e.D <= alive) continue;
    kept.push(e);
    if (e.a < net.nodes.length) live.add(`${net.nodes[e.a].r},${net.nodes[e.a].c}`);
    if (e.b < net.nodes.length) live.add(`${net.nodes[e.b].r},${net.nodes[e.b].c}`);
  }
  return { live, net, kept };
}

/**
 * Per-cell supply at this instant: the largest conductance of any tube meeting
 * the cell, keyed "r,c".
 *
 * Deliberately the MAXIMUM and not the sum. A cell where six weak candidate
 * tubes happen to meet is not six times better supplied than a cell on the one
 * tube carrying the word, and summing would make the crowded early plate
 * brightest exactly where the search is most confused.
 */
export function supply(net) {
  const byCell = new Map();
  for (const e of net.edges) {
    for (const end of [e.a, e.b]) {
      if (end >= net.nodes.length) continue;
      const key = `${net.nodes[end].r},${net.nodes[end].c}`;
      if (e.D > (byCell.get(key) ?? 0)) byCell.set(key, e.D);
    }
  }
  return byCell;
}
