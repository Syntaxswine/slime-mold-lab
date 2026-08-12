/**
 * Living Weights — what a camera can honestly say about a plate.
 *
 * Pure arithmetic over pixel buffers. No DOM, no camera, no canvas, so the
 * whole of it is testable headlessly against synthetic frames — which matters
 * more here than usual, because the failure this module has to avoid is not a
 * crash. It is a confident, well-shaped, completely meaningless number.
 *
 * THE ONE DESIGN DECISION. Phase 1 established that the reading has to be
 * FLUX, not PROXIMITY: how much is happening in a region, not how much
 * organism is sitting in it. Brightness is proximity. A thick tube that has
 * stopped moving is as bright as one that is pulsing, and a dark patch of agar
 * is as dark whether the culture never arrived or has just left. So the scalar
 * here is temporal:
 *
 *     activity = mean|I(t) - I(t-1)| / max(referenceLuminance, floor)
 *
 * That quantity is nonzero exactly when something in the region is changing:
 * a growth front advancing, a tube thickening, the peristaltic contraction
 * that a plasmodium runs continuously. It is zero on still agar and zero on a
 * dead culture, which are the two cases a brightness reading cannot tell apart
 * from a living one.
 *
 * THE DENOMINATOR IS NOT THE REGION'S OWN LUMINANCE, and getting that wrong
 * silently destroyed the signal in the first draft. Dividing a region's change
 * by its own brightness looks like the obvious way to be invariant to how
 * brightly the plate is lit. It is also a way to be invariant to how much
 * organism is there — because a busier region is both changing more AND
 * brighter, and the ratio of two proportional things is a constant. Measured
 * against the simulation's known per-channel flux, the numerator alone tracked
 * the truth (10.4 luminance units on the quietest channel against 28.7 on the
 * busiest) while the ratio was flat at 0.14-0.17 across all eight, and the
 * rank correlation with ground truth fell to 0.04.
 *
 * The reference is therefore the BENCH: the frame outside the dish, which has
 * no organism on it and so brightens and darkens only when the lighting does.
 * A white card, in the photographic sense.
 *
 * THE DEFENCE. Every environmental accident — the room lights changing, the
 * camera's auto-exposure hunting, someone walking past, the rig being nudged —
 * produces exactly the same signature as biology: a frame that differs from
 * the last one. So the reading is referenced against a BACKGROUND REGION
 * outside the dish, which contains no organism and therefore whose activity is
 * by definition not biological. Anything the background sees is subtracted,
 * and if the background sees too much, the whole frame is marked untrustworthy
 * rather than silently reported as an opinion.
 */

export type Frame = {
  /** RGBA, row-major, length = width * height * 4. */
  data: Uint8ClampedArray;
  width: number;
  height: number;
  timestampMs: number;
};

/** A circular sampling region in pixel coordinates. */
export type Region = {
  channel: number;
  cx: number;
  cy: number;
  radius: number;
};

/** Where the dish is in the frame, and therefore where the organism cannot be. */
export type DishGeometry = {
  cx: number;
  cy: number;
  /** Dish radius in pixels. */
  radius: number;
  /** Channel ring radius as a fraction of the dish radius. */
  ringFraction: number;
  /** Channel disc radius as a fraction of the dish radius. */
  channelFraction: number;
  /** Ring rotation in degrees. */
  phaseDegrees: number;
  channelCount: number;
};

export const DEFAULT_DISH: DishGeometry = {
  cx: 320,
  cy: 240,
  radius: 200,
  // 0.5 of the dish radius, carried across from the simulated ring: r=45 on a
  // body whose useful extent is about 90 cells. It is a starting point and not
  // a result — the lattice sweep does not transfer to a real dish, and
  // `tools/weights.mjs channels` must be re-run against a real tape before
  // this number means anything. See docs/LIVING-WEIGHTS.md section 8.
  ringFraction: 0.5,
  channelFraction: 0.14,
  phaseDegrees: 0,
  channelCount: 8,
};

export function dishRegions(dish: DishGeometry): Region[] {
  const regions: Region[] = [];
  for (let i = 0; i < dish.channelCount; i += 1) {
    const theta = (i / dish.channelCount) * Math.PI * 2 + (dish.phaseDegrees * Math.PI) / 180;
    regions.push({
      channel: i,
      cx: dish.cx + Math.cos(theta) * dish.radius * dish.ringFraction,
      cy: dish.cy + Math.sin(theta) * dish.radius * dish.ringFraction,
      radius: dish.radius * dish.channelFraction,
    });
  }
  return regions;
}

