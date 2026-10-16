/**
 * One "world" for every comparison mode.
 *
 * The world is the union of the image sizes. Every image is anchored at the
 * world's top-left corner at 1:1, so a pixel means the same thing in every
 * mode. The part of the world an image does not cover is reported as
 * `missing` (the renderers hatch it). Fit, transform, zoom-about-a-point and
 * coordinate conversion are defined on the world, so the renderers never do
 * per-image maths.
 *
 * Pure: no pixi, no DOM, no state.
 */

import { ZOOM_MAX, ZOOM_MIN } from "./useViewerStore";
import { MAX_UPSCALE, MIN_FIT_SCALE } from "./world-fit";

export interface Size {
  w: number;
  h: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface World {
  size: Size;
  rects: { baseline: Rect | null; current: Rect; diff: Rect | null };
  /** World area an image does not cover; `[]` when it covers all of it. */
  missing: { baseline: Rect[]; current: Rect[] };
}

/** Zoom multiplies the fit scale; pan is in canvas pixels. */
export interface View {
  zoom: number;
  panX: number;
  panY: number;
}

/** World to canvas pixels: `canvas = world * scale + (x, y)`. */
export interface Transform {
  scale: number;
  x: number;
  y: number;
}

const rectOf = (s: Size): Rect => ({ x: 0, y: 0, w: s.w, h: s.h });

/**
 * The parts of a `world`-sized area that an image anchored top-left does not
 * cover. Only a right strip and a bottom strip are possible. The right strip
 * takes the full world height; the bottom strip spans only the image's own
 * width, so the two never overlap.
 */
function uncovered(world: Size, image: Size | null): Rect[] {
  if (!image) return [];
  const strips: Rect[] = [];
  if (image.w < world.w) {
    strips.push({ x: image.w, y: 0, w: world.w - image.w, h: world.h });
  }
  if (image.h < world.h) {
    strips.push({ x: 0, y: image.h, w: image.w, h: world.h - image.h });
  }
  return strips;
}

export function worldFor(
  baseline: Size | null,
  current: Size,
  diff: Size | null,
): World {
  const sizes = [baseline, current, diff].filter((s): s is Size => s !== null);
  const size: Size = {
    w: Math.max(...sizes.map((s) => s.w)),
    h: Math.max(...sizes.map((s) => s.h)),
  };
  return {
    size,
    rects: {
      baseline: baseline ? rectOf(baseline) : null,
      current: rectOf(current),
      diff: diff ? rectOf(diff) : null,
    },
    missing: {
      baseline: uncovered(size, baseline),
      current: uncovered(size, current),
    },
  };
}

/**
 * The uniform scale that fits `world` inside `viewport`: never more than
 * `MAX_UPSCALE`, never less than `MIN_FIT_SCALE`; 1 for degenerate sizes.
 * Same rule as `computeFitScale` in `world-fit.ts`.
 */
export function fitScale(world: Size, viewport: Size): number {
  if (world.w <= 0 || world.h <= 0 || viewport.w <= 0 || viewport.h <= 0) {
    return 1;
  }
  const scale = Math.min(
    viewport.w / world.w,
    viewport.h / world.h,
    MAX_UPSCALE,
  );
  return Math.max(scale, MIN_FIT_SCALE);
}

/** The world centred in the viewport at fit scale, then zoomed, then panned. */
export function transformFor(
  world: Size,
  viewport: Size,
  view: View,
): Transform {
  const scale = fitScale(world, viewport) * view.zoom;
  return {
    scale,
    x: (viewport.w - world.w * scale) / 2 + view.panX,
    y: (viewport.h - world.h * scale) / 2 + view.panY,
  };
}

/**
 * Zoom by `factor` about `point` (canvas px): the world point under `point`
 * stays under it. The resulting zoom is clamped to the viewer's zoom range;
 * when the clamp bites, the anchor still holds at the clamped zoom.
 */
export function zoomAbout(
  view: View,
  factor: number,
  point: Point,
  world: Size,
  viewport: Size,
): View {
  const before = transformFor(world, viewport, view);
  const anchor = canvasToWorld(before, point);
  const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, view.zoom * factor));
  const scale = fitScale(world, viewport) * zoom;
  // Where the world's top-left must land so `anchor` maps back onto `point`,
  // minus where it lands with no pan.
  return {
    zoom,
    panX: point.x - anchor.x * scale - (viewport.w - world.w * scale) / 2,
    panY: point.y - anchor.y * scale - (viewport.h - world.h * scale) / 2,
  };
}

export function worldToCanvas(t: Transform, p: Point): Point {
  return { x: p.x * t.scale + t.x, y: p.y * t.scale + t.y };
}

export function canvasToWorld(t: Transform, p: Point): Point {
  return { x: (p.x - t.x) / t.scale, y: (p.y - t.y) / t.scale };
}
