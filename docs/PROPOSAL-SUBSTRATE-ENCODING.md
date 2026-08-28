# Proposal — the multidimensional moiré as an encoding substrate

**This file exists in two repositories and must stay byte-identical:**
`slime-mold-lab/docs/PROPOSAL-SUBSTRATE-ENCODING.md` and
`topographic-moire/research/PROPOSAL-SUBSTRATE-ENCODING.md`.
A contract that is duplicated is a contract that drifts. If you change one, change both
in the same pass and re-record the hash at the bottom.

Two agents work from this: **MOLD** owns `slime-mold-lab`, **MOIRÉ** owns
`topographic-moire`. Neither writes in the other's repo. Everything crossing between
them crosses as a file with a schema fixed below.

---

## 1. The question

Not "decode the pattern" — an FFT already recovers the reciprocal module and a mold is a
worse spectrum analyser. The question is **encoding**:

> You have something you want encoded. Given source material with structure, find where
> in it that thing can be made to happen — and if nowhere, find the smallest change to
> the source material that makes it possible.

The source material is an N-grating interference field. The search is over
**routes × substrate parameters** jointly, which is what makes it a transport problem
rather than a lookup.

## 2. What is already measured

N line gratings at equal angles `kπ/N`, summed then thresholded to 35% ink. Local
alphabet `p(r)` = number of distinct r×r configurations:

| substrate | p(5) | ≈ bits/site | translational period? |
|---|---:|---:|---|
| N=2 (4-fold) | 112 | 6.8 | yes, r=0.998 |
| N=3 (6-fold) | 200 | 7.6 | yes, r=1.007 |
| **N=5 (10-fold)** | **5,107** | **12.3** | no, r=0.840 |
| N=7 (14-fold) | 4,225 | 12.0 | no, r=0.667 |
| matched random | 23,111 | 14.5 | no |

Periodic → quasiperiodic buys ≈ **5 bits per site**. The periodic/quasiperiodic split
lands exactly on the crystallographic restriction theorem (only 2,3,4,6-fold rotation is
compatible with a lattice; these patterns have 2N-fold symmetry, so only N=2 and N=3 can
be periodic).

**Caveats, stated so nobody rediscovers them.** `p(9)` was sampling-saturated (~87k
windows, counts of 65–72k) and is not reported. Repetitivity — "can the same encoding be
relocated elsewhere in the substrate" — is **unmeasured**: exact window matching is
destroyed by pixel quantisation of a continuous field (a *periodic* substrate scored only
38%), and tolerance-2 matching makes everything match within ~10px including random. The
metric does not discriminate at either setting. See §8.

## 3. Why quasiperiodic and not random

Random has the larger alphabet, so capacity is not the argument. The argument is:

| | alphabet | key to regenerate | addressable sites |
|---|---|---|---|
| periodic | too small | tiny | yes |
| **quasiperiodic** | **large** | **tiny — (N, pitch, angles, phases)** | **yes — de Bruijn indices** |
| random | largest | the entire field | no |

Large alphabet **+** small key **+** analytic addressing is the specification for a code.
Random cannot make that argument, and this is the claim the experiment must actually test
(see the key-size measurement in §6).

## 4. The interface — the seam between the two repos

Three files cross. Every producer writes a receipt; every consumer records the sha256 of
what it consumed, so any result traces to the exact inputs that produced it.

**`substrate.json`** — produced by MOIRÉ, consumed by MOLD.

```json
{
  "version": "substrate/1",
  "params": { "N": 5, "pitch": 12, "anglesDeg": [0,36,72,108,144],
              "phases": [0,0,0,0,0], "size": 600, "inkFraction": 0.35 },
  "alphabet": { "radius": 5, "symbolCount": 5107 },
  "nodes": [ { "id": 0, "x": 123, "y": 456, "symbol": 3172,
               "deBruijn": [k0,k1,k2,k3,k4], "perp": [u,v] } ],
  "edges": [ { "a": 0, "b": 1, "cost": 14.2 } ],
  "sha256": "<hash of this file with the sha256 field emptied>"
}
```

`symbol` is an integer index into the alphabet, stable for a given `(params, radius)`.
`deBruijn` are the integer grid indices of the vertex; `perp` is its perpendicular-space
coordinate — the position in the hidden higher-dimensional lattice this 2-D point
projects from. MOLD may ignore `deBruijn`/`perp`; they exist for §7.

**`target.json`** — produced by MOIRÉ, consumed by MOLD.

```json
{ "version": "target/1", "symbols": [3172, 88, 4410], "tolerance": 0,
  "substrateSha": "<sha256 of the substrate it was drawn against>" }
```

**`route.json`** — produced by MOLD, consumed by MOIRÉ.

```json
{ "version": "route/1",
  "substrateSha": "...", "targetSha": "...",
  "arm": "adaptive" | "frozen" | "dijkstra",
  "found": true, "path": [0,17,42], "cost": 812.4,
  "iterations": 5000, "seed": 42, "engine": "tero-flow" }
```

