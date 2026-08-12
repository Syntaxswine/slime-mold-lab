# Handoff — MYX / slime-mold-lab

**Written 2026-08-11.** Read this before touching the engine. Most of what
follows is measured, not assumed, and several numbers contradict what the code
and its README imply.

---

## 1. What this repo is

A Jones-2010 Physarum (slime mould) agent simulator. The whole model is
`lib/physarum-engine.ts` (~360 lines) and `app/page.tsx` (~650 lines);
everything else is vinext / Cloudflare Worker scaffolding.

**Provenance matters here.** The original build was authored by **Codex**, in a
single commit, as one side of a model-comparison exercise. It is preserved
exactly at tag **`codex-baseline`** and must stay that way — do not "fix"
anything on that tag. `main` carries the same build plus a reviewed set of
fixes. The original also still lives at `GTP/slime-mold-lab` on the authoring
machine; **do not edit that copy** — git refuses to run there anyway (it is
owned by a different Windows account).

```
codex-baseline ──┐
                 ├─ main   (working baseline: baseline + fixes + tools + this doc)
claude/review-fixes ┘
```

## 2. State

`npm test` → 13/13. `npm run lint` → clean. `npm run build` → succeeds.

Three defects were found by review, fixed on `main`, and each is pinned by a
test that was **verified to fail against `codex-baseline`** — a test that passes
on both versions is decoration, and two of the first drafts did exactly that.

| # | Defect | Evidence |
|---|--------|----------|
| 1 | `advanceSimulation` was missing Jones 2010 §2.1 clause 1 (`F > FL && F > FR` → hold). Control fell through to the flank comparison, so an agent heading straight up-gradient rotated 45° **away** from its best sample. Flank ties measured at 0.0%, so no agent could ever hold a heading. | Restoring it: coverage +25–31%, mean trail +33–83%, edge contrast +45%. Closed vein loops appear. |
| 2 | Light discs tested only the **destination** cell. Radius 23, step 1 — an agent standing inside one when it was placed had every escape route rejected. | A shift-click at the colony centre froze **1252 of 1401** agents permanently, still holding their lattice sites at t+1500. Now 0 stranded; discs still reject entry from outside. |
| 3 | Render ramp `1-exp(-trail*0.052)` was calibrated for the 90 deposit clamp the field never approaches. The layer the legend calls CHEMICAL FIELD rendered within a few RGB steps of the plate. | Field p90 is 3–6, max ~19. Ramp is now `0.15`; vein-body trail renders at red 72 against a plate of 9. |

## 3. Measured facts about the engine

Reproduce all of these with `node tools/measure.mjs`.

**This is a jammed lattice gas, not a gas.** Move-success is **19.7% / 22.7% /
12.2%** (forage / reticulate / minimal) — 77–88% of moves are blocked. A
blocked agent deposits nothing *and* has its heading randomised, so the large
majority of "turn decisions" any metric counts were never executed. Anything
that changes crowding changes such a metric without changing behaviour.

**A bright marker is a tomb.** Because blocked moves never deposit, a strong
food marker packs the lattice solid and switches its own trail off:

| level | peak field | occupancy | trail inside | successful landings/tick |
|---|---|---|---|---|
| 1.0 | 102 | **100%** | 0.00 | **0.00** |
| 0.25 | 25.6 | 99% | 0.31 | 0.00 |
| 0.06 | 6.1 | 94% | 3.36 | 1.98 |
| **0.04** | **4.1** | 92% | 3.93 | **6.27** |

**The usable window is `level` 0.02–0.06.** Every intuition about marker
strength in this engine is 20–50× too strong. Note the consequence for any
"escalate the pull until the mould arrives" scheme: **escalation makes it
worse.** Escalate the detection radius instead.

**The trail cannot accumulate.** Half-life is **8 steps** (forage). A 500-step
traversal leaves 10⁻¹⁹ of the trail laid at its start. Any feature that needs a
visible record of a long path needs a **second, slow field** — the volatile
chemoattractant cannot carry it.

**Background clumping is bimodal.** On a marker-free board, agent counts within
r=8 are p50 **0**, p90 **68**, p99 **163**. You are either inside the body or
nowhere near it. Any arrival/proximity test scored against an absolute count
fires on empty substrate — an r=8 threshold of 30 is met at **13%** of random
empty spots. Score arrival as *excess over the live board's own distribution*,
or on **flux** (successful moves landing in the region), which is the quantity
that actually discriminates 0.00 from 6.27.

