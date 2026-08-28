#!/usr/bin/env node
/**
 * The §5 generalisation: route a symbol target through a supplied substrate.
 *
 * Consumes MOIRÉ's `substrate/1` + `targetset/1` (contract
 * docs/PROPOSAL-SUBSTRATE-ENCODING.md §4), emits `route/1` their committed
 * `score.mjs` verifies. The word-search flow solver, freed from its letter
 * grid: nodes and edges arrive as data, the target is a symbol sequence, and
 * the route must VISIT nodes spelling it in order while WALKING wherever the
 * graph allows.
 *
 * THE GRAPH IS NOT THE SUBSTRATE — this is the design fact the vertex counts
 * forced. Consecutive target symbols are almost never kNN-adjacent (mean 5.6
 * instances of a symbol among 2,049 nodes), so a route walks THROUGH
 * non-matching nodes between consumptions. The solve therefore runs on the
 * WALK x SPELL product graph: state (i, k) = "at node i having spelled k
 * symbols", walk edges (i,k)-(j,k) at substrate cost for every substrate edge,
 * a consume transition (i,k)->(i,k+1) where symbol(i) == target[k]. At L=5 on
 * N=5 that is ~12.3K states / ~34K edges — decisively sparse, so the Kirchhoff
 * solve is conjugate gradient with a Jacobi preconditioner, per MOIRÉ's
 * sanction. Dense Gaussian died at this scale and was not ported.
 *
 * THREE ARMS, ONE GRAPH (§5.4). `dijkstra` is exact on the product graph and
 * exists here to PROVE THE FRAME: its 200/200 cost parity against MOIRÉ's
 * independent layered oracle (seam/in/oracle-routes-N5.json) is the evidence
 * that this construction implements the same problem, before anything
 * adaptive rides on it. Per A5 it is also the ceiling: on a fixed substrate
 * nothing can beat it, and the adaptive arm's job here is calibration
 * (approach the ceiling) ahead of the multi-target arm where no polynomial
 * ceiling exists.
 *
 * `adaptive` is Tero's dD/dt = f(|Q|) - D on the product graph. `frozen` is
 * the control: identical in every respect except D never adapts.
 *
 * EXTRACTION IS THE SAME FOR BOTH FLOW ARMS, and it is the honest part:
 * follow the largest OUTGOING flow from the source, greedily, no lookahead.
 * Potentials strictly decrease along flow, so the walk cannot cycle and must
 * reach the sink. The adaptive arm works because converged conductance makes
 * the greedy choice unambiguous; the frozen arm fails exactly insofar as
 * uniform conductance leaves the flow spread thin. Extracting with any
 * shortest-path pass instead would smuggle Dijkstra into the flow arms and
 * make the control meaningless.
 *
 * EARNED DETERMINISM (§5.5, per MOIRÉ's steer): no bit-identical-float
 * promises across BLAS builds. The discrete readout is margin-checked
 * instead — every greedy step records (best - runnerUp)/best, and route.json
 * carries the minimum. A near-tie readout is visible in the receipt, not
 * silently resolved. There is no RNG anywhere; `seed` is reported for the
 * schema and marked vestigial.
 *
 *   node tools/substrate-route.mjs substrate=seam/in/substrate-N5.json \
 *        targets=seam/in/targets-N5.json arm=dijkstra out=seam/out/routes.json
 *   ... arm=adaptive count=40 steps=200
 *   ... arm=dijkstra parity=seam/in/oracle-routes-N5.json   # frame proof
 */
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";

/** Tero constants, carried from the word-search where they were measured. */
export const MU = 1.4;
export const RATE = 0.25;
/** Entry/exit stubs, cheap so the choice of terminal costs ~nothing (word-search idiom). */
const STUB_LEN = 0.35;
/** Consume transitions are free in meaning; a resistor needs a nonzero length. */
const CONSUME_LEN = 0.35;

/* --- seam artifacts, receipts verified ------------------------------- */

/** Load and verify a receipted artifact: its sha256 field must recompute. */
export function loadReceipted(file) {
  const obj = JSON.parse(fs.readFileSync(file, "utf8"));
  if (obj.sha256) {
    const recomputed = crypto.createHash("sha256")
      .update(JSON.stringify({ ...obj, sha256: "" })).digest("hex");
    if (recomputed !== obj.sha256) {
      throw new Error(`${file}: internal sha256 does not recompute — refusing to consume`);
    }
  }
  return obj;
}

/* --- the walk x spell product graph ----------------------------------- */