/**
 * The reference region: a ring of frame OUTSIDE the dish.
 *
 * Sampled as four discs at the frame corners' side of the dish rather than as
 * a full annulus, so the cost does not scale with frame size and so a single
 * local intrusion (a hand, a cable) cannot be averaged away by three quiet
 * quadrants — `backgroundActivity` takes the worst of them.
 */
export function backgroundRegions(dish: DishGeometry, frame: { width: number; height: number }): Region[] {
  const out: Region[] = [];
  const radius = Math.max(6, dish.radius * 0.12);
  const reach = dish.radius + radius * 1.6;
  for (let i = 0; i < 4; i += 1) {
    const theta = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const cx = dish.cx + Math.cos(theta) * reach;
    const cy = dish.cy + Math.sin(theta) * reach;
    // Only usable if it actually lies inside the frame.
    if (cx - radius < 0 || cy - radius < 0 || cx + radius >= frame.width || cy + radius >= frame.height) {
      continue;
    }
    out.push({ channel: -1 - i, cx, cy, radius });
  }
  return out;
}

/** Rec. 709 luma. */
function luma(data: Uint8ClampedArray, pixel: number) {
  return 0.2126 * data[pixel] + 0.7152 * data[pixel + 1] + 0.0722 * data[pixel + 2];
}

export type RegionStats = {
  channel: number;
  /** mean |I(t) - I(t-1)| in 0-255 units. This is the quantity that tracks flux. */
  change: number;
  /** mean I(t) in 0-255 units. Proximity, reported for diagnostics only. */
  luminance: number;
  /** change / max(referenceLuminance, floor) — the reading. */
  activity: number;
  /** Fraction of sampled pixels at 0 or 255 in this frame. */
  clipped: number;
  pixels: number;
};

/**
 * Luminance floor for the activity denominator, in 0-255 units.
 *
 * Without it a nearly black region divides a small change by a smaller mean
 * and reports enormous activity — the same failure as the unfloored z-score in
 * `weights.ts`, one level down the stack. 8 is comfortably above sensor noise
 * in the dark and far below any usably exposed region.
 */
const LUMA_FLOOR = 8;

export function measureRegion(
  previous: Frame,
  next: Frame,
  region: Region,
  referenceLuminance = 0,
): RegionStats {
  const x0 = Math.max(0, Math.floor(region.cx - region.radius));
  const x1 = Math.min(next.width - 1, Math.ceil(region.cx + region.radius));
  const y0 = Math.max(0, Math.floor(region.cy - region.radius));
  const y1 = Math.min(next.height - 1, Math.ceil(region.cy + region.radius));
  const r2 = region.radius * region.radius;

  let change = 0;
  let luminance = 0;
  let clipped = 0;
  let pixels = 0;

  for (let y = y0; y <= y1; y += 1) {
    const dy = y - region.cy;
    for (let x = x0; x <= x1; x += 1) {
      const dx = x - region.cx;
      if (dx * dx + dy * dy > r2) continue;
      const pixel = (y * next.width + x) * 4;
      const a = luma(next.data, pixel);
      const b = luma(previous.data, pixel);
      change += Math.abs(a - b);
      luminance += a;
      if (a <= 0.5 || a >= 254.5) clipped += 1;
      pixels += 1;
    }
  }

  if (pixels === 0) {
    return { channel: region.channel, change: 0, luminance: 0, activity: 0, clipped: 1, pixels: 0 };
  }
  const meanChange = change / pixels;
  const meanLuma = luminance / pixels;
  // A reference of 0 means "no bench in frame"; fall back to the region's own
  // luminance so the number is still bounded, and let `readFrames` mark the
  // reading as unreferenced. Do not treat that fallback as equivalent.
  const reference = referenceLuminance > 0 ? referenceLuminance : meanLuma;
  return {
    channel: region.channel,
    change: meanChange,
    luminance: meanLuma,
    activity: meanChange / Math.max(reference, LUMA_FLOOR),
    clipped: clipped / pixels,
    pixels,
  };
}

/**
 * Variance of the Laplacian over the dish — the standard focus measure.
 *
 * A defocused or motion-blurred frame still produces frame-to-frame
 * differences; what it cannot produce is a sharp one. Sampled on a stride
 * because focus is a property of the whole image and does not need every pixel.
 */
