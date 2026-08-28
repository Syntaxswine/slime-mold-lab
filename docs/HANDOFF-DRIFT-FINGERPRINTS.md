# Handoff — can a flow fingerprint verify data?

**Written 2026-08-12/13.** One arc across two repos. It began as a question
about the word-search solver, produced a negative result worth keeping, and
ended by finding a real defect in a different project's drift controls. Read
[`HANDOFF-WORDSEARCH.md`](HANDOFF-WORDSEARCH.md) first for the solver itself.

---

## 1. The question

`tools/wordsearch.mjs` converges to a set of conductances that is a
deterministic function of (grid, word). That looks like a fingerprint: change
the data and it moves — and unlike a hash the movement has a **magnitude**, so
changes can be ranked rather than merely flagged. The owner asked whether that
could be used for database verification: *"the order of words would create a
very specific pattern and it might show where there are changes."*

## 2. The answer

**Not as a checksum, and the reason is structural.** Reproduce with
`node tools/wordsearch-sensitivity.mjs` (~65 s, 196 single-character mutations
of the packaged puzzle, all eighteen words re-solved each time):

| fingerprint | detects |
|---|---|
| the answer (which cells survive) | 106/196 — 54.1% |
| the fixpoint conductances | 140/196 — 71.4% |
| the trajectory (D integrated over 40 steps) | 190/196 — 96.9% |

A hash of the candidate edge list detects **100%** of graph changes in one O(n)
pass. Nothing here can win at detecting, and the whole cost is 400 iterations
of a dense O(n³) solve. **Framing it as a detector is the mistake.**

What it uniquely offers is *magnitude and ranking* — not "the graph changed"
but "the flow re-routed this much, along these edges". For a database that
maps to: rows are nodes typed by position in a required chain, edges are joins
with **length = what the hop costs**, and the converged conductances are which
join paths actually carry the work. Ten thousand innocuous edits give L1 = 0;
the three that rerouted a chain give L1 = 12. A hash fires on all 10,003.

Two caveats that were never resolved: the solve keeps **co-optimal ties** (11
here, on six words), so a trivial edit flipping between two equal-cost routes
produces a large L1 — the metric is not monotone until ties are handled. And
the cost is prohibitive: 196 mutations took 147 s on a 196-node graph, and
dense Gaussian elimination at 7,000 nodes is 10⁶× that.

## 3. The negative result — keep it, it is attractive and wrong

**"Fingerprint the trajectory, not the fixpoint."** The reasoning is good: the
converged state is an attractor, so a losing tube that held out twelve steps
and one that died at step three both end at 1e-9 and are indistinguishable.
Integrating D over the collapse should see more. It was **pre-registered** —
*"beats the fixpoint's 71.4% or the idea is wrong"* — and it passed, at 96.9%.

Then the quantity that actually decides it: is the movement a **distance**,
monotone in how much really changed? Spearman against the count of cells whose
fate the edit altered:

| | fixpoint | trajectory |
|---|---|---|
| all mutations | **0.938** | 0.837 |
| only those that changed a fate | **0.925** | 0.665 |

**The trajectory is far worse.** 85 of 196 edits move it while changing nothing
that matters, median L1 31.5, and its loudest readings sit on edits whose
ground truth is *zero*. Adding a candidate edge injects its whole 40-step
integral whether or not that edge ever carried anything — so it counts the
existence of **losers**, which is by definition the part of the data with no
consequence. Its extra 50 "detections" are its noise.

Which inverts the finding: **the fixpoint's 29% blindness is correct
behaviour.** It is blind to exactly the changes that do not matter, and the
proposed improvement would have destroyed that. The six mutations invisible to
everything are cells no query can reach — five are `J→Q` (neither letter is in
any of the eighteen words), the sixth a corner `Y` with no `A` in reach behind
it and no `L` or `U` ahead. That is a **coverage report**, not a defect.

> **The lesson, which cost the same mistake twice in one day:** pre-registration
> protects against moving the goalposts afterwards. It does nothing against
> choosing the wrong quantity beforehand.

A follow-up rank-gap diagnostic, meant to find what the fixpoint's residual
0.075 was, turned out to be **broken** — it ranked inside a block of 90 exact
ties, so its "worst disagreements" were all `truth = 0, L1 = 0.00`. The
residual is **unexplained**.

## 4. What did transfer: the method, not the model