/**
 * Build the product graph for one target. States are (node, spelled-count),
 * indexed k * n + i; two virtual terminals appended. Undirected edge list for
 * the flow arms; the dijkstra arm walks the same list.
 */
export function productGraph(sub, symbols) {
  const n = sub.nodes.length;
  const L = symbols.length;
  const S = (L + 1) * n;
  const SRC = S;
  const SNK = S + 1;
  const sym = sub.nodes.map((v) => v.symbol);

  const edges = [];
  for (let k = 0; k <= L; k += 1) {
    for (const e of sub.edges) {
      edges.push({ a: k * n + e.a, b: k * n + e.b, len: e.cost, walk: e.cost });
    }
  }
  for (let k = 0; k < L; k += 1) {
    for (let i = 0; i < n; i += 1) {
      if (sym[i] === symbols[k]) {
        edges.push({ a: k * n + i, b: (k + 1) * n + i, len: CONSUME_LEN, walk: 0 });
      }
    }
  }
  let sources = 0;
  for (let i = 0; i < n; i += 1) {
    if (sym[i] === symbols[0]) { edges.push({ a: SRC, b: i, len: STUB_LEN, walk: 0 }); sources += 1; }
    if (sym[i] === symbols[L - 1]) { edges.push({ a: L * n + i, b: SNK, len: STUB_LEN, walk: 0 }); }
  }
  return { n, L, S: S + 2, SRC, SNK, edges, sources };
}

/** Compact adjacency for a given edge-length accessor. */
function adjacency(g, lenOf) {
  const deg = new Uint32Array(g.S);
  for (const e of g.edges) { deg[e.a] += 1; deg[e.b] += 1; }
  const off = new Uint32Array(g.S + 1);
  for (let i = 0; i < g.S; i += 1) off[i + 1] = off[i] + deg[i];
  const nbr = new Int32Array(off[g.S]);
  const eix = new Int32Array(off[g.S]);
  const cur = Uint32Array.from(off.subarray(0, g.S));
  g.edges.forEach((e, idx) => {
    nbr[cur[e.a]] = e.b; eix[cur[e.a]] = idx; cur[e.a] += 1;
    nbr[cur[e.b]] = e.a; eix[cur[e.b]] = idx; cur[e.b] += 1;
  });
  return { off, nbr, eix, lenOf };
}

/* --- arm: dijkstra (exact; the frame proof) ---------------------------- */

/** Binary-heap Dijkstra over the product graph, walk costs only. */
export function solveDijkstra(g) {
  const dist = new Float64Array(g.S).fill(Infinity);
  const prev = new Int32Array(g.S).fill(-1);
  const adj = adjacency(g, (e) => e.walk);
  const heap = [[0, g.SRC]];
  dist[g.SRC] = 0;
  while (heap.length) {
    let m = 0;
    for (let i = 1; i < heap.length; i += 1) if (heap[i][0] < heap[m][0]) m = i;
    const [d, u] = heap.splice(m, 1)[0];
    if (d > dist[u]) continue;
    if (u === g.SNK) break;
    for (let p = adj.off[u]; p < adj.off[u + 1]; p += 1) {
      const v = adj.nbr[p];
      const w = g.edges[adj.eix[p]].walk;
      if (d + w < dist[v] - 1e-15) { dist[v] = d + w; prev[v] = u; heap.push([dist[v], v]); }
    }
  }
  if (!Number.isFinite(dist[g.SNK])) return { found: false, reason: "no route in product graph" };
  const states = [];
  for (let u = prev[g.SNK]; u !== -1 && u !== g.SRC; u = prev[u]) states.push(u);
  states.reverse();
  return { found: true, states, cost: dist[g.SNK] };
}

/* --- arms: adaptive / frozen (the flow solve) -------------------------- */

