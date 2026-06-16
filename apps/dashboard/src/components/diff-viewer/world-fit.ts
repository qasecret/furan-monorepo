import type { Application, Container } from "pixi.js";

import { ZOOM_MAX, ZOOM_MIN } from "./useViewerStore";

/**
 * The minimum scale we'll fit to so that "fit" never makes a screenshot
 * unreadably tiny. If the image is so much bigger than the canvas that
 * uniform-fit would produce a sub-readable scale, we clamp here and let
 * the user pan to inspect.
 */
const MIN_FIT_SCALE = 0.05;

/**
 * Maximum upscale factor — images smaller than the canvas are scaled up
 * to fill it, but capped here to avoid blurry pixel-art blowups.
 */
const MAX_UPSCALE = 2;

/**
 * Compute the uniform scale that fits an image of `imgW × imgH` into a
 * canvas of `screenW × screenH`, preserving aspect ratio (letterbox).
 * Small images are scaled up to fill the viewport (capped at MAX_UPSCALE)
 * so users don't have to squint at tiny screenshots.
 */
export function computeFitScale(
  imgW: number,
  imgH: number,
  screenW: number,
  screenH: number,
): number {
  if (imgW <= 0 || imgH <= 0 || screenW <= 0 || screenH <= 0) return 1;
  const scale = Math.min(screenW / imgW, screenH / imgH, MAX_UPSCALE);
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

/**
 * Compute a {zoom, panX, panY} that frames `bbox` centered in the canvas at
 * a comfortable size (bbox fills ~`targetFill` of the smaller canvas
 * dimension), clamped to the viewer's zoom range. Pure — the canvas applies
 * it via the same fit math as everything else.
 */
export function computeFocusView(
  bbox: { x: number; y: number; width: number; height: number },
  imgW: number,
  imgH: number,
  screenW: number,
  screenH: number,
  targetFill = 0.6,
): ViewTransform {
  const fitScale = computeFitScale(imgW, imgH, screenW, screenH);
  const w = Math.max(bbox.width, 1);
  const h = Math.max(bbox.height, 1);
  const desiredScale = Math.min(
    (screenW * targetFill) / w,
    (screenH * targetFill) / h,
  );
  const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, desiredScale / fitScale));
  const scale = fitScale * zoom;
  const cx = bbox.x + bbox.width / 2;
  const cy = bbox.y + bbox.height / 2;
  const panX = scale * (imgW / 2 - cx);
  const panY = scale * (imgH / 2 - cy);
  return { zoom, panX, panY };
}
