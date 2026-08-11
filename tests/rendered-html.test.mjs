import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import {
  addMarker,
  advanceSimulation,
  GRID_W,
  makeSimulation,
  MAX_MARKERS,
  PRESETS,
  resizePopulation,
  sampleField,
} from "../lib/physarum-engine.ts";

const projectRoot = new URL("../", import.meta.url);

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("https://myx.test/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the MYX simulator shell and metadata", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>MYX — Digital Plasmodium<\/title>/i);
  assert.match(html, /Intelligence,/i);
  assert.match(html, /Guide the plasmodium/i);
  assert.match(html, /Jones, J\. \(2010\)/i);
  assert.match(html, /https?:\/\/[^"<]+\/og\.png/i);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton|Starter Project/i);
});

test("ships an inspectable research-grounded interaction model", async () => {
  const [page, engine, layout, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/physarum-engine.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    access(new URL("../public/og.png", import.meta.url)),
  ]);

  assert.match(engine, /function advanceSimulation/);
  assert.match(engine, /const forward = sense\(0\)/);
  assert.match(engine, /const left = sense\(-sensorAngle\)/);
  assert.match(engine, /const right = sense\(sensorAngle\)/);
  assert.match(engine, /simulation\.occupancy\[nextCell\] !== -1/);
  assert.match(engine, /Fisher–Yates/);
  assert.match(page, /10\.1162\/artl\.2010\.16\.2\.16202/);
  assert.match(page, /10\.1126\/science\.1177894/);
  assert.match(page, /aria-label="Simulation controls"/);
  assert.match(layout, /summary_large_image/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  await assert.rejects(access(new URL("app/_sites-preview/", projectRoot)));
});

test("keeps one agent per site under deterministic evolution", () => {
  const settings = PRESETS.forage.settings;
  const first = makeSimulation(2_000, "forage", 12345);
  const second = makeSimulation(2_000, "forage", 12345);

  for (let step = 0; step < 12; step += 1) {
    advanceSimulation(first, settings);
    advanceSimulation(second, settings);
  }

  assert.deepEqual(first.x, second.x);
  assert.deepEqual(first.y, second.y);
  assert.deepEqual(first.trail, second.trail);
  assert.equal(
    first.occupancy.reduce((count, value) => count + Number(value !== -1), 0),
    first.count,
  );
  const occupied = new Set();
  for (let i = 0; i < first.count; i += 1) {
    const cell = `${first.x[i]},${first.y[i]}`;
    assert.equal(occupied.has(cell), false, `duplicate occupancy at ${cell}`);
    occupied.add(cell);
  }
});

test("applies one marker ceiling to every insertion path", () => {
  const simulation = makeSimulation(100, "forage", 7);
  for (let i = 0; i < MAX_MARKERS * 3; i += 1) {
    addMarker(simulation, { x: i, y: i, kind: i % 2 ? "food" : "light", level: 1, radius: 8 });
  }
  assert.equal(simulation.markers.length, MAX_MARKERS);
  assert.equal(simulation.markers.at(-1).x, MAX_MARKERS * 3 - 1);
});

test("resizes population without violating lattice occupancy", () => {
  const simulation = makeSimulation(400, "forage", 81);
  resizePopulation(simulation, 900);
  assert.equal(simulation.count, 900);
  assert.equal(
    simulation.occupancy.reduce((count, value) => count + Number(value !== -1), 0),
    900,
  );
  resizePopulation(simulation, 250);
  advanceSimulation(simulation, PRESETS.forage.settings);
  assert.equal(simulation.count, 250);
  assert.equal(
    simulation.occupancy.reduce((count, value) => count + Number(value !== -1), 0),
    250,
  );
});

// One agent on a hand-painted field. With a single agent nothing else deposits
// mid-step and no move can ever be blocked, so the heading change after one
// step is the turn rule and nothing else.
function soloAgent(seed, headingSamples) {
  const settings = PRESETS.forage.settings;
  const simulation = makeSimulation(1, "forage", seed);
  simulation.markers = [];
  simulation.occupancy.fill(-1);
  simulation.x[0] = 100;
  simulation.y[0] = 100;
  simulation.angle[0] = 0; // facing +x
  simulation.occupancy[100 * GRID_W + 100] = 0;

  // Sensor landing sites for a heading of 0 at 22.5 degrees and offset 9.
  const sites = { forward: [109, 100], left: [108, 97], right: [108, 103] };
  for (const [which, value] of Object.entries(headingSamples)) {
    const [x, y] = sites[which];
    simulation.trail[y * GRID_W + x] = value;
  }
  return { simulation, settings };
}

test("holds heading when the forward sensor is strongest (Jones 2010 clause 1)", () => {
  const { simulation, settings } = soloAgent(4242, { forward: 40, left: 0, right: 0 });
  const sensorAngle = (settings.sensorAngle * Math.PI) / 180;
  const at = (offset) =>
    sampleField(simulation, 100 + Math.cos(offset) * settings.sensorOffset,
                            100 + Math.sin(offset) * settings.sensorOffset);
  assert.ok(at(0) > at(-sensorAngle) && at(0) > at(sensorAngle), "fixture is not forward-dominant");

  advanceSimulation(simulation, settings);

  // Wander is the only permitted change; a rotation is 45 degrees (0.785 rad).
  assert.ok(
    Math.abs(simulation.angle[0]) <= settings.wander,
    `agent rotated ${simulation.angle[0].toFixed(3)} rad away from its strongest sensor`,
  );
});