/** Conjugate gradient on the graph Laplacian, sink pinned, Jacobi preconditioned. */
function pressures(g, D, live) {
  const S = g.S;
  const cond = g.edges.map((e, i) => D[i] / e.len);
  const diag = new Float64Array(S);
  for (let i = 0; i < g.edges.length; i += 1) { diag[g.edges[i].a] += cond[i]; diag[g.edges[i].b] += cond[i]; }
  const b = new Float64Array(S);
  b[g.SRC] = 1;
  const x = new Float64Array(S);
  const matvec = (v, out) => {
    for (let i = 0; i < S; i += 1) out[i] = live[i] ? diag[i] * v[i] : 0;
    for (let i = 0; i < g.edges.length; i += 1) {
      const { a, b: bb } = g.edges[i];
      if (!live[a] || !live[bb]) continue;
      out[a] -= cond[i] * v[bb];
      out[bb] -= cond[i] * v[a];
    }
    out[g.SNK] = v[g.SNK]; // pin
  };
  const r = new Float64Array(S);
  const z = new Float64Array(S);
  const p = new Float64Array(S);
  const Ap = new Float64Array(S);
  matvec(x, r);
  for (let i = 0; i < S; i += 1) r[i] = (live[i] ? b[i] : 0) - r[i];
  r[g.SNK] = 0;
  const precond = (ri, i) => (i === g.SNK ? 0 : (live[i] && diag[i] > 0 ? ri / diag[i] : 0));
  for (let i = 0; i < S; i += 1) { z[i] = precond(r[i], i); p[i] = z[i]; }
  let rz = 0;
  for (let i = 0; i < S; i += 1) rz += r[i] * z[i];
  const b2 = 1;
  for (let it = 0; it < 6 * S; it += 1) {
    matvec(p, Ap);
    let pAp = 0;
    for (let i = 0; i < S; i += 1) pAp += p[i] * Ap[i];
    if (pAp <= 0) break;
    const alpha = rz / pAp;
    let r2 = 0;
    for (let i = 0; i < S; i += 1) { x[i] += alpha * p[i]; r[i] -= alpha * Ap[i]; r2 += r[i] * r[i]; }
    if (r2 < 1e-20 * b2) break;
    let rzNew = 0;
    for (let i = 0; i < S; i += 1) { z[i] = precond(r[i], i); rzNew += r[i] * z[i]; }
    const beta = rzNew / rz;
    rz = rzNew;
    for (let i = 0; i < S; i += 1) p[i] = z[i] + beta * p[i];
  }
  return x;
}

/** States connected to the source, so the Laplacian is nonsingular where solved. */
function reachable(g) {
  const adj = adjacency(g, () => 1);
  const live = new Uint8Array(g.S);
  const stack = [g.SRC];
  live[g.SRC] = 1;
  while (stack.length) {
    const u = stack.pop();
    for (let p = adj.off[u]; p < adj.off[u + 1]; p += 1) {
      const v = adj.nbr[p];
      if (!live[v]) { live[v] = 1; stack.push(v); }
    }
  }
  return live;
}

/**
 * Greedy max-outflow readout, shared by both flow arms. Potentials strictly
 * decrease along flow, so this cannot cycle and must reach the sink. Returns
 * the state walk and the minimum decision margin (earned determinism).
 */
function extract(g, D, p) {
  const adj = adjacency(g, (e) => e.len);
  const states = [];
  let u = g.SRC;
  let minMargin = 1;
  let guard = 0;
  while (u !== g.SNK) {
    if ((guard += 1) > g.S + 4) return { found: false, reason: "extraction exceeded state count" };
    let best = -1;
    let bestQ = 0;
    let second = 0;
    for (let q = adj.off[u]; q < adj.off[u + 1]; q += 1) {
      const e = g.edges[adj.eix[q]];
      const v = adj.nbr[q];
      const flow = (D[adj.eix[q]] / e.len) * (p[u] - p[v]);
      if (flow > bestQ) { second = bestQ; bestQ = flow; best = v; } else if (flow > second) second = flow;
    }
    if (best === -1) return { found: false, reason: "flow dead-ends before the sink" };
    if (bestQ > 0) minMargin = Math.min(minMargin, (bestQ - second) / bestQ);
    u = best;
    if (u !== g.SNK) states.push(u);
  }
  return { found: true, states, minMargin };
}

export function solveFlow(g, { adapt = true, steps = 200 } = {}) {
  const live = reachable(g);
  if (!live[g.SNK]) return { found: false, reason: "sink unreachable from source" };
  const D = new Float64Array(g.edges.length).fill(1);
  let p = pressures(g, D, live);
  let used = 0;
  if (adapt) {
    for (let s = 0; s < steps; s += 1) {
      used = s + 1;
      let maxDelta = 0;
      for (let i = 0; i < g.edges.length; i += 1) {
        const e = g.edges[i];
        const q = Math.abs((D[i] / e.len) * (p[e.a] - p[e.b]));
        const f = q ** MU / (1 + q ** MU);
        const delta = RATE * (f - D[i]);
        D[i] = Math.max(1e-9, D[i] + delta);
        maxDelta = Math.max(maxDelta, Math.abs(delta));
      }
      p = pressures(g, D, live);
      if (maxDelta < 1e-6) break;
    }
  }
  const out = extract(g, D, p);
  return { ...out, iterations: used };
}

/* --- route/1 emission -------------------------------------------------- */

