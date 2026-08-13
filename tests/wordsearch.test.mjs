import assert from "node:assert/strict";
import test from "node:test";

import {
  ALIVE,
  WORDS,
  adapt,
  build,
  euclidCost,
  stepCost,
  supply,
  trueRun,
} from "../tools/wordsearch-flow.mjs";

/** The whole census in one number, so a regression cannot hide inside a word. */
function score(options = {}) {
  let kept = 0;
  let total = 0;
  let ties = 0;
  for (const word of WORDS) {
    const answer = new Set(trueRun(word));
    const { live } = adapt(word, options);
    kept += [...answer].filter((cell) => live.has(cell)).length;
    total += answer.size;
    ties += [...live].filter((cell) => !answer.has(cell)).length;
  }
  return { kept, total, ties };
}

test("the flow solve keeps every true cell of every word", () => {
  assert.deepEqual(score(), { kept: 105, total: 105, ties: 11 });
});

test("the eleven survivors that are not answers sit on six words, not one", () => {
  // PACK is the example the tool header uses and it is only four of them.
  // If this distribution ever moves, the "extras are ties, not errors" claim
  // has to be re-argued rather than repeated.
  const perWord = WORDS.map((word) => {
    const answer = new Set(trueRun(word));
    const { live } = adapt(word);
    return [word, [...live].filter((cell) => !answer.has(cell)).length];
  }).filter(([, extra]) => extra > 0);
  assert.deepEqual(perWord, [
    ["AIRPORT", 2], ["FLIGHT", 1], ["HOTEL", 1], ["MOTEL", 1], ["PACK", 4], ["PASSPORT", 2],
  ]);
});

test("transport cost is in lattice steps: euclidean loses PACK outright", () => {
  const answer = new Set(trueRun("PACK"));
  const { live } = adapt("PACK", { cost: euclidCost });
  assert.equal([...answer].filter((cell) => live.has(cell)).length, 0);
  assert.equal(score({ cost: euclidCost }).kept, 99);
});

test("reach bounds the graph but does not decide the answer", () => {
  // The correction recorded in the handoff. A long hop costs more and never
  // wins, so the cost function subsumes the distance cap.
  for (const reach of [1, 2, 3, 5]) {
    assert.deepEqual(score({ reach }), { kept: 105, total: 105, ties: 11 }, `reach ${reach}`);
  }
  assert.ok(build("VACATION", 5, stepCost).edges.length > build("VACATION", 2, stepCost).edges.length);
});

test("onStep observes the adaptation without changing it", () => {
  // The plate renderer walks the solve through this callback. If passing it
  // perturbed the arithmetic, every picture would be of a different search
  // than the census reports.
  const plain = adapt("VACATION");
  const seen = [];
  const watched = adapt("VACATION", {
    onStep: (step, net) => seen.push([step, Math.max(...net.edges.map((e) => e.D))]),
  });
  assert.deepEqual([...watched.live].sort(), [...plain.live].sort());
  assert.equal(seen.length, 400);
  assert.equal(seen[0][0], 0);

  // AFTER the update, not before. Every edge starts at D = 1, so a callback
  // fired one statement earlier would report exactly 1 here and every frame of
  // the film would be a step out of phase with the search it claims to show.
  // Found by mutation: moving the call above the solve left all seven tests
  // green until this line existed.
  assert.ok(seen[0][1] < 1, `step 0 should already be adapted, saw D max ${seen[0][1]}`);
  assert.ok(Math.abs(seen[0][1] - 0.821) < 0.002, `step 0 D max was ${seen[0][1]}`);
});

test("the reabsorption threshold has two orders of magnitude of slack", () => {
  // ALIVE is 0.05, and a mutation to 0.005 changes no test — correctly, because
  // by convergence there is nothing anywhere near it. Recording the margin is
  // worth more than a test that would fail: it says the constant is not doing
  // hidden work, and names the range over which that stays true.
  const { net } = adapt("VACATION");
  const conductances = net.edges.map((e) => e.D).sort((a, b) => b - a);
  const live = conductances.filter((d) => d > 0.01);
  const dead = conductances.filter((d) => d <= 0.01);
  assert.ok(Math.min(...live) >= 0.4, `weakest surviving tube ${Math.min(...live)}`);
  assert.ok(Math.max(...dead) <= 1e-6, `strongest reabsorbed tube ${Math.max(...dead)}`);
});

test("supply is the largest tube meeting a cell, not the sum of them", () => {
  // A junction of many weak candidates must not read as better supplied than a
  // cell on the one tube that carries the word.
  const net = { nodes: [{ r: 0, c: 0 }, { r: 0, c: 1 }, { r: 0, c: 2 }], edges: [] };
  net.edges.push({ a: 0, b: 1, D: 0.3 }, { a: 0, b: 2, D: 0.3 }, { a: 1, b: 2, D: 0.4 });
  const byCell = supply(net);
  assert.equal(byCell.get("0,0"), 0.3);
  assert.equal(byCell.get("0,1"), 0.4);
});

test("the search really does collapse, and it collapses onto the answer", () => {
  // The plate's whole narrative in one assertion: everything lit, then only
  // the word. Without the first half there is nothing to watch die.
  const answer = new Set(trueRun("VACATION"));
  const live = [];
  adapt("VACATION", {
    steps: 40,
    onStep: (step, net) => {
      if (step === 0 || step === 39) live.push([...supply(net)].filter(([, d]) => d > ALIVE));
    },
  });
  const [first, last] = live;
  assert.ok(first.length > 50, `expected the whole plate lit at first, got ${first.length}`);
  assert.equal(last.length, answer.size);
  assert.ok(last.every(([cell]) => answer.has(cell)));
});
