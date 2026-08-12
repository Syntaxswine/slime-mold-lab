# Living Weights — Phase 1

**Written 2026-08-12.** A text generator in which the organism's physical state
shifts which word gets chosen:

```
adjusted_logit[i] = lm_logit[i] + gain × confidence × mold_score[i]
```

then softmax and sample. Eight candidates, eight channels, one decision per
token. `/weights` in the app, `node tools/weights.mjs` on the command line.

Everything below that carries a number is reproducible from
`node tools/weights.mjs`. Several of these numbers contradict the design I
started with, and the ones that do are marked, because the reasoning that lost
is the part worth inheriting.

---

## 1. Acceptance criteria

| Criterion | State |
|---|---|
| Enter a prompt and generate step by step | `/weights`, RUN / STEP; `tools/weights.mjs run` |
| Eight biological signals visibly change candidate desirability | Channel flux → `score` → `adjustedProb`, all four shown per card |
| Gain 0 reproduces the model's unmodified distribution | Pinned three ways in `tests/living-weights.test.mjs`, including "the organism cannot change the text at gain 0, whatever it is doing" |
| Increasing gain produces observable change | 0.5 → 20% of tokens overridden, 1 → 37%, 2 → 47%, 3 → 83%, 8 → 93% |
| Every decision inspectable and replayable from its log | `tools/weights.mjs replay` verifies math, text chain, and reproduction-from-seed separately |
| A physical provider can replace the simulator without rewriting the engine | The contract is `advance` / `readSignals` / `reset`; two providers already swap through it |

## 2. What is where

```
lib/living-weights/
  types.ts               the contracts — provider, adapter, records
  weights.ts             normalise, combine, select, assign        <- the only place the organism can change anything
  generator.ts           one token per step(); controls are per-step and logged
  log.ts                 JSONL + the spec's CSV export
  replay.ts              three independent verifications
  providers/mold.ts      the Physarum engine as eight channels
  providers/sliders.ts   the null arm
  adapters/ngram.ts      offline LM with real logits
  adapters/local-http.ts llama.cpp / OpenAI-shaped local server (no server here; contract tested against fixtures)
app/weights/page.tsx     the interface
tools/weights.mjs        channels · run · ab · sweep · replay
public/corpora/          the corpus, served to the browser and read by the CLI from the same file
```

## 3. Four things the measurements overturned

**Baiting a channel destroys the signal.** The first design put a weak food
disc at each channel site — words as food sources, which is where the idea came
from. Measured over twenty reads, that collapses between-channel discrimination
from sd/noise **11–14** to about **2**, and the leading channel stops
persisting. Each disc servos its own patch to the same saturation, so what you
read is your own stimulus, not the organism. Channels are now passive
measurement regions, which is also what an electrode is in Phase 2. `level` is
still in the config; leave it at 0.

**The ring radius is not a taste decision.** Five radii × five seeds, scoring
between-channel variation against variation of the *same* channel across seeds
— position must explain less than the organism does:

| ring | mean flux | sd/noise | bias (<1 good) | leaders |
|---|---|---|---|---|
| r=30 | 45.7 | **2.4** | 0.84 | 6.8 |
| **r=45** | **54.1** | 8.9 | **0.35** | 5.8 |
| r=55 | 35.4 | 13.2 | 0.44 | 5.6 |
| r=80 | 15.3 | 13.7 | 0.71 | 5.6 |

Too near the middle and every channel reads the same core — sd/noise 2.4 is
body background, not an opinion. Too far out and the lattice-locked lobes take
over: one channel led 26% of reads and another 1%. An annular sector covering a
whole 45° wedge was tried and is worse than any disc (bias 0.82–0.92) because
it integrates the static core geometry back in.

**The ring phase argument was right and then wrong.** At r=80 the eight sites
split into two classes the square lattice treats differently — 19–21 mean flux
on the axes against 9–11 on the diagonals — and rotating by half a sector fixes
it, because 22.5 + k·45 is one orbit of the lattice point group. That reasoning
does not survive moving inward: at r=45 the lobe structure is much weaker
(angular CV 0.21 against 0.70 at r=85) and the rotation makes fairness *worse*,
0.35 → 0.62. The default is phase 0 because that is what measured better, not
because the argument was wrong. If you move the ring, re-run the measurement.

**A moving light does not keep the question open.** Left alone the network
consolidates: under `reticulate` the number of distinct leading channels falls
to 2 over 2700 ticks and the leader persists 97% of reads, so the organism's
contribution degenerates into a constant bias. An orbiting light disc was the
obvious fix and it fails — stirring drives the culture off the ring faster than
it re-forms, and mean channel flux over the last third of a run falls from 12.6
to **2.6**. The organism goes quiet rather than changing its mind.
`lightOrbitTicks` is kept for a Phase 3 installation that wants a visible lamp,
at a known cost in signal.

## 4. Measured properties of the signal

Reproduce with `node tools/weights.mjs channels`.

**A fresh plate has nothing to say, at full volume.** Between-channel spread is
indistinguishable from Poisson counting noise until about tick 200:

| warmup | sd/noise across five seeds |
|---|---|
| 0 | 0.6 – 1.4 &nbsp;*(noise)* |
| 200 | 4.6 – 7.2 |
| 400 | 7.2 – 11.5 |