`arm` is mandatory and must be one of the three. A run that cannot report which arm it
is, is not a result.

## 5. MOLD's side — what `slime-mold-lab` needs

1. **Accept an arbitrary supplied graph.** The word-search flow solver is hard-wired to a
   letter grid; it needs to consume `substrate.json` nodes/edges instead.
   `tools/wordsearch-flow.mjs` is the reference — it already has the `onStep` observer and
   was extracted byte-identically, so it is the right thing to generalise, not rewrite.
2. **Multi-terminal, not single source→sink.** A quasiperiodic field has no natural
   endpoints. Tokyo-rail shape: many terminals, one network.
3. **A target-satisfaction cost term.** The route must visit nodes whose `symbol` spells
   `target.symbols` in order, within `tolerance` substitutions.
4. **Three arms, same entry point**: `adaptive` (Tero `dD/dt = f(|Q|) − D`), `frozen`
   (conductance never adapts — the word-search control, which scored 1.17×), and
   `dijkstra` (plain shortest-path over the same graph). See the kill criterion in §6.
5. **Deterministic replay.** Same `seed` + same inputs must give the same `route.json`.

**Blocking dependency.** Review finding 5 — *the advertised SEED does not reproduce* —
is still open, and finding 3 — *the nutrient field swamps stigmergy, 69.3% of turn
decisions* — is still open. Both were diagnosed against the **Jones agent engine**. The
word-search used **Tero flow**, which is a different code path and may be unaffected.
MOLD should confirm which engine this runs on and whether either finding binds before
building. If it runs on the agent engine, finding 3 makes the network a readout of the
input and the experiment is vacuous — check it first, it is cheap to check.

## 6. MOIRÉ's side — what `topographic-moire` needs

1. **Substrate generator** → `substrate.json`, from `(N, pitch, angles, phases, size)`.
2. **Alphabet census** → the `symbol` index per node, at a fixed radius.
3. **de Bruijn indexing** → `deBruijn` and `perp` per vertex, computed analytically from
   the grating parameters rather than read off the raster.
4. **Target generator** → random targets of length L drawn from the alphabet.
5. **Scorer** → consumes `route.json`, verifies the path actually spells the target,
   and reports yield / cost / key size.

Existing instruments to build on, already in `research/instruments/`: `braille.mjs`
(rendering and verification of pictures), and the receipt/oracle pattern from
`moire-gen.mjs` + `moire-verify.mjs` for the hashing discipline above.

## 7. Pre-registered predictions — fixed before anything runs

**P1 — the alphabet is the binding constraint.** Encoding yield (fraction of random
length-5 targets routable, 200 targets per N) is **≥3× higher for N≥4 than for N≤3**.
*If yield is flat across the N=3→4 boundary, the alphabet is not what limits encoding and
the premise of this proposal is wrong.* This is the falsifier.

**P2 — key size is where quasiperiodic wins.** Bits to regenerate substrate + route:
quasiperiodic **< 200 bytes** (parameters + path); matched-random needs the whole field
(≈45 KB at 600² bits). Expect **>100× separation.** If random competes here, §3 is wrong.

**P3 — the frozen arm is near chance**, ≈1.2× as in the word-search.

**P4 (stretch, ~20%)** — final conductance or node degree correlates with `perp`, the
perpendicular-space coordinate. A positive result means the network sorted vertices by a
coordinate that exists only in the higher-dimensional lattice — the mold recovering hidden
dimensions from a 2-D shadow. Only attempt after P1–P3 land.

**Kill criterion, binding on both sides.** If the `dijkstra` arm matches `adaptive` on
yield *and* cost, **the mold adds nothing and we report that.** Physarum's advantage, if
it exists, should appear in the joint route × substrate-parameter search, not in
single-route finding. If it does not appear there either, this is a routing problem with a
nice picture attached, and saying so is the result.

## 8. Open instrument problems

- **Repetitivity is unmeasured** (§2). The likely fix is to stop comparing rasterised
  windows and compare **de Bruijn vertex indices analytically** — the structure is exactly
  computable, so it should not be measured through a rasteriser at all. This matters
  because "can this encoding be relocated" is a real property of the design.
- **`p(r)` needs a saturation guard.** Report the sampled-window count alongside every
  count, and refuse to report a value above ~60% of it.

## 9. Discipline carried in from the moiré work

- An instrument must be able to **refuse**. Every measurement gets a null or a control arm.
- **Mutation-test before trusting a suite.** Three of six errata in the prior investigation
  were in test code, not production code.
- **A number names its rig.** `p(5) = 5107` is for this pitch, this ink fraction, this
  radius. Quote it with them.
- **A metric must discriminate.** The repetitivity metric above failed this twice in one
  session, in both directions. Check that a proposed metric separates the controls
  *before* running it on the real thing.

---

*Contract hash: recorded at commit time in both repos. If the two copies disagree, the
one in `topographic-moire` is authoritative for §4 (the schemas) and the one in
`slime-mold-lab` is authoritative for §5 (MOLD's requirements).*
