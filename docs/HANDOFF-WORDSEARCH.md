# Handoff — the plate reads a word search

**Written 2026-08-12.** A design session, not a finished piece. Read this
before touching `tools/wordsearch.mjs`; four designs were tried and three of
them failed for reasons that are cheap to repeat and expensive to rediscover.

---

## 1. The idea

Give a culture a word-search grid as its substrate and let it find the words.
The owner's framing, which turned out to be right in every particular that
mattered:

> word search is going to create a lot of false positives because a lot of the
> first letters in the word you are searching for are there, but if the next
> letter doesn't appear near the first one the colony on the first letter dies
> creating an aversion spot

That is a real Physarum mechanism, not a metaphor. Reid, Latty, Dussutour &
Beekman (2012), *PNAS* 109(43):17490, show the plasmodium uses its own
extracellular slime as **externalised spatial memory** and actively avoids it:
pre-coat an arena uniformly and goal-reaching collapses from 96% to 33%,
because you have erased its record of where it already failed.

## 2. Where it landed

**Tero adaptation on a letter-typed supply chain.** The final design is the
owner's fourth framing, and it is the published Physarum model:

> each food source needs to be next to the correct types of food source to
> activate — like a supply chain, each next step enriches the step before it,
> but they need to be nearby to transport the finished product

Every cell bearing a letter of the target word is a node. An edge runs from a
cell bearing letter *k* to a nearby cell bearing letter *k+1*, and its length
is the cost of moving material along it. Flow is injected at every first
letter and drawn off at every last one. Then one rule:

```
dD/dt = f(|Q|) − D          f(Q) = Q^μ / (1 + Q^μ)
```

