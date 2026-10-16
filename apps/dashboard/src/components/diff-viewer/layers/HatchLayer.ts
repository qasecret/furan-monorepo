import { type Container, Graphics } from "pixi.js";

import type { Rect } from "../viewer-geometry";

/**
 * The hatching over the world area an image does not cover (spec §3.1): the
 * honest sign that the two screenshots differ in size, drawn the same in
 * every mode. Diagonal 45° lines in the `--fg-muted` token at low alpha.
 */

/** World px between neighbouring lines, measured along x (and along y). */
export const HATCH_SPACING = 8;
export const HATCH_ALPHA = 0.35;

/**
 * Draws `rects`' hatching into `g`, replacing what it held. The lines are
 * `x + y = c` for every multiple `c` of the spacing, so the hatching of two
 * rects that meet lines up. Each line is clipped to its rect analytically: a
 * mask per rect would cost a render pass. `pixelLine` keeps every line one
 * device pixel wide at any zoom, so the hatching stays visible on a
 * screenshot fitted far below 1:1.
 */
export function drawHatch(
  g: Graphics,
  rects: readonly Rect[],
  color: number,
): Graphics {
  g.clear();
  let lines = 0;
  for (const r of rects) {
    if (r.w <= 0 || r.h <= 0) continue;
    const right = r.x + r.w;
    const bottom = r.y + r.h;
    const first = Math.ceil((r.x + r.y) / HATCH_SPACING) * HATCH_SPACING;
    for (let c = first; c <= right + bottom; c += HATCH_SPACING) {
      // Where the line x + y = c crosses the rect, as a span of x.
      const from = Math.max(r.x, c - bottom);
      const to = Math.min(right, c - r.y);
      // A line that only touches a corner has no length to draw.
      if (from >= to) continue;
      g.moveTo(from, c - from).lineTo(to, c - to);
      lines += 1;
    }
  }
  if (lines > 0) {
    g.stroke({ color, width: 1, alpha: HATCH_ALPHA, pixelLine: true });
  }
  return g;
}

/** A Graphics hatching `rects`, added to `parent`. */
export function mountHatchLayer(
  parent: Container,
  rects: Rect[],
  color: number,
): Graphics {
  const g = drawHatch(new Graphics(), rects, color);
  parent.addChild(g);
  return g;
}
