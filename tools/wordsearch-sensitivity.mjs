#!/usr/bin/env node
/**
 * How much does the flow solve notice when its data changes?
 *
 * This exists because of a NEGATIVE RESULT that is attractive enough to be
 * proposed again — including by me, an hour after measuring it wrong. Keeping
 * the instrument is the only way that result survives.
 *
 * THE QUESTION. `tools/wordsearch.mjs` converges to a set of conductances that
 * is a deterministic function of (grid, word). That looks like a fingerprint:
 * change the data, the fingerprint moves, and — unlike a hash — the movement
 * has a MAGNITUDE, so changes can be ranked. Could it verify a database?
 *
 * WHAT IT IS NOT GOOD FOR: detecting change. Measured over all 196
 * single-character mutations of the packaged puzzle, every word re-solved:
 *
 *   fingerprint                                   detects
 *   the answer (which cells survive)              106/196   54.1%
 *   the fixpoint conductances                     140/196   71.4%
 *   the trajectory (D integrated over 40 steps)   190/196   96.9%
 *
 * A hash of the candidate edge list detects 100% of graph changes in one O(n)
 * pass. Nothing here can win at detecting, and framing it as a detector is the
 * mistake this tool records.
 *
 * THE NEGATIVE RESULT. "Fingerprint the trajectory, not the fixpoint" was
 * pre-registered — "beats 71.4% or the idea is wrong" — and passed at 96.9%.
 * Then the quantity that actually matters, whether the movement is a DISTANCE
 * monotone in how much really changed (Spearman against the count of cells
 * whose fate the edit altered):
 *
 *                                    fixpoint   trajectory
 *   all mutations                       0.938        0.837
 *   only those that changed a fate       0.925        0.665
 *
 * The trajectory is far WORSE. 85 of 196 edits move it while changing nothing
 * that matters, median L1 31.5, and its loudest readings sit on edits with a
 * ground truth of zero. Adding a candidate edge injects its whole 40-step
 * integral whether or not that edge ever carried anything — so the trajectory
 * counts the existence of LOSERS, which is by definition the part of the data
 * with no consequence. Its extra 50 "detections" are its noise.
 *
 * Which inverts the finding: the fixpoint's 29% blindness is CORRECT
 * BEHAVIOUR. It is blind to exactly the changes that do not matter, and the
 * proposed improvement would have destroyed that. The six mutations it cannot
 * see at all are cells no query touches — five are J→Q (neither letter appears
 * in any of the eighteen words) and the sixth is a corner Y with no A in reach
 * behind it and no L or U ahead. That is a coverage report, not a defect.
 *
 * THE LESSON, which cost the same mistake twice in one day: pre-registration
 * protects against moving the goalposts afterwards. It does nothing against
 * choosing the wrong quantity beforehand.
 *
 * WHERE IT WENT. The method — measure the incumbent's discrimination first,
 * then ask what it structurally cannot see — was then applied to vugg's drift
 * controls and found a real defect there. See docs/HANDOFF-DRIFT-FINGERPRINTS.md.
 *
 *   node tools/wordsearch-sensitivity.mjs --detect     ~80s
 *   node tools/wordsearch-sensitivity.mjs --distance   ~80s
 */
import { GRID, H, W, WORDS, adapt } from "./wordsearch-flow.mjs";

const argv = process.argv.slice(2);
const DETECT = argv.includes("--detect") || argv.length === 0;
const DISTANCE = argv.includes("--distance") || argv.length === 0;

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
/** The whole collapse happens inside 40 steps; after that nothing moves. */
const WINDOW = 40;
/** A deterministic, always-different substitution. */
const mutate = (ch) => ALPHABET[(ALPHABET.indexOf(ch) + 7) % 26];

/**
 * Both fingerprints from ONE solve, so the two columns can never drift apart
 * through a difference in how they were produced.
 */
function solveAll() {
  const fixpoint = new Map();
  const integral = new Map();
  const live = new Map();
  for (const word of WORDS) {
    const { net, live: cells } = adapt(word, {
      onStep: (step, n) => {
        if (step >= WINDOW) return;
        for (const e of n.edges) e.integral = (e.integral ?? 0) + e.D;
      },
    });
    live.set(word, cells);
    for (const e of net.edges) {
      if (e.a >= net.nodes.length || e.b >= net.nodes.length) continue;
      const a = net.nodes[e.a];
      const b = net.nodes[e.b];
      const key = `${word}|${a.k},${a.r},${a.c}>${b.k},${b.r},${b.c}`;
      fixpoint.set(key, e.D);
      integral.set(key, e.integral ?? 0);
    }
  }
  return { fixpoint, integral, live };
}

/** Edges that appear or vanish count in full, which is the point. */
function l1(a, b) {
  let sum = 0;
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    sum += Math.abs((a.get(key) ?? 0) - (b.get(key) ?? 0));
  }
  return sum;
}

