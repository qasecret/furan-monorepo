/**
 * Pure geometry helpers for mouse-resizing / moving an ignore region.
 *
 * All coordinates are in IMAGE space (natural screenshot pixels) — the same
 * space the store persists. The canvas layer renders these; the overlay's
 * pointer handlers hit-test against them. Keeping the math here (no pixi, no
 * React) makes the fiddly part unit-testable.
 */

export interface Bbox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The 8 drag handles: 4 corners + 4 edge midpoints. */
export type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

export const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

/** Minimum region extent (image px) so a resize can't collapse a box to nothing. */
export const MIN_REGION_PX = 4;

/** Image-space (x,y) of each handle for a bbox. */
export function handlePoints(
  b: Bbox,
): Record<Handle, { x: number; y: number }> {
  const { x, y, width: w, height: h } = b;
  const cx = x + w / 2;
  const cy = y + h / 2;
  return {
    nw: { x, y },
    n: { x: cx, y },
    ne: { x: x + w, y },
    e: { x: x + w, y: cy },
    se: { x: x + w, y: y + h },
    s: { x: cx, y: y + h },
    sw: { x, y: y + h },
    w: { x, y: cy },
  };
}

/** CSS cursor for each handle (NE/SW share a diagonal, etc.). */
export const HANDLE_CURSOR: Record<Handle, string> = {
  nw: "nwse-resize",
  se: "nwse-resize",
  ne: "nesw-resize",
  sw: "nesw-resize",
  n: "ns-resize",
  s: "ns-resize",
  e: "ew-resize",
  w: "ew-resize",
};

/**
 * Return the handle whose point is within `tol` (Chebyshev distance, image px)
 * of `pt`, or null. Corners win ties over edges so the diagonal grips are easy
 * to grab at a box's extremes.
 */
export function hitTestHandle(
  pt: { x: number; y: number },
  b: Bbox,
  tol: number,
): Handle | null {
  const pts = handlePoints(b);
  const order: Handle[] = ["nw", "ne", "se", "sw", "n", "e", "s", "w"];
  for (const h of order) {
    const p = pts[h];
    if (Math.abs(p.x - pt.x) <= tol && Math.abs(p.y - pt.y) <= tol) return h;
  }
  return null;
}

/** Is `pt` inside the bbox (used to start a move-drag on the body)? */
export function isInsideBbox(pt: { x: number; y: number }, b: Bbox): boolean {
  return (
    pt.x >= b.x &&
    pt.x <= b.x + b.width &&
    pt.y >= b.y &&
    pt.y <= b.y + b.height
  );
}

function normalize(x1: number, y1: number, x2: number, y2: number): Bbox {
  const x = Math.min(x1, x2);
  const y = Math.min(y1, y2);
  return {
    x,
    y,
    width: Math.max(MIN_REGION_PX, Math.abs(x2 - x1)),
    height: Math.max(MIN_REGION_PX, Math.abs(y2 - y1)),
  };
}

/**
 * New bbox after dragging `handle` of `start` to image point `pt`. The edge(s)
 * the handle does NOT control stay fixed (corner handles move two edges, edge
 * handles one). Result is normalized so flipping past the anchor stays valid.
 */
export function applyHandleResize(
  handle: Handle,
  start: Bbox,
  pt: {
    x: number;
    y: number;
  },
): Bbox {
  const left = start.x;
  const top = start.y;
  const right = start.x + start.width;
  const bottom = start.y + start.height;
  switch (handle) {
    case "nw":
      return normalize(pt.x, pt.y, right, bottom);
    case "ne":
      return normalize(left, pt.y, pt.x, bottom);
    case "se":
      return normalize(left, top, pt.x, pt.y);
    case "sw":
      return normalize(pt.x, top, right, pt.y);
    case "n":
      return normalize(left, pt.y, right, bottom);
    case "s":
      return normalize(left, top, right, pt.y);
    case "e":
      return normalize(left, top, pt.x, bottom);
    case "w":
      return normalize(pt.x, top, right, bottom);
  }
}

/** Translate a bbox by (dx,dy), clamped to stay within the image bounds. */
export function applyMove(
  start: Bbox,
  dx: number,
  dy: number,
  imageWidth: number,
  imageHeight: number,
): Bbox {
  const x = Math.max(0, Math.min(imageWidth - start.width, start.x + dx));
  const y = Math.max(0, Math.min(imageHeight - start.height, start.y + dy));
  return { ...start, x, y };
}