## 4. Open — not fixed, deliberately

- **The nutrient field swamps stigmergy.** `4300/(d²+42)` peaks at 102 against
  a trail field whose max is ~19 and mean is ~0.9. In the *reticulate* preset
  **69.3%** of turn decisions are set by static marker geometry rather than by
  the trail the agents built (forage: 13.8%). Marker-driven behaviour is not
  emergent behaviour; the README's framing is only honest for forage. Fixing
  this is a design call — rescale the food term, or say so in MODEL SCOPE.
- **The advertised SEED does not reproduce a run.** `resizePopulation` and
  `addRandomMarker` draw from the same `simulation.random()` stream the physics
  uses, so touching any control forks the trajectory. Verified: same seed, one
  population nudge *to the value it already had* → divergent run. Give the UI
  its own RNG.
- **The rAF loop can die permanently.** `app/page.tsx:191` returns without
  rescheduling if `getContext` returns null, unlike the guard above it.
- **`coverage` aliases.** `lib/physarum-engine.ts` strides by 6 through a
  360-wide grid, so it only ever samples columns 0, 6, … 354 — every row, one
  sixth of the columns. Vertical striping would bias it.
- **`MAX_MARKERS = 14`, and `addMarker` splices from the FRONT.** Past 14
  markers it silently evicts the *oldest* entries. Anything that wants more
  than a handful of markers must keep its own list and assign `sim.markers`
  directly rather than routing through `addMarker`.
- **Dead template scaffolding.** `drizzle-orm` is in `dependencies` (so it
  ships) with an empty `db/schema.ts`; `app/chatgpt-auth.ts` is fully written
  and unused; `examples/d1/`, `drizzle.config.ts`, and the `DB`/`IMAGES`
  bindings in `worker/index.ts` are unused. `layout.tsx` calls `headers()` only
  to build an absolute OG URL, which is why the build prints `? Unknown` for
  `/` and cannot statically classify a page with no server data.
  `tsc --noEmit` errors in `worker/` and `db/` are pre-existing on
  `codex-baseline`, not regressions.

## 5. Tools

| Command | What it does |
|---|---|
| `node tools/measure.mjs` | The whole characterisation suite. Every number above. |
| `node tools/measure.mjs crater` | One section: `blocked`, `crater`, `persistence`, `arrival`, `dominance`, `ramp`. |
| `node tools/render.mjs` | Renders PNGs through `app/page.tsx`'s exact pixel mapping, reading the ramp coefficient out of the source so the image cannot drift from the app. |
| `node tools/render.mjs --light 180,120,23` | Places a light disc mid-run — this is how defect 2 was demonstrated. |
| `npm test` | 13 tests. Five pin the three fixes and fail on `codex-baseline`. |

## 6. Traps that cost real time

- **The preview pane does not composite when hidden**, so `requestAnimationFrame`
  never fires and the canvas sits at `T+ 00000` with a 300×150 backing store.
  You cannot verify rendering in-browser that way — use `tools/render.mjs`.
  What the pane *can* still do is serve the transformed module: pull URLs from
  `performance.getEntriesByType('resource')` and `fetch` them to confirm your
  change actually reached the bundle.
- **Never append a cache-buster to a module URL** on the vite dev server.
  `fetch(url + '?bust=' + Math.random())` creates a new module id whose query
  defeats the loader's language inference — the `.ts` file is parsed as JS, dies
  on the first `export type`, and vite reports it over HMR as a **real-looking
  build error naming your file**. Nothing is wrong; reload clears it.
- **Do not encode load-bearing logic as an empty branch.** The fix for defect 1
  was originally `if (forwardBest) { /* hold */ }` — and the dev transform
  strips the comment, leaving `if (…) {}`. One `no-empty` autofix and the
  defect returns with no behavioural diff for a reviewer to see. It is now a
  named `forwardBest` boolean guarding the flank branches. ESLint does not flag
  the empty block because `no-empty` counts a comment as content — precisely
  the content the build removes.
- **The turn rule cannot be tested by censusing a live population.** Agents
  deposit and occupy as the shuffled step runs, so a pre-step sensor census
  goes stale, and blocked agents randomise their heading for unrelated reasons.
  Test it with **one agent on a hand-painted field** — and make the **flanks
  unequal**, because with `left == right` the buggy chain also leaves the
  heading alone and a symmetric fixture passes either way.