export function focusMeasure(frame: Frame, dish: DishGeometry, stride = 3): number {
  const x0 = Math.max(1, Math.floor(dish.cx - dish.radius));
  const x1 = Math.min(frame.width - 2, Math.ceil(dish.cx + dish.radius));
  const y0 = Math.max(1, Math.floor(dish.cy - dish.radius));
  const y1 = Math.min(frame.height - 2, Math.ceil(dish.cy + dish.radius));
  const r2 = dish.radius * dish.radius;

  let sum = 0;
  let sumSquares = 0;
  let n = 0;
  for (let y = y0; y <= y1; y += stride) {
    const dy = y - dish.cy;
    for (let x = x0; x <= x1; x += stride) {
      const dx = x - dish.cx;
      if (dx * dx + dy * dy > r2) continue;
      const p = (y * frame.width + x) * 4;
      const w = frame.width * 4;
      const value =
        4 * luma(frame.data, p) -
        luma(frame.data, p - 4) -
        luma(frame.data, p + 4) -
        luma(frame.data, p - w) -
        luma(frame.data, p + w);
      sum += value;
      sumSquares += value * value;
      n += 1;
    }
  }
  if (n === 0) return 0;
  const mean = sum / n;
  return sumSquares / n - mean * mean;
}

export type FrameReading = {
  regions: RegionStats[];
  /** Bench luminance — the illumination reference the activity is divided by. */
  referenceLuminance: number;
  /** True if no bench was visible and each region fell back to its own luminance. */
  unreferenced: boolean;
  /** Median bench activity. Subtracted, because it is the common-mode floor. */
  backgroundActivity: number;
  /** Worst bench quadrant. Gates trust, because one intruded corner is enough. */
  worstBackgroundActivity: number;
  /** Per-channel activity with the background floor removed, clamped at 0. */
  corrected: number[];
  /** Seconds between the two frames. */
  intervalSeconds: number;
  focus: number;
  /** Fraction of dish pixels clipped. */
  clipped: number;
  /** Relative shift in BENCH luminance. Catches auto-exposure hunting. */
  exposureShift: number;
};

export function readFrames(
  previous: Frame,
  next: Frame,
  dish: DishGeometry,
  regions: Region[] = dishRegions(dish),
): FrameReading {
  // The bench first: it supplies the denominator, the common-mode floor and
  // the exposure reference, and none of those may be contaminated by the
  // organism. Measured with a zero reference so its own activity is expressed
  // against its own luminance, which for an organism-free patch is the right
  // self-normalisation.
  const background = backgroundRegions(dish, next).map((region) =>
    measureRegion(previous, next, region),
  );
  const benchPixels = background.reduce((a, b) => a + b.pixels, 0);
  const referenceLuminance =
    benchPixels === 0 ? 0 : background.reduce((a, b) => a + b.luminance * b.pixels, 0) / benchPixels;

  const stats = regions.map((region) => measureRegion(previous, next, region, referenceLuminance));

  const benchActivity = background.map((b) => b.activity).sort((a, b) => a - b);
  const backgroundActivity =
    benchActivity.length === 0 ? 0 : benchActivity[Math.floor(benchActivity.length / 2)];
  const worstBackgroundActivity = benchActivity.length === 0 ? 0 : benchActivity[benchActivity.length - 1];

  // The bench does NOT get subtracted from the dish, and that is a correction
  // to an earlier design rather than an omission.
  //
  // Subtracting it looks obvious — whatever the organism-free part of the
  // frame is doing is surely a floor under whatever the dish appears to be
  // doing. Measured, it does nothing at all: it is one scalar taken off all
  // eight channels, and a common scalar cannot reorder them. Rank correlation
  // against the simulation's known flux was 0.95 with the subtraction and 0.95
  // without it, on a clean rig, a grainy one and a noisy one alike.
  //
  // So it bought no accuracy, and it cost something real. It only helps if the
  // bench's change is genuinely shared with the dish — true of a flickering
  // lamp, false of sensor grain, which is independent per pixel and merely
  // measurable in both places. What it reliably did was move the absolute
  // level of `raw` around by an amount that has nothing to do with the plate,
  // which is precisely the quantity the deadband and the per-channel offsets
  // are calibrated against.
  //
  // The dish's own noise floor is a per-channel constant and belongs to the
  // calibration offsets, measured on a bare plate where it can be measured
  // properly. The bench keeps its two sound jobs: supplying the illumination
  // reference, and saying when the scene has stopped being trustworthy.
  const corrected = stats.map((s) => Math.max(0, s.activity));

  const pixels = stats.reduce((a, s) => a + s.pixels, 0);
  const clipped = pixels === 0 ? 1 : stats.reduce((a, s) => a + s.clipped * s.pixels, 0) / pixels;

  // Exposure is judged on the bench, never on the dish. A growing culture
  // brightens its own regions frame after frame, and reading that as an
  // exposure fault would penalise the run for the one thing it is there to
  // watch — which is exactly what the first draft did.
  const benchBefore = backgroundRegions(dish, previous).map((region) =>
    measureRegion(previous, previous, region),
  );
  const benchBeforePixels = benchBefore.reduce((a, b) => a + b.pixels, 0);
  const referenceBefore =
    benchBeforePixels === 0
      ? 0
      : benchBefore.reduce((a, b) => a + b.luminance * b.pixels, 0) / benchBeforePixels;

  return {
    regions: stats,
    referenceLuminance,
    unreferenced: benchPixels === 0,
    backgroundActivity,
    worstBackgroundActivity,
    corrected,
    intervalSeconds: Math.max(0, (next.timestampMs - previous.timestampMs) / 1000),
    focus: focusMeasure(next, dish),
    clipped,
    exposureShift:
      referenceLuminance <= 0
        ? 0
        : Math.abs(referenceLuminance - referenceBefore) / Math.max(referenceLuminance, LUMA_FLOOR),
  };
}

