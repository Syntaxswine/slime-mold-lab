/**
 * Living Weights — frames from a real camera, or from a recording of one.
 *
 * The only part of the sensor layer that touches the DOM. Everything that
 * decides anything lives in `vision.ts` and `camera.ts`, which is why those
 * can be tested headlessly against synthetic frames and this cannot.
 *
 * NOT EXERCISED BY THE TEST SUITE. There is no camera on a build machine.
 * What is tested is everything downstream of `grab()`. Treat the first live
 * session as the real integration test, and read the checklist below before
 * believing anything the piece writes from it — every item on it is a way to
 * get a confident, well-shaped, meaningless signal.
 *
 * BEFORE A RUN THAT MATTERS:
 *
 * 1. Turn OFF auto-exposure, auto-white-balance, auto-focus and any "low light
 *    compensation". All four are closed loops that respond to the organism,
 *    which makes the camera part of the experiment. Most UVC webcams expose
 *    these through `applyConstraints`; many quietly ignore it, so check
 *    `getSettings()` afterwards rather than assuming, and prefer a camera with
 *    manual control in its own driver.
 * 2. Frame the BENCH. `vision.ts` uses the frame outside the dish as its
 *    illumination reference and as its reason to distrust a frame; a dish that
 *    fills the frame leaves it blind, and it will say so.
 * 3. Light from BELOW, through a diffuser, if you can. The contraction
 *    modulates transmitted intensity directly, so transillumination puts the
 *    signal in the pixel values; reflected light mostly throws it away.
 * 4. Use a fixed lamp, not a window. The session rail catches slow drift, but
 *    catching it means refusing your run.
 * 5. Sample fast enough to resolve the rhythm. 6 s is what three independent
 *    labs use and gives ~20 samples per contraction; 30 s is the Nyquist edge
 *    and WILL alias a 60 s cycle into nonsense.
 * 6. Never let the browser hand you a compressed stream if you can avoid it.
 *    Inter-frame compression on a nearly-static scene invents and destroys
 *    small changes, and small changes are the entire signal.
 */
import type { Frame } from "../vision.ts";
import type { FrameSource } from "./camera.ts";

export type VideoSourceConfig = {
  /** Width to sample at. Smaller is faster and the signal is regional anyway. */
  width: number;
  height: number;
  /** Minimum milliseconds between frames actually handed on. */
  intervalMs: number;
  label: string;
};

export const DEFAULT_VIDEO_SOURCE: VideoSourceConfig = {
  width: 640,
  height: 480,
  // 6 s. Alim et al. 2013 and Schick et al. 2024 both sample at 6 s for hours;
  // Alim et al. 2017 uses 3 s. At a 131 s contraction that is ~22 samples per
  // cycle, comfortably clear of aliasing, and 640x480 mono is about 4.4 GB a
  // day if you also keep the frames.
  intervalMs: 6000,
  label: "video",
};

/**
 * Sample an already-playing <video> element into frames.
 *
 * Works for a webcam stream and for a recorded time-lapse alike, which matters
 * more than it sounds: a video file is the only way to develop against a real
 * culture without sitting next to one, and it makes a session reproducible in
 * a way a live camera never is.
 */
export function makeVideoFrameSource(
  video: HTMLVideoElement,
  overrides: Partial<VideoSourceConfig> = {},
): FrameSource & { lastGrabMs: number } {
  const config: VideoSourceConfig = { ...DEFAULT_VIDEO_SOURCE, ...overrides };
  const canvas = document.createElement("canvas");
  canvas.width = config.width;
  canvas.height = config.height;
  // `willReadFrequently` matters here: without it every getImageData round-trips
  // through the GPU and a 6-second cadence turns into a stutter.
  const context = canvas.getContext("2d", { willReadFrequently: true });

  const source = {
    id: `video:${config.label}`,
    config: config as unknown as Record<string, unknown>,
    lastGrabMs: 0,

    grab(): Frame | null {
      if (!context) return null;
      if (video.readyState < 2 || video.videoWidth === 0) return null;

      const now = performance.now();
      // Rate-limited here rather than by the caller, so that a provider asked
      // to advance ten frames on a live camera gets however many actually
      // arrived and reports the short integration honestly through `quality`.
      if (source.lastGrabMs !== 0 && now - source.lastGrabMs < config.intervalMs) return null;
      source.lastGrabMs = now;

      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const image = context.getImageData(0, 0, canvas.width, canvas.height);
      return {
        data: image.data,
        width: canvas.width,
        height: canvas.height,
        timestampMs: now,
      };
    },
  };

  return source;
}

/**
 * Ask for a camera with every automatic control turned off.
 *
 * The constraints below are advisory: `getUserMedia` will happily return a
 * stream that honours none of them. That is why this returns the settings the
 * browser actually applied — check them, and say so in the interface, rather
 * than assuming the request was granted. An auto-exposure loop left running is
 * the single most effective way to make this piece generate confident
 * nonsense, because it responds to the organism.
 */
export async function openCamera(deviceId?: string): Promise<{
  stream: MediaStream;
  settings: MediaTrackSettings;
  warnings: string[];
}> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 5 },
      // Non-standard but widely honoured; the cast keeps TypeScript out of it.
      ...({
        exposureMode: "manual",
        whiteBalanceMode: "manual",
        focusMode: "manual",
      } as MediaTrackConstraints),
    },
  });

  const track = stream.getVideoTracks()[0];
  const settings = track?.getSettings() ?? {};
  const warnings: string[] = [];
  const applied = settings as MediaTrackSettings & {
    exposureMode?: string;
    whiteBalanceMode?: string;
    focusMode?: string;
  };
  if (applied.exposureMode && applied.exposureMode !== "manual") {
    warnings.push("auto-exposure is still running; it will respond to the organism");
  }
  if (applied.whiteBalanceMode && applied.whiteBalanceMode !== "manual") {
    warnings.push("auto white balance is still running");
  }
  if (applied.focusMode && applied.focusMode !== "manual") {
    warnings.push("autofocus is still running; it will hunt on a low-contrast plate");
  }
  if (!applied.exposureMode && !applied.whiteBalanceMode && !applied.focusMode) {
    warnings.push("this camera does not report its automatic controls; verify them in its driver");
  }

  return { stream, settings, warnings };
}