/** Collapse product states to substrate nodes; consume steps repeat a node. */
function statesToPath(g, states) {
  const nodes = [];
  for (const s of states) {
    const i = s % g.n;
    if (nodes.length === 0 || nodes[nodes.length - 1] !== i) nodes.push(i);
  }
  return nodes;
}

/** The scorer's own checks, run before claiming anything (self-verification). */
export function selfVerify(sub, target, route, edgeMap, symOf) {
  if (!route.found) return route;
  let cost = 0;
  for (let i = 1; i < route.path.length; i += 1) {
    const c = edgeMap.get(`${route.path[i - 1]},${route.path[i]}`);
    if (c === undefined) return { ...route, found: false, path: [], cost: null, reason: `emitted a non-edge at step ${i}` };
    cost += c;
  }
  let want = 0;
  for (const v of route.path) if (want < target.symbols.length && symOf.get(v) === target.symbols[want]) want += 1;
  if (want !== target.symbols.length) {
    return { ...route, found: false, path: [], cost: null, reason: `spells ${want}/${target.symbols.length}` };
  }
  if (cost > target.budget + 1e-6) return { ...route, found: false, path: [], cost: null, reason: `cost ${cost.toFixed(3)} over budget` };
  return { ...route, cost: Number(cost.toFixed(6)) };
}

/* --- CLI --------------------------------------------------------------- */

function isCliEntry() {
  try {
    return import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}`
      || import.meta.url.endsWith(path.basename(process.argv[1] || ""));
  } catch { return false; }
}

function runCli() {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => a.split("=")));
  const arm = args.arm ?? "dijkstra";
  if (!["adaptive", "frozen", "dijkstra"].includes(arm)) throw new Error(`unknown arm ${arm}`);
  const sub = loadReceipted(args.substrate);
  const set = loadReceipted(args.targets);
  const count = args.count ? Number(args.count) : set.targets.length;
  const steps = args.steps ? Number(args.steps) : 200;

  const edgeMap = new Map();
  for (const e of sub.edges) { edgeMap.set(`${e.a},${e.b}`, e.cost); edgeMap.set(`${e.b},${e.a}`, e.cost); }
  const symOf = new Map(sub.nodes.map((v) => [v.id, v.symbol]));

  const routes = [];
  const t0 = Date.now();
  for (const t of set.targets.slice(0, count)) {
    const g = productGraph(sub, t.symbols);
    let r;
    if (arm === "dijkstra") r = solveDijkstra(g);
    else r = solveFlow(g, { adapt: arm === "adaptive", steps });
    let route = {
      version: "route/1", substrateSha: sub.sha256, targetSha: set.sha256,
      arm, targetId: t.id,
      found: Boolean(r.found),
      path: r.found ? statesToPath(g, r.states) : [],
      cost: null,
      iterations: r.iterations ?? 0,
      seed: 0, // vestigial: no RNG exists in this engine
      engine: arm === "dijkstra" ? "product-dijkstra" : "tero-flow-cg",
      minMargin: r.minMargin != null ? Number(r.minMargin.toFixed(6)) : null,
      reason: r.reason ?? null,
    };
    route = selfVerify(sub, t, route, edgeMap, symOf);
    if (route.found && route.cost != null && route.cost > t.budget + 1e-6) route.found = false;
    routes.push(route);
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  if (args.out) fs.writeFileSync(args.out, JSON.stringify(routes, null, 1) + "\n");
  const found = routes.filter((r) => r.found);
  console.log(`${arm}: ${found.length}/${routes.length} found in ${elapsed}s` +
    (found.length ? `, median cost ${[...found.map((r) => r.cost)].sort((a, b) => a - b)[Math.floor(found.length / 2)].toFixed(1)}` : "") +
    (args.out ? `  -> ${args.out}` : ""));

  if (args.parity) {
    const oracle = JSON.parse(fs.readFileSync(args.parity, "utf8"));
    const byId = new Map(oracle.map((r) => [r.targetId, r]));
    let match = 0;
    let mismatch = 0;
    for (const r of routes) {
      const o = byId.get(r.targetId);
      if (!o) continue;
      const same = r.found === o.found && (!r.found || Math.abs(r.cost - o.cost) < 1e-3);
      if (same) match += 1;
      else { mismatch += 1; if (mismatch <= 5) console.log(`  MISMATCH target ${r.targetId}: mine ${r.found}/${r.cost} vs oracle ${o.found}/${o.cost}`); }
    }
    console.log(`parity vs oracle: ${match}/${match + mismatch}${mismatch ? "  <-- FRAME NOT PROVEN" : "  (frame proven)"}`);
  }
}

if (isCliEntry()) runCli();
