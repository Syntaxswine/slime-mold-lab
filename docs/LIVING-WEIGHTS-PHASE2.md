# Living Weights — Phase 2: the sensor layer

**Written 2026-08-12.** Read [`LIVING-WEIGHTS.md`](LIVING-WEIGHTS.md) first;
this assumes it.

Phase 2 replaces the simulated organism with a real one, seen through a lens.
The provider contract does not change — `advance` / `readSignals` / `reset` —
so the generation engine is untouched. That was Phase 1's last acceptance
criterion and this document is the test of it.

Reading pixels is the easy part. The hard part is that **every environmental
accident produces exactly the signature biology does**: a frame that differs
from the last one. Most of what follows is apparatus for refusing a reading.

---

## 1. What the reading is, and why

`activity = mean|I(t) − I(t−1)| / max(benchLuminance, floor)` was the first
answer and it is now the fallback. The default is:

> **RMS amplitude of the region's log-transmittance inside the plasmodium's
> contraction band, 5–16.7 mHz.**

That is not a flourish. A plasmodium runs a peristaltic contraction that
modulates tube cross-section with a period of **131 ± 43 s** — Alim, Amselem,
Peaudecerf, Brenner & Pringle (2013), *PNAS* 110(33):13306–13311,
[doi:10.1073/pnas.1305049110](https://doi.org/10.1073/pnas.1305049110), who
argue that spread is evidence the period is *constant* across tube segments
rather than variable. Independent labs land nearby: ~120 s (Schick, Kramar &
Alim 2024, arXiv:2408.17134), ~100 s (Saiseau, Busson & Durand, *J. R. Soc.
Interface* 23:20250971), and 1–2 minutes rising logarithmically with body size
from 100 µm to 10 cm (Kuroda, Takagi, Nakagaki & Ueda 2015, *J. Exp. Biol.*
218(23):3729–3738).

Crucially, that contraction **modulates transmitted light intensity directly**,
so under transillumination it is present in the raw pixel values;
−ln(I/I₀) is proportional to optical thickness, which is the relation Kuroda et
al. calibrate against glass tubes of known diameter.

Restricting to the band is therefore a matched filter for an organism that is
**alive and pumping**, rather than merely *present* or merely *changing*.
Measured on the synthetic rig — same culture, rhythm switched on and off:

| estimator | pulsing | same culture, no rhythm | ratio |
|---|---|---|---|
| **band-power** | 1.30e-2 | 1.18e-3 | **11.0×** |
| broadband | 7.29e-1 | 6.53e-1 | 1.1× |

Reproduce with `node tools/weights.mjs pulse`.

And on a pure signal, with grain of the same order as the rhythm, band-power
separates rhythm-plus-noise from noise by 4.2× while broadband manages **1.02×**
— measured at grain 1, 2, 4 and 8, broadband scores 1.07, 1.02, 1.01, 1.00. It
never sees it. Frame-to-frame change is dominated by whatever moves fastest,
and that is the noise.

**The honest nuance.** Broadband scores *slightly better* against the
simulation's ground-truth flux (0.87 vs 0.73), and it should: flux is agent
movement and broadband change is a direct image of it. But a real plate offers
no ground-truth flux, and a sclerotium, a dead tube, a shadow and a JPEG
artefact all produce change. Only the band asks whether it is still alive.

**What it costs.** Band power needs whole cycles. At a 1024 s window the
frequency resolution is 0.98 mHz, the band holds ~12 bins, and the first
reading cannot come before the window fills. That is the number that decides
whether a sentence takes minutes or an hour, and it is exposed as
`windowSeconds`. The provider refuses to speak below two cycles.

## 2. How it is known to work at all

There is no ground truth for a real dish, so `providers/synthetic-frames.ts`
renders the Phase 1 simulation to a frame buffer and the whole vision pipeline
reads it back. The simulation knows its own per-channel flux exactly, so the
rank correlation between what went in and what came out is a direct test of the
arithmetic. `node tools/weights.mjs recover`.

That harness earned its place immediately. Seven defects, every one of which
passed every other check in the repo:

| # | defect | how it surfaced |
|---|---|---|
| 1 | activity divided by the region's **own** luminance | Spearman **0.04** against known flux. A busier region is both changing more AND brighter, so the ratio is a constant: change tracked truth 10.4→28.7 across channels while the ratio sat flat at 0.14–0.17. The denominator is now the bench. |
| 2 | every quality rail ramped linearly from zero | A pair one second apart with 0.1% clipping reported two faults for being completely normal. Rails are bands now: free below `good`, worthless at `ceiling`. |
| 3 | exposure judged on the dish | A growing culture brightens its own regions, so the run was penalised for the one thing it is watching. |
| 4 | the drift rail fired on sensor grain | Grain is a standing bench activity of 0.041 here, 0.080 with it doubled. An absolute threshold below that refuses every real camera. The rail now measures **departure** from the rig's own resting bench activity, learned during warmup. |
| 5 | the bench was subtracted from the dish | Looks obviously right, does nothing: one scalar off all eight channels cannot reorder them. 0.95 with, 0.95 without. What it did do was move the absolute level of `raw`, which is what the deadband and offsets are calibrated against. |
| 6 | the calibration refusal was **inverted** | It rejected the bare plate and accepted the living culture. The metric was a coefficient of variation, and a quiet rig has a near-zero mean, so its relative variation is enormous. |
| 7 | tape statistics included non-measurements | A camera discards its first frames while exposure settles, so the opening reads are all-zero at quality zero. Two leading zeros in a 25-read tape are a correlated residual on every channel at once, and they drove pattern inertia on a **bare plate** from −0.06 to 0.82 — indistinguishable from a live culture, silently disarming the refusal that depends on it. |

## 3. What would make each signal a lie

| failure | what it looks like | what catches it |
|---|---|---|
| auto-exposure hunting | every region changes together, confidently | bench-referenced `exposureShift` |
| the room getting dark over an afternoon | invisible frame to frame — 0.4%/frame is below 8-bit quantisation — but recovery falls 0.94 → 0.73 | **session** rail against the warmup datum |
| someone walks past | one bench quadrant moves | worst-quadrant drift against the learned floor |
| lens slips, plate condenses | change persists, sharpness does not | focus (variance of Laplacian) |
| dish fills the frame | no organism-free reference exists at all | `unreferenced`, and it says so |
| sampling too slowly | a 60 s cycle aliases into nonsense | interval rail; and `frameIntervalSeconds` is measured, never assumed |
| **the organism dies** | broadband change continues from noise and drift | **only the band** — this is the one a broadband reading cannot see |

Quality is multiplicative, not a minimum, so three marginal problems compound
into distrust. Each fault comes back with a human reason, because a bare 0.2
tells an operator nothing about whether to refocus the lens, close the blind,
or turn auto-exposure off.

**Quality answers "can the camera be believed", not "is the organism alive".**
The second question is answered downstream: a dead culture reads ~10× lower in
the band, and the normaliser's `deadband` silences it — *if* the deadband has
been calibrated against this rig.

## 4. Determinism, restated

A live culture will not do the same thing twice, so "reproducible from the
seed" cannot survive Phase 2. `lib/tape.ts` records every reading a provider
hands over; replaying a tape reproduces the run token for token, and
`tests/` pins that. What is reproducible is no longer *the organism* but
**this hour of this organism** — the honest claim, and the one an archive
needs anyway.

It is also what makes the brief's fourth Phase 2 deliverable possible at all.
A model-only versus mould-influenced comparison against a *live* sensor would
have the two arms watching different minutes of the culture's life. Against a
tape they watch the same minutes and the only difference is the gain:

```bash
node tools/weights.mjs tape --provider camera --reads 80 --out runs/session.tape.jsonl
node tools/weights.mjs ab --tape runs/session.tape.jsonl --gain 2
```

## 5. Calibration

Nothing from the lattice transfers. There `raw` was landings per tick, in the
tens; here it is a dimensionless relative change three orders of magnitude
smaller. `node tools/weights.mjs calibrate --quiet <tape> [--active <tape>]`
re-derives the per-channel offsets, the display scale, the normaliser's
deadband and full-confidence spread, and the focus band.

**It refuses a tape that is not quiet.** Offsets measured while the organism is
working subtract the organism, and the piece then runs beautifully and means
nothing. The discriminator is lag-1 correlation of the channel pattern after
each channel's time mean is removed: white sensor noise scores near zero, a
body with spatial inertia scores high. Measured: bare plate **−0.06**, live
culture **0.90**. It is invariant to a per-channel offset and to sensor gain,
which is what a rig full of unequal lighting will hand you.

Focus is the one rail with no universal constant — variance of Laplacian is in
squared luminance units and depends on lens, sensor, magnification and how
textured the subject is. `calibrate` derives it from a tape and prints
**NOT DERIVED** rather than inventing one.

Record the quiet tape on a **bare plate**, before inoculation.

## 6. What is built, and what is not

**Built and verified headlessly** (22 tests): the vision arithmetic, the
band-power estimator, the quality rails, the camera provider, the synthetic
ground-truth rig, the tape record/replay, the calibration derivation and its
refusal, and five CLI instruments.

**Built, not verifiable here**: `providers/camera-source.ts` — webcam and
video-element frame sources. There is no camera on a build machine. Everything
downstream of `grab()` is tested; the file carries a pre-run checklist, and
`openCamera` returns the settings the browser *actually* applied rather than
the ones it was asked for, because most webcams silently ignore
`exposureMode: "manual"` and an auto-exposure loop responds to the organism.

**Not built:**

- **The calibration screen.** The brief asks for one; only the CLI exists. It
  needs dish alignment against a live frame, the bare-plate capture, the live
  capture, and the derived constants shown before they are accepted.
- **The camera as a selectable source in `/weights`.** Currently the interface
  offers the simulated culture and the drift bank.
- **The electrode provider.** The research came back with the numbers for it,
  but nothing is built, and the standard published protocol has a baiting
  problem that Phase 1 already showed destroys the signal. Worth its own pass.
- **Anything pointed at a real culture.** No plate has been imaged. Every
  number in this document comes from a simulation rendered to pixels.

## 7. The rig, when there is one

From the research, for whoever sets it up:

- **6 s frames**, mono, uncompressed. Alim et al. 2013 and Schick et al. 2024
  both sample at 6 s for hours; Alim et al. 2017 at 3 s. Nothing is gained
  below ~3 s unless you are tracking particles. 640×480 mono8 is ~4.4 GB/day
  if you keep the frames.
- **Transillumination** through a diffuser, DC-driven. The contraction is in
  the transmitted intensity; reflected light throws most of it away.
- **Frame the bench.** The reference and the trust gate both live outside the
  dish.
- Growth is a **separate, slower channel**: front advance is 0.6–3.6 mm/h
  (Schick et al. 2024), which at 0.1 mm/px is invisible at 6 s and correctly
  so. Aggregate to 60 s bins if you want morphology; it is context, not the
  channel value.
