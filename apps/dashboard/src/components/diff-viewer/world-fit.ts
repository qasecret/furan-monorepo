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

/**
 * Apply scale + center-offset to a "world" container so the image inside
 * fits the application's canvas while preserving aspect ratio. All
 * overlay layers that share `world` as their parent inherit this transform
 * automatically, so we don't have to redo any sprite/graphics math when
 * the canvas resizes.
 */
export function fitWorldToCanvas(
  app: Application,
  world: Container,
  imgW: number,
  imgH: number,
): void {
  const scale = computeFitScale(
    imgW,
    imgH,
    app.screen.width,
    app.screen.height,
  );
  world.scale.set(scale);
  world.position.set(
    (app.screen.width - imgW * scale) / 2,
    (app.screen.height - imgH * scale) / 2,
  );
}