Tubes carrying flow thicken; tubes carrying none are reabsorbed. Tero, Takagi,
Saigusa, Ito, Bebber, Fricker, Yumiki, Kobayashi & Nakagaki (2010), *Science*
327(5964):439–442, [doi:10.1126/science.1177894](https://doi.org/10.1126/science.1177894)
— the model behind the maze solving and the Tokyo rail network, already in this
repo's README.

**Nothing searches.** No path enumeration, no backtracking, no bookkeeping
about which chain a cell belongs to. Solve Kirchhoff, read the flows, adjust
every conductance locally, repeat. Cells with no route from the first letter
to the last carry no flow and are reabsorbed however many of the word's
letters happen to sit near them.

**Measured on the packaged puzzle** (`node tools/wordsearch.mjs`):

| | |
|---|---|
| true cells kept | **105 / 105**, all eighteen words |
| surviving cells not in any answer | 11 of 196 |

The eleven are **ties, not errors**. PACK keeps eight cells for a four-letter
word: two chains of identical minimal cost. Tero's model keeps co-optimal
routes and so does a real plasmodium — the shortest-path result is for a maze
with a *unique* solution.

For VACATION the plate reabsorbs everything except row 1:

```
 . . . . . . . . . . . . . .
 . . . . . N O I T A C A V .
 . . . . . . . . . . . . . .
```

## 3. Which constant actually decides the answer

**Transport cost does the discriminating; `reach` only bounds the graph.**
This corrects a claim made in the session and it is worth being exact about,
because the earlier designs really did need a hard distance cap and this one
does not. Measured over the whole puzzle:

| reach | recall | ties | VACATION's edges |
|---|---|---|---|
| 1 | 105/105 | 11 | — |
| 2 | 105/105 | 11 | 67 |
| 3 | 105/105 | 11 | — |
| 5 | 105/105 | 11 | 228 |

Identical, every time. A long hop costs more and simply never wins, so the cost
function subsumes the cap. Reach is a performance knob, not a correctness one.
Keep it small because the edge count grows fast.

The owner's insistence that the distance rule was load-bearing was right about
the designs it was said of — staged food and local density have no cost
function, so the cap is the only thing making a chain a chain. Introducing
transport cost is what made it redundant.

That does not rescue proximity as a *substitute* for linkage. A purely areal
rule cannot work at all:

| word | windows holding all its letters, r=2 | r=4 | but the answer needs |
|---|---|---|---|
| VACATION | 1 | 148 | r≥4 |
| SUNSHINE | 0 | 127 | r≥4 |
| AIRPORT | 12 | 148 | r≥3 |

A word is a **line**; a window is a **blob**. Any window big enough to hold an
eight-cell run holds 81 cells, and at that size 148 of 196 positions qualify.
Shrink it until it discriminates and the answer no longer fits inside it. For
VACATION the single qualifying window at r=2 is not even the answer.

**Transport cost is in lattice steps, not Euclidean distance.** On a square
lattice a mould moves one cell per step whichever way it goes, so a straight
diagonal must not cost 1.41 per letter while a straight orthogonal costs 1.

| cost model | recall | ties |
|---|---|---|
| Euclidean | 99/105 | 7 |
| **lattice steps** | **105/105** | 11 |

Under Euclidean cost PACK is lost outright, 0 of 4: its answer is diagonal at
4.24 while a bent path costs 3.83, so the physics correctly finds the shortest
chain and it is not the puzzle's. Recall is the number that matters — a
variant that loses true cells is wrong however few ties it keeps.

## 4. Three designs that failed, and why

**(a) Enumerate chains and score them with a budget.** Works statistically —
the cheapest chain is the puzzle's answer for 17 of 18 words — but it is a
graph search with the organism as a display for it. The mould contributes
nothing. Abandoned on principle, not on performance.

**(b) Local density: "the right letters, linked, in a close space."** Cannot
work, for the structural reason in §3. A one-dimensional fact is not
recoverable from an areal measurement.

**(c) Staged food with a nutrient timer.** Reveal the letters one at a time,
give each colony a clock, starve it if the next letter is not within reach.
Preserved as `tools/wordsearch-plate.mjs`. It demonstrably prunes — six V
colonies fall to five, then three, then two, with scars appearing exactly
where a colony had no continuation — but it can never do both halves at once:

| drain | scars | true cells kept |
|---|---|---|
| 0.0028 | 17 | **1 of 8** |
| 0.0004 | 0 | 6 of 8 |

Fast enough to kill the impostors is fast enough to starve the answer's own
first letters before the word completes. The tension is structural: survival
was a **clock**, and a clock cannot know whether a cell is on a route to
anywhere. Replacing the clock with **throughput** dissolves it entirely, which
is what §2 does.

## 5. Traps paid for

- **Scars must be weak.** Across 84 aversion discs on a 196-cell plate: at
  level 1 the culture's own trail decides **0%** of its turns and it is a
  puppet walking someone else's maze. Usable window **0.008–0.02** — *weaker*
  than the food window of 0.02–0.06, because there are far more scars than
  baits. Movement stays at 17–23% throughout, so scars bias without blocking,
  which is what Reid's slime actually does.
- **`MAX_MARKERS` is 14 and `addMarker` evicts from the FRONT.** A 196-cell
  plate must assign `sim.markers` directly or almost every cell silently
  vanishes.
- **The engine has no persistent tube.** Trail half-life is 8 steps, so the
  culture follows the newest food and abandons everything behind it. Anything
  needing a structure that survives across stages must carry it itself.
- **A "no reuse" rule must mean "not spent on an *earlier* letter."** Written
  as `stage === -1` it also stops a cell being fed during its own stage: the
  cell took one mouthful, became spent, and starved eighteen ticks later.
- **The grid is transcribed by eye** from the puzzle image and has never been
  checked character by character. Every number in this document rests on it.
  Verifying it is the cheapest possible first task.

## 6. What to build next

1. **The plate.** This is the flow network, not the picture. The converged
   conductances map back onto the 360×240 lattice as attractant, and the Jones
   agents grow along the surviving tubes — the culture physically draws what
   the flow already decided. `tools/wordsearch-plate.mjs` already holds the
   grid-to-lattice mapping and the PNG painter for living tissue, fed letters
   and scars; it needs a different source of truth about what should be alive.
2. **Show the search, not just the answer.** The conductances tell a story over
   time: everything thick at first, then thinning onto the chains. Rendering
   the adaptation as frames is the piece, and the finished plate is the print.
3. **Scars.** The flow design has no aversion mechanism yet, because it does
   not need one. Whether reabsorbed tubes should scar is an aesthetic call —
   it would make the failed search legible in the final image, which was the
   original appeal.
4. **A denser puzzle.** On this grid the eighteen true answers already occupy
   96 of 196 cells — **49%** — so "everything dies but the answer" can never
   clear more than half the plate. Hunting one word at a time retreats to
   2–5%, which is the dramatic version. A larger, sparser grid would let the
   all-words plate be dramatic too.

## 7. Files

| path | what |
|---|---|
| `tools/wordsearch.mjs` | the flow design. census, per-word plate, `--compare` |
| `tools/wordsearch-plate.mjs` | superseded staged-food prototype; kept for its lattice mapping, its PNG painter, and its record |
| `tools/png.mjs` | dependency-free PNG writer, extracted from `render.mjs` |

`tools/render.mjs` still carries its own copy of the PNG encoder and could now
import `tools/png.mjs` instead. Left alone deliberately: it is a working tool
and this was not the session to touch it.