Applied to `vugg-simulator`'s drift controls. The flow solve itself does not
fit there — no typed chain, no competing routes, no transport cost, and the
simulator *is* the physics, so nothing needs a surrogate. What transferred:

1. **Measure the incumbent's discrimination before proposing a replacement.**
2. **Ask what it structurally cannot see.**
3. **Check the top of the ranking against ground truth.**

Step 1 came back *negative* — vugg's "N scenarios moved" is healthy, not
saturated (37% of bumps move nothing, median 1, p90 8, 23 distinct values).
Step 2 found the defect.

## 5. The vugg finding

`tests-js/calibration.test.ts` gates on `expect(got).toEqual(baseline[name])`
— exact, misses nothing. `tools/baseline-diff.mjs` is the **summary a human
reads** at rebake time and asked a narrower question: species set plus the
**sum** of `total` across minerals per scenario. So three classes of real
movement never appeared in it — **redistribution** at constant total,
**size-only** (`max_um` is never read), and **active/dissolved split**.

Measured live at v271: **67 bumps, 280 scenario-instances** the gate calls
moved and the summary did not name. Dropped moves include
`proustite 378.5→7.7`, `native_copper 54.7→4.9`, `quartz 101.3→3068.2`.

Nothing bad shipped — the gate is exact and the strip digest caught what
mattered. What was damaged is the **record**. Two archived claims rest on the
deaf tool, and one is still uncorrected (§6).

**Landed additively**, after a review correction that was right:

| commit | |
|---|---|
| `04bff12` | the finding — but it *rewrote* `baseline-diff.mjs` and made the audit depend on the rewrite. A replacement, not an addition. |
| `a4d3f3f` | the correction. `baseline-diff.mjs` restored byte-identically; new logic in `tools/drift-analysis.mjs`; audit imports only that. |

The correction improved it on the merits: `04bff12` kept the old predicate as
an **inline copy**, which is exactly what "never re-implement the comparison
you are checking against" forbids. With the legacy tool preserved,
`legacySummary()` **runs it as a subprocess** and parses its verdict, so the
audit always reports what an operator would really see. The finding came back
identical to the instance, which is the evidence the copy had been faithful —
obtainable only by keeping the original.

**Verified 2026-08-13, 178 commits later: `baseline-diff.mjs` is still
byte-identical to its pre-work state and the audit still runs.** The additive
property held across all of it.

## 6. Open

1. **`js/15-version.ts`, the v215 entry, is still wrong.** It reads *"MEASURED
   baseline-diff 214↔215 = 0/37 — STRONGER than the predicted
   grimsel+tormiq-only ... every crystal's GROWTH HISTORY is bit-identical."*
   Both predicted scenarios moved — grimsel titanite 944.6→938.6, tormiq
   feldspar 16332.3→15965.5. **The pre-registration was right and the
   instrument scored it as beaten.** Left unedited deliberately: the version
   history is provenance, and an annotation *beside* the line (never a
   rewrite) is the owner's call.
2. **The `vugg-session-start` skill's rebake checklist** names `baseline-diff`
   but not `drift-audit`.
3. **Ties.** The fingerprint is not a distance until co-optimal routes are
   collapsed into equivalence classes.
4. **Warm-start on edit.** A single-row change perturbs a few edges; starting
   from the previous converged state instead of D=1 would cut most of the cost.
   Named consequence: hysteresis makes the fingerprint depend on edit *history*
   — fatal for verification, fine for anomaly detection. Choose deliberately.

## 7. What was never checked

Every number here comes from a 196-cell grid with uniform degree, planar
structure and short paths — an unusually well-behaved graph. A real join graph
is hub-heavy, and hubs are where flow concentrates and where ties and
instability get worse. No adversarial edit was ever attempted; given the
(correct) blindness to consequence-free changes, constructing an
invisible-but-meaningful edit should be easy, which is one more reason this is
not a security instrument.

## 8. Files

| path | what |
|---|---|
| `tools/wordsearch-sensitivity.mjs` | **the negative result, reproducible.** `--detect` and `--distance` |
| `tools/wordsearch-flow.mjs` | the solver it measures |
| vugg `tools/drift-analysis.mjs` | the stronger comparison, as a library |
| vugg `tools/drift-audit.mjs` | applies it across history; passive, always exits 0 |
| vugg `tools/baseline-diff.mjs` | **unchanged, deliberately** — the measuring stick |
| vugg `tests-js/drift-analysis.test.ts` | 18 tests incl. a regression block pinning the legacy tool's under-reporting *on purpose* |