## 7. Next step — "Living Weights"

> **Phase 1 shipped 2026-08-12.** Read
> [`LIVING-WEIGHTS.md`](LIVING-WEIGHTS.md), which supersedes this section for
> anything that has since been measured. Four of the constraints predicted
> below survived contact; one — baiting each channel with a weak food disc —
> turned out to destroy the signal it was meant to create, and the record of
> that is in the newer document. The rest of this section is kept as written,
> because a prediction is only worth something if you can still see what it
> said.

The commissioned direction is a text-generation system in which the organism's
changing physical state alters which word gets chosen: a language model supplies
top-N next-token candidates with their logits, those candidates are assigned to
eight channels, and a normalised per-channel signal from the mould shifts the
distribution before sampling — `adjusted_logit[i] = lm_logit[i] + gain ×
mold_score[i]`, softmax, sample. Phase 1 is a simulated organism; Phase 2 swaps
in a real sensor; Phase 3 is the installation.

**Blocking architectural finding: the Anthropic Messages API does not expose
logprobs.** There is no `logprobs` parameter and no logprob field in the
response — you get content blocks, `stop_reason`, and `usage`. Separately,
`temperature` / `top_p` / `top_k` are **removed** on current frontier Claude
models (400 on Opus 5, Opus 4.8/4.7, Fable 5; non-default values rejected on
Sonnet 5), so the spec's temperature control does not map onto them either.
**The candidate-plus-logit source must be a local open-weights model** —
llama.cpp, HF transformers, MLX — anything where the logit tensor is readable
before sampling. Run it behind the same small local HTTP/WebSocket bridge the
spec already proposes for sensor acquisition. This is also the only way to
honour the deterministic-replay acceptance criterion: a hosted API cannot
promise bit-reproducible replay.

**Phase 1's provider should be this engine, not eight sliders.** A slider
cannot reproduce the properties that will define the real piece — 122–2161
steps per commitment, channels that jam to zero throughput, an 8-step trail
half-life, and a body with spatial inertia that cannot be in two places. Build
against those and Phase 2 is a swap; build against sliders and it is a rewrite.

Constraints this repo's measurements already settle for that build:

- **Signal = flux, not proximity.** Proximity is near-binary with a 13% false
  positive rate (§3). Flux discriminates 0.00 (jammed) from 6.27 (feeding) and
  has an honest physical analogue for Phase 2.
- **Channel markers must run at `level` 0.02–0.06.** A channel run "hot" reads
  zero forever and looks exactly like a dead sensor.
- **Persistent mapping should be the default; shuffled belongs as a control
  arm.** The mould's inertia is hundreds of steps, so reshuffling
  candidate→channel assignments every token guarantees its state cannot track
  the semantics — the influence degenerates into spatially-structured noise,
  which is precisely the random-number generator the brief disclaims. Running
  shuffled *alongside* as a null is the stronger scientific claim.
- **Expect habituation, not reinforcement.** Because a heavily-visited region
  jams, a channel the mould favours will see its flux **fall** over a long run.
  Real and interesting, but the opposite of "develops preferences".
- **Wire the quality metadata into the math, not just the log.** With a bimodal
  channel distribution, a per-step z-score blows up on steps where all eight
  channels read ~0 — you divide by a near-zero spread and inject enormous noise
  from nothing, so the organism appears to seize control hardest exactly when
  it has nothing to say. Floor the normaliser and drop `gain` toward 0 when
  channel spread is below threshold.
- **Threshold/commitment mode is an installation clock**, not an interactive
  one — minutes to hours per sentence. Build the fixed-timer mode too and
  expect to demo on it.

A word-sequence prototype exploring the ancestor of this idea (words as an
ordered chain of food markers) established that the mould *will* walk an
imposed order, that route variance is near zero without obstacles (0.7–1.0
cells across seeds) and ~5× higher with barriers (3.8–5.0), and — importantly —
that **a scalar field encodes a path, not a direction along it**. No memory
layer of this kind will ever make the mould recall an *order*; the order is
always the author's. What is achievable on a repeat pass is better path
fidelity and shorter per-leg latency.

Two design questions still open for the owner: whether the text is authored
(you place the words) or discovered (the mould lays out its own arrangement),
and which local model provides the logits.
