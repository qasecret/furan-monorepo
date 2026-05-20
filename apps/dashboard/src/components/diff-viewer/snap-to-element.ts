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