test("still turns toward the stronger flank when forward is not the best", () => {
  const left = soloAgent(4242, { forward: 10, left: 40, right: 0 });
  advanceSimulation(left.simulation, left.settings);
  assert.ok(
    left.simulation.angle[0] < -0.5,
    `expected a left rotation, got ${left.simulation.angle[0].toFixed(3)} rad`,
  );

  const right = soloAgent(4242, { forward: 10, left: 0, right: 40 });
  advanceSimulation(right.simulation, right.settings);
  assert.ok(
    right.simulation.angle[0] > 0.5,
    `expected a right rotation, got ${right.simulation.angle[0].toFixed(3)} rad`,
  );
});

test("the hold-heading branch is reachable in a live population", () => {
  const settings = PRESETS.forage.settings;
  const simulation = makeSimulation(2_000, "forage", 4242);
  for (let step = 0; step < 200; step += 1) advanceSimulation(simulation, settings);

  const before = Float32Array.from(simulation.angle.subarray(0, simulation.count));
  advanceSimulation(simulation, settings);

  // Every other outcome moves the heading by a turn angle or randomizes it
  // outright, so "changed by no more than wander" counts exactly the agents
  // that held. Before the clause was restored this was zero, every step.
  let held = 0;
  for (let i = 0; i < simulation.count; i += 1) {
    if (Math.abs(simulation.angle[i] - before[i]) <= settings.wander) held += 1;
  }
  assert.ok(
    held > simulation.count * 0.05,
    `only ${held}/${simulation.count} agents held their heading; the clause is unreachable`,
  );
});

test("lets an agent walk out of a light disc placed on top of it", () => {
  const settings = PRESETS.forage.settings;
  const simulation = makeSimulation(3_000, "forage", 90210);
  for (let step = 0; step < 200; step += 1) advanceSimulation(simulation, settings);

  const light = { x: 180, y: 120, kind: "light", level: 1, radius: 23 };
  addMarker(simulation, light);
  const caught = [];
  for (let i = 0; i < simulation.count; i += 1) {
    const dx = simulation.x[i] - light.x;
    const dy = simulation.y[i] - light.y;
    if (dx * dx + dy * dy < light.radius * light.radius) caught.push(i);
  }
  assert.ok(caught.length > 50, `expected the disc to catch agents, got ${caught.length}`);

  for (let step = 0; step < 400; step += 1) advanceSimulation(simulation, settings);

  const stranded = caught.filter((i) => {
    const dx = simulation.x[i] - light.x;
    const dy = simulation.y[i] - light.y;
    return dx * dx + dy * dy < light.radius * light.radius;
  });
  // A light disc repels; it must not be a cage that holds agents forever.
  assert.equal(stranded.length, 0, `${stranded.length}/${caught.length} agents never escaped`);
});

test("keeps light discs closed to agents approaching from outside", () => {
  const settings = PRESETS.forage.settings;
  const simulation = makeSimulation(3_000, "forage", 5150);
  const light = { x: 180, y: 120, kind: "light", level: 1, radius: 23 };
  // Clear the colony out of the disc first, then seal it.
  simulation.markers = [];
  addMarker(simulation, light);
  for (let step = 0; step < 300; step += 1) advanceSimulation(simulation, settings);

  let intruders = 0;
  for (let i = 0; i < simulation.count; i += 1) {
    const dx = simulation.x[i] - light.x;
    const dy = simulation.y[i] - light.y;
    if (dx * dx + dy * dy < light.radius * light.radius) intruders += 1;
  }
  assert.equal(intruders, 0, `${intruders} agents entered a sealed light disc`);
});

test("renders the trail field well clear of the background", () => {
  const settings = PRESETS.reticulate.settings;
  const simulation = makeSimulation(settings.population, "reticulate", 41721);
  for (let step = 0; step < 600; step += 1) advanceSimulation(simulation, settings);

  const page = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
  const ramp = page.match(/1 - Math\.exp\(-sim\.trail\[i\] \* ([\d.]+)\)/);
  assert.ok(ramp, "could not find the trail intensity ramp in page.tsx");
  const k = Number(ramp[1]);

  // The 90th percentile of a live field is the vein body — the thing the
  // legend calls CHEMICAL FIELD. It has to be visibly above the #090b0a plate.
  const sorted = Float32Array.from(simulation.trail).sort();
  const p90 = sorted[Math.floor((sorted.length - 1) * 0.9)];
  const red = 8 + (1 - Math.exp(-p90 * k)) * 176;
  assert.ok(red > 60, `trail p90 renders at red=${red.toFixed(0)}, indistinguishable from the plate`);
});

test("wraps stimulus distance across periodic boundaries", () => {
  const simulation = makeSimulation(10, "forage", 5);
  simulation.markers = [{ x: 0, y: 120, kind: "food", level: 1, radius: 8 }];
  const leftEdge = sampleField(simulation, 1, 120);
  const wrappedRightEdge = sampleField(simulation, GRID_W - 1, 120);
  assert.equal(leftEdge, wrappedRightEdge);
});