/** Ties share the mean rank, or a block of equal values skews the answer. */
function spearman(xs, ys) {
  const rank = (values) => {
    const order = values.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]);
    const out = new Array(values.length);
    for (let i = 0; i < order.length;) {
      let j = i;
      while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j += 1;
      const shared = (i + j) / 2 + 1;
      for (let k = i; k <= j; k += 1) out[order[k][1]] = shared;
      i = j + 1;
    }
    return out;
  };
  const rx = rank(xs);
  const ry = rank(ys);
  const n = xs.length;
  const mean = (v) => v.reduce((s, x) => s + x, 0) / n;
  const mx = mean(rx);
  const my = mean(ry);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i += 1) {
    num += (rx[i] - mx) * (ry[i] - my);
    dx += (rx[i] - mx) ** 2;
    dy += (ry[i] - my) ** 2;
  }
  return num / Math.sqrt(dx * dy);
}

/** Every single-character mutation, measured both ways. */
function sweep() {
  const base = solveAll();
  const scale = {
    fixpoint: [...base.fixpoint.values()].reduce((s, v) => s + Math.abs(v), 0),
    integral: [...base.integral.values()].reduce((s, v) => s + Math.abs(v), 0),
  };
  const rows = [];
  for (let r = 0; r < H; r += 1) {
    for (let c = 0; c < W; c += 1) {
      const original = GRID[r][c];
      GRID[r][c] = mutate(original);
      const next = solveAll();
      GRID[r][c] = original;

      // Ground truth for "how much really changed": cells whose fate moved.
      let truth = 0;
      let answerMoved = false;
      for (const word of WORDS) {
        const a = base.live.get(word);
        const b = next.live.get(word);
        for (const cell of a) if (!b.has(cell)) truth += 1;
        for (const cell of b) if (!a.has(cell)) truth += 1;
        if (a.size !== b.size || [...a].some((cell) => !b.has(cell))) answerMoved = true;
      }
      rows.push({
        cell: `${r},${c}`,
        from: original,
        to: mutate(original),
        truth,
        answerMoved,
        fixpoint: l1(base.fixpoint, next.fixpoint),
        integral: l1(base.integral, next.integral),
        fixRel: l1(base.fixpoint, next.fixpoint) / scale.fixpoint,
        intRel: l1(base.integral, next.integral) / scale.integral,
      });
    }
  }
  return rows;
}

const started = Date.now();
const rows = sweep();
const n = rows.length;
const EPS = 1e-9;
const pct = (v) => `${String(v).padStart(3)}/${n}   ${((v / n) * 100).toFixed(1)}%`;

console.log(`\n${n} single-character mutations of the packaged puzzle,` +
  ` all ${WORDS.length} words re-solved   (${((Date.now() - started) / 1000).toFixed(0)}s)`);

if (DETECT) {
  const byAnswer = rows.filter((x) => x.answerMoved).length;
  const byFix = rows.filter((x) => x.fixRel > EPS).length;
  const byInt = rows.filter((x) => x.intRel > EPS).length;
  const blind = rows.filter((x) => x.intRel <= EPS);
  console.log("\nDETECTION — and this is the WRONG question; see the header.\n");
  console.log(`  the answer (which cells survive)   ${pct(byAnswer)}`);
  console.log(`  the fixpoint conductances          ${pct(byFix)}`);
  console.log(`  the trajectory                     ${pct(byInt)}`);
  console.log(`\n  seen only by the trajectory: ${rows.filter((x) => x.intRel > EPS && x.fixRel <= EPS).length}` +
    `   blind to everything: ${blind.length}`);
  console.log(`  blind cells: ${blind.map((x) => `${x.cell} ${x.from}→${x.to}`).join("   ")}`);
  console.log("  (every one is a cell no query can reach — a coverage report, not a defect)");
}

if (DISTANCE) {
  const changed = rows.filter((x) => x.truth > 0);
  const line = (label, subset) => console.log(`  ${label.padEnd(34)}` +
    `fixpoint ${spearman(subset.map((x) => x.fixpoint), subset.map((x) => x.truth)).toFixed(3)}` +
    `   trajectory ${spearman(subset.map((x) => x.integral), subset.map((x) => x.truth)).toFixed(3)}` +
    `   n=${subset.length}`);
  console.log("\nDISTANCE — the quantity that actually decides it.");
  console.log("Spearman of fingerprint movement against cells whose fate really changed.\n");
  line("all mutations", rows);
  line("only those that changed a fate", changed);

  const quiet = rows.filter((x) => x.truth === 0 && x.integral > 0);
  const med = quiet.map((x) => x.integral).sort((a, b) => a - b)[Math.floor(quiet.length / 2)];
  console.log(`\n  moved the trajectory but changed no cell's fate: ${quiet.length}/${n}` +
    `   median L1 ${med ? med.toFixed(2) : "-"}`);
  console.log("  loudest movement for the least real change:");
  for (const x of [...rows].sort((a, b) => b.integral / (b.truth + 1) - a.integral / (a.truth + 1)).slice(0, 4)) {
    console.log(`    ${x.cell.padEnd(7)} truth ${String(x.truth).padStart(3)} cells` +
      `   trajectory L1 ${x.integral.toFixed(1).padStart(8)}   fixpoint L1 ${x.fixpoint.toFixed(2).padStart(7)}`);
  }
  console.log("\n  VERDICT: the trajectory is a worse distance. Its extra detections are its");
  console.log("  noise — it counts losers, and losers are the part of the data with no");
  console.log("  consequence. The fixpoint's blindness is correct behaviour.");
}
