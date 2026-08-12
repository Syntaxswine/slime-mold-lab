# MYX — Digital Plasmodium

An interactive, research-grounded visualization of *Physarum polycephalum*
growth. Thousands of agents independently sense a shared chemoattractant
field, rotate, move, and deposit new trail. Diffusion and decay turn those
local actions into dynamic transport networks.

## Model

The implementation follows the multi-agent approximation described by Jeff
Jones (2010):

1. Each agent samples the trail map at forward, forward-left, and
   forward-right sensors.
2. It rotates toward the strongest sample and moves one simulation cell.
3. Each lattice site holds at most one agent. A blocked move randomizes the
   agent's orientation and deposits nothing.
4. A successful move deposits five chemoattractant units.
5. A 3 × 3 mean filter diffuses the trail, followed by adjustable decay.
6. A Fisher–Yates permutation randomizes agent update order each step.

The default calibration uses a 22.5° sensor angle, 45° rotation angle, a 9-cell
sensor offset, and periodic boundaries. Nutrients and light are explicit visual
extensions: `+4300L/(d²+42)` for a nutrient of remaining level `L`, and
`−8500/(d²+65)` plus a marked light-exclusion radius. Nutrients deplete when
reached. The fixed 30 Hz simulation clock is independent of display refresh.

This is a qualitative agent model—not a biochemical, cellular, or fluid
simulation. The animated trail pulse is an activity cue and does not claim to
solve cytoplasmic shuttle-streaming hydrodynamics. Time, distance, and
concentration remain in simulation units.

## Interaction

- Click or tap the culture to place the selected environmental stimulus.
- Shift-click places a light-avoidance region.
- Choose Foraging, Reticulate, or Sparse Transport regimes.
- Adjust the Jones sensor geometry, trail persistence, and population live.
- Pause, reset, or export the current culture as a PNG.

## Development

Requires Node.js 22.13 or newer.

```bash
npm install
npm run dev
npm test
npm run lint
```

The deployment target is the Sites vinext runtime. No persistent storage or
authentication is required.

### Before changing the engine

Read [`docs/HANDOFF.md`](docs/HANDOFF.md). The engine's behaviour is
counter-intuitive in ways that have already cost time — 77–88% of agent moves
are blocked, a food marker at full strength is a gridlock sink with zero
throughput, and the trail half-life is 8 steps. Those numbers, the operating
windows they imply, and the open issues are all there.

```bash
node tools/measure.mjs     # reproduce every measured claim in the handoff
node tools/render.mjs      # render PNGs headlessly (the preview pane can't)
```

The original build is preserved at tag `codex-baseline`; `main` adds a reviewed
set of fixes, each pinned by a test that fails against that tag.

## Living Weights

A second piece built on the same engine: a text generator in which the
organism's state shifts a language model's next-token distribution before it is
sampled. `/weights` in the app, or headless:

```bash
node tools/weights.mjs ab        # same seed, gain 0 vs gain 2, side by side
node tools/weights.mjs channels  # channel fairness and the spread distribution
node tools/weights.mjs sweep     # what the influence dial actually does
```

Read [`docs/LIVING-WEIGHTS.md`](docs/LIVING-WEIGHTS.md) first. Four of its
design decisions are the opposite of the obvious one, each for a measured
reason, and the constants are calibrated against numbers that will not survive
being changed casually.

## Primary references

- Jones, J. (2010). “Characteristics of Pattern Formation and Evolution in
  Approximations of Physarum Transport Networks.” *Artificial Life* 16(2),
  127–153. https://doi.org/10.1162/artl.2010.16.2.16202
- Tero, A. et al. (2010). “Rules for Biologically Inspired Adaptive Network
  Design.” *Science* 327(5964), 439–442.
  https://doi.org/10.1126/science.1177894
- Alim, K. et al. (2017). “Mechanism of signal propagation in *Physarum
  polycephalum*.” *Proceedings of the National Academy of Sciences* 114(20),
  5136–5141. https://doi.org/10.1073/pnas.1618114114