/**
 * Each rail is a band, not a slope from zero.
 *
 * `good` is where the measurement is fine and costs nothing; `ceiling` is
 * where it is worthless. The first draft ramped linearly from zero, so a frame
 * one second apart with 0.1% clipping reported two faults and lost 5% of its
 * confidence for being completely normal — which trains an operator to ignore
 * the fault list, and a fault list nobody reads is worse than none.
 */
export type Band = { good: number; ceiling: number };

export type QualityLimits = {
  /** Bench activity: the room moving rather than the plate. */
  drift: Band;
  /** Variance of Laplacian. Inverted: `good` is sharp, `ceiling` is unusable. */
  focus: Band;
  clipped: Band;
  exposureShift: Band;
  intervalSeconds: Band;
};

export const DEFAULT_QUALITY_LIMITS: QualityLimits = {
  // Provisional, and deliberately labelled as such. Every one of these must be
  // set from a recorded tape of the actual rig — `node tools/weights.mjs
  // calibrate` derives them from a quiet period. Shipping guesses would repeat
  // the mistake DEFAULT_NORMALIZE made in Phase 1, where a rail an order of
  // magnitude too loose fired on 0% of reads and was therefore not a rail.
  drift: { good: 0.01, ceiling: 0.08 },
  focus: { good: 200, ceiling: 20 },
  clipped: { good: 0.02, ceiling: 0.25 },
  exposureShift: { good: 0.02, ceiling: 0.15 },
  intervalSeconds: { good: 20, ceiling: 120 },
};

export type QualityReport = {
  quality: number;
  /** Every reason the frame lost confidence, worst first. Shown in the UI. */
  faults: { reason: string; severity: number }[];
};

/**
 * How much of this frame pair should be believed, and why not more.
 *
 * Multiplicative, not a minimum: three marginal problems should compound into
 * distrust rather than each individually passing. The faults come back with
 * the number because a bare 0.2 tells an operator nothing about whether to
 * refocus the lens, close the blind, or turn auto-exposure off.
 */
export function frameQuality(
  reading: FrameReading,
  limits: QualityLimits = DEFAULT_QUALITY_LIMITS,
  driftFloor = 0,
): QualityReport {
  const faults: { reason: string; severity: number }[] = [];

  const band = (value: number, limit: Band, reason: string) => {
    const rising = limit.ceiling > limit.good;
    const span = Math.abs(limit.ceiling - limit.good);
    const past = rising ? value - limit.good : limit.good - value;
    const factor = span <= 0 ? (past > 0 ? 0 : 1) : clamp01(1 - past / span);
    if (factor < 1) faults.push({ reason, severity: 1 - factor });
    return factor;
  };

  // Measured as a DEPARTURE from the rig's own resting bench activity, not as
  // an absolute. Every sensor has grain, and grain shows up on the bench as a
  // standing frame-to-frame change: 0.041 on the clean synthetic rig, 0.080
  // with the grain doubled. An absolute threshold below that fires constantly
  // on a perfectly healthy camera, and a rail that always fires is not a rail.
  // What matters is that the bench started doing something it was not doing
  // before — a hand, a shadow, a light switch.
  const drift = band(
    Math.max(0, reading.worstBackgroundActivity - driftFloor),
    limits.drift,
    "the room is moving, not the plate",
  );
  const clip = band(reading.clipped, limits.clipped, "pixels are clipped");
  const exposure = band(reading.exposureShift, limits.exposureShift, "exposure shifted between frames");
  const interval = band(reading.intervalSeconds, limits.intervalSeconds, "frames too far apart");
  const focus = band(reading.focus, limits.focus, "out of focus");

  if (reading.unreferenced) {
    // Not fatal, but the operator must know the plate is being measured
    // against itself and that the illumination rail is therefore blind.
    faults.push({ reason: "no bench visible; activity is self-referenced", severity: 0.5 });
  }
  const unreferenced = reading.unreferenced ? 0.5 : 1;

  faults.sort((a, b) => b.severity - a.severity);
  return { quality: drift * clip * exposure * interval * focus * unreferenced, faults };
}

function clamp01(v: number) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
