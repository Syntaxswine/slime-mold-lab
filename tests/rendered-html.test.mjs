import assert from "node:assert/strict";
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

test("wraps stimulus distance across periodic boundaries", () => {
  const simulation = makeSimulation(10, "forage", 5);
  simulation.markers = [{ x: 0, y: 120, kind: "food", level: 1, radius: 8 }];
  const leftEdge = sampleField(simulation, 1, 120);
  const wrappedRightEdge = sampleField(simulation, GRID_W - 1, 120);
  assert.equal(leftEdge, wrappedRightEdge);
});
