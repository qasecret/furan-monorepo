export interface BBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Standard AABB intersect test. Returns true iff the two bboxes share
 * interior area (touching edges don't count — the inequalities are
 * strict).
 *
 * Zero-area bboxes (width <= 0 OR height <= 0) intersect nothing. This
 * is load-bearing for the region-mode classifier: L2 regions whose
 * `route` couldn't be resolved keep `bbox: {0,0,0,0}`, and we want
 * them to silently fall through to original classification rather than
 * spuriously match every reviewer-drawn Layout/Content region.
 */
export function bboxIntersects(a: BBox, b: BBox): boolean {
  if (a.width <= 0 || a.height <= 0) return false;
  if (b.width <= 0 || b.height <= 0) return false;
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}
