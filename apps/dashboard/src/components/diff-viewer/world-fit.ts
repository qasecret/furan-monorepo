import type { Application, Container } from "pixi.js";

/**
 * The minimum scale we'll fit to so that "fit" never makes a screenshot
 * unreadably tiny. If the image is so much bigger than the canvas that
 * uniform-fit would produce a sub-readable scale, we clamp here and let
 * the user pan to inspect.
 */
const MIN_FIT_SCALE = 0.05;

/**
 * Compute the uniform scale that fits an image of `imgW × imgH` into a
 * canvas of `screenW × screenH`, preserving aspect ratio (letterbox).
 * Never upscales past 1 — a 200×100 image inside a 1200×800 canvas should
 * render at its native size, not balloon to 8×.
 */
export function computeFitScale(
  imgW: number,
  imgH: number,
  screenW: number,
  screenH: number,
): number {
  if (imgW <= 0 || imgH <= 0 || screenW <= 0 || screenH <= 0) return 1;
  const scale = Math.min(screenW / imgW, screenH / imgH, 1);
  return Math.max(scale, MIN_FIT_SCALE);
}

export interface ViewTransform {
  /** Multiplicative zoom on top of fit. 1 = fit, 2 = 2x fit. */
  zoom: number;
  /** Pan offset in canvas pixels, added on top of the fit-center. */
  panX: number;
  panY: number;
}

const IDENTITY: ViewTransform = { zoom: 1, panX: 0, panY: 0 };

/**
 * Apply scale + center-offset (+ optional zoom and pan) to a "world"
 * container so the image inside fits the application's canvas while
 * preserving aspect ratio. All overlay layers that share `world` as
 * their parent inherit this transform automatically, so we don't have
 * to redo any sprite/graphics math when the canvas resizes, zooms,
 * or pans.
 */
export function fitWorldToCanvas(
  app: Application,
  world: Container,
  imgW: number,
  imgH: number,
  view: ViewTransform = IDENTITY,
): void {
  const fitScale = computeFitScale(
    imgW,
    imgH,
    app.screen.width,
    app.screen.height,
  );
  const scale = fitScale * view.zoom;
  world.scale.set(scale);
  world.position.set(
    (app.screen.width - imgW * scale) / 2 + view.panX,
    (app.screen.height - imgH * scale) / 2 + view.panY,
  );
}
