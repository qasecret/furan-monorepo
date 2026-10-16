import {
  canvasToWorld,
  type Point,
  type Size,
  type Transform,
} from "./viewer-geometry";

/**
 * The image pixel under a pointer, or null when the pointer is off the image.
 *
 *   client(x, y) → canvas CSS px (minus the canvas's rect) → world
 *   (`canvasToWorld`), and the world is in image pixels: every image sits at
 *   its top-left corner at 1:1.
 *
 * CSS px, never device px. Pixi runs with `autoDensity: true` and
 * `resolution: devicePixelRatio`, so the canvas's backing store is
 * `CSS width × dpr` while its rect stays at the CSS width, and the world
 * transform is in CSS px. Rescaling the pointer by `canvas.width / rect.width`
 * would put every point twice as far from the origin on a retina screen.
 *
 * `image` bounds the answer: a point in the world area the image does not
 * cover (a taller baseline's) is off it. The result is rounded to whole
 * pixels, as the editor stores regions.
 */
export function pointerToImage(
  pointer: { clientX: number; clientY: number },
  rect: { left: number; top: number; width: number; height: number },
  transform: Transform,
  image: Size,
): Point | null {
  if (rect.width === 0 || rect.height === 0) return null;
  const p = canvasToWorld(transform, {
    x: pointer.clientX - rect.left,
    y: pointer.clientY - rect.top,
  });
  if (p.x < 0 || p.y < 0 || p.x > image.w || p.y > image.h) return null;
  return { x: Math.round(p.x), y: Math.round(p.y) };
}