The provider now lives through `warmupTicks: 400` and discards it. Without
that, the opening sentence of every run is driven by nothing at whatever gain
the operator set — and the confidence rail does *not* catch it, because an
undifferentiated culture still has a wide absolute spread. `tests/` pins both
directions: the warmed culture must discriminate and the cold one must not.

**The ring is fair.** Five seeds × 40 reads: sd between channels **2.92**,
sd within a channel across seeds **8.78**. Leadership runs 7–20% per channel
rather than 1–26%.

**Spread distribution**, which is what the normaliser is built on: p05 8.3,
p25 27.0, p50 36.7, p75 44.5, p95 56.3. The first draft of `DEFAULT_NORMALIZE`
was an order of magnitude too small, so the confidence rail carried full gain
on 100% of reads and silenced 0% — a guard that never fires is not a guard. At
`deadband 4 / activeSpread 15 / spreadFloor 3` it silences 1% and passes 90%,
biting only on the tail.

**Gain, measured on the default corpus:** 0.5 → 20% of tokens overridden,
1 → 37%, 2 → 47%, 3 → 83%, 5 → 90%, 8 → 93%. The default is **2**, because
that is where the brief's "shared authorship" actually sits; 3 is already the
culture leading.

## 5. Two numbers that mean different things

`tools/weights.mjs ab` prints both and says which is evidence:

```
first override at token 4.
12/45 decisions went against the model's own pick.
40/45 tokens end up different, most of them because the text had already
forked, not because the culture chose them.
```

Only the middle number counts interventions. Once one token is overridden the
two texts have diverged and everything downstream differs for context reasons.
A piece that quotes the third number is overselling itself by 3×.

## 6. Traps

- **A steady signal saturates.** Past the gain where the leader is decided,
  more gain changes the distribution but not the pick — gain 3 and gain 15 can
  override the same 20% of tokens. Divergence is the wrong quantity to assert
  monotonicity on; probability mass moved is the right one.
- **`<s>` is a real successor in the n-gram counts** (the padding means the
  second start marker follows the first). At low gain the model's own ranking
  buries it; at gain 5 the organism promotes it and the text degenerates into a
  row of markers. Filtered at the adapter.
- **A symmetric fixture cannot see an asymmetric bug** — the same lesson the
  engine review paid for. The `quality` test uses one doubted channel against
  seven trusted ones for that reason.
- **`node --test tests/`** does not run a directory on this Node; it tries to
  load `tests` as a module and reports one failing test with no detail. The
  test script names both files.
- **`readSignals` consumes the integration window.** Calling it twice serves
  the second caller zeros at quality 0. That is deliberate — stale flux served
  twice would be a silent lie — but it means nothing may read the provider
  casually, including the UI during render.

## 7. Honest limits

- **The n-gram is bench supply, not the artistic target.** It is a real model
  with real log-probabilities, which is what makes Phase 1 testable and
  bit-reproducible offline, but it is trained on 108 lines. The real path is
  `adapters/local-http.ts` against a local open-weights model. The Anthropic
  Messages API cannot serve this piece: no logprobs, and `temperature` /
  `top_p` / `top_k` are removed on the current frontier models.
- **`local-http.ts` has never spoken to a server.** The request shape and the
  response parser are tested against fixtures; the two invariants that will
  actually bite — that the server returns its own untruncated distribution, and
  that it is deterministic across runs — are documented at the top of the file
  and unverified.
- **A run driven from the interface is inspectable but not seed-reproducible**
  if the operator moved a dial mid-sentence. Every record carries the controls
  that produced it, so `verifyRun` still passes; `rerun` cannot, and says so.
  CLI runs are reproducible end to end.
- **Sentence quality is the corpus's, not the mechanism's.** Judge the
  mechanism on the A/B, not on the prose.

## 8. Phase 2 — what has to be true

> **Phase 2's sensor layer shipped 2026-08-12.** See
> [`LIVING-WEIGHTS-PHASE2.md`](LIVING-WEIGHTS-PHASE2.md). Everything predicted
> below held, and the section is kept as written so the prediction can still be
> read against the outcome. One thing it did not predict: the reading should
> not be broadband change at all, but the amplitude of the plasmodium's own
> contraction rhythm.

The provider contract does not change. What changes is that `raw` stops being a
count on a lattice and starts being volts, or pixels, and every constant in
`DEFAULT_NORMALIZE` and `valueScale` was measured on the lattice and **will not
transfer**. Re-measure them with the same instrument: `tools/weights.mjs
channels` is written against the provider interface, not against the mold.

The findings that do transfer, because they are about the shape of the problem
rather than about this engine:

- **Signal must be flux, not proximity.** Whatever the sensor, the reading has
  to track activity, not the presence of biomass.
- **Do not bait the channels.** A stimulated region reports the stimulus.
- **Prove the geometry is fair before believing any output** — between-channel
  variation must be smaller than the same channel's variation across
  independent cultures, or the dish is choosing the words.
- **Warm up, and refuse early readings.** The startup transient is real and
  looked exactly like signal.
- **Quality must reach the arithmetic, not just the log.** It multiplies the
  gain down; a disconnected electrode and a jammed region both read zero and
  only quality separates them.
