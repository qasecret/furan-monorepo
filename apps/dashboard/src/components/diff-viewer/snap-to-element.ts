import type { ElementBbox } from "./useElementMap";

interface Bbox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Find the smallest-area element whose bbox fully contains `draft`.
 * Returns null when nothing contains it. Tolerance: 2px on each side
 * (handles sub-pixel SDK rounding + slight overdraw in the canvas).
 *
 * Linear scan over the element map (typically 100–500 entries); well
 * under a millisecond, no memoization needed.
 *
 * Ties on identical area resolve to the first-encountered selector in
 * the map's iteration order — Object.entries preserves insertion order,
 * which mirrors the SDK's DOM-order capture.
 */
export function findSmallestContainingElement(
  draft: Bbox,
  elements: Record<string, ElementBbox>,
): { selector: string; bbox: ElementBbox } | null {
  const tol = 2;
  let best: { selector: string; bbox: ElementBbox; area: number } | null = null;
  for (const [selector, bbox] of Object.entries(elements)) {
    const containsX =
      bbox.x - tol <= draft.x &&
      bbox.x + bbox.width + tol >= draft.x + draft.width;
    const containsY =
      bbox.y - tol <= draft.y &&
      bbox.y + bbox.height + tol >= draft.y + draft.height;
    if (!containsX || !containsY) continue;
    const area = bbox.width * bbox.height;
    if (best === null || area < best.area) {
      best = { selector, bbox, area };
    }
  }
  return best ? { selector: best.selector, bbox: best.bbox } : null;
}

interface Point {
  x: number;
  y: number;
}

/**
 * Find the smallest-area element whose bbox contains a single point.
 * Drives the "pick element" input mode in the diff viewer: the user
 * hovers an image-space point and we resolve it to the deepest /
 * smallest matching element from the SDK's captured element map.
 *
 * Same linear-scan complexity as findSmallestContainingElement;
 * elements without overlap are skipped early. No tolerance — a click
 * is a point, the user gets exactly what they pointed at.
 */
export function findSmallestElementAtPoint(
  point: Point,
  elements: Record<string, ElementBbox>,
): { selector: string; bbox: ElementBbox } | null {
  let best: { selector: string; bbox: ElementBbox; area: number } | null = null;
  for (const [selector, bbox] of Object.entries(elements)) {
    if (
      point.x < bbox.x ||
      point.y < bbox.y ||
      point.x > bbox.x + bbox.width ||
      point.y > bbox.y + bbox.height
    ) {
      continue;
    }
    const area = bbox.width * bbox.height;
    if (best === null || area < best.area) {
      best = { selector, bbox, area };
    }
  }
  return best ? { selector: best.selector, bbox: best.bbox } : null;
}
