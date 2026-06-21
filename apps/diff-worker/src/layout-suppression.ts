import type { BBox } from "./bbox.js";
import type { ElementBbox, ElementMap } from "./element-map-resolver.js";

export type LayoutDecision = "suppress" | "keep";

export type LayoutReason =
  // suppress: cluster sits inside an element whose bbox is unchanged
  | "stable_element"
  // keep: the containing element's bbox changed baseline→candidate
  | "moved_or_resized"
  // keep: the containing element has no counterpart in the baseline map
  | "absent_in_baseline"
  // keep: the cluster is contained by no mapped element
  | "orphan_no_container"
  // keep: an element map was missing → checkpoint degrades to Strict
  | "degraded_no_map";

export interface LayoutVerdict {
  decision: LayoutDecision;
  reason: LayoutReason;
  /** Selector of the containing element, when one was found. */
  selector?: string;
}

export interface LayoutOpts {
  /**
   * Containment slack when matching a cluster to an element (px).
   * Default 2 — matches the dashboard `snap-to-element` primitive and
   * absorbs the L1 extractor's 48px tile quantization.
   */
  containTol?: number;
  /**
   * Max per-dimension drift for "element unchanged" (px). Default 1 —
   * only sub-pixel capture rounding should differ for a truly stable
   * element; a real 2px nudge must be caught (kept).
   */
  bboxEqualTol?: number;
}

const DEFAULT_CONTAIN_TOL = 2;
const DEFAULT_BBOX_EQUAL_TOL = 1;

/**
 * True iff `a` and `b` differ by at most `tol` px in every dimension
 * (x, y, width, height) — i.e. the element is geometrically "unchanged"
 * across the baseline and candidate captures.
 */
export function bboxApproxEqual(a: BBox, b: BBox, tol: number): boolean {
  return (
    Math.abs(a.x - b.x) <= tol &&
    Math.abs(a.y - b.y) <= tol &&
    Math.abs(a.width - b.width) <= tol &&
    Math.abs(a.height - b.height) <= tol
  );
}

/**
 * Find the smallest-area element whose bbox contains `cluster` (within
 * `tol` px each side). Returns null when nothing contains it. Ties on
 * area resolve to the first selector in insertion order, mirroring the
 * SDK's DOM-order capture. Ported from the dashboard's `snap-to-element.ts`
 * so the worker and the diff viewer agree on containment.
 */
export function findSmallestContainingElement(
  cluster: BBox,
  elements: Record<string, ElementBbox>,
  tol: number = DEFAULT_CONTAIN_TOL,
): { selector: string; bbox: ElementBbox } | null {
  let best: { selector: string; bbox: ElementBbox; area: number } | null = null;
  for (const [selector, bbox] of Object.entries(elements)) {
    const containsX =
      bbox.x - tol <= cluster.x &&
      bbox.x + bbox.width + tol >= cluster.x + cluster.width;
    const containsY =
      bbox.y - tol <= cluster.y &&
      bbox.y + bbox.height + tol >= cluster.y + cluster.height;
    if (!containsX || !containsY) continue;
    const area = bbox.width * bbox.height;
    if (best === null || area < best.area) {
      best = { selector, bbox, area };
    }
  }
  return best ? { selector: best.selector, bbox: best.bbox } : null;
}

/**
 * Deterministically classify one L1 pixel-diff cluster under the Layout
 * match level. Assumes both element maps are present (the missing-map
 * degrade is handled by `classifyLayoutClusters`).
 *
 * Suppress (content/color-only → pass) iff the cluster sits inside an
 * element whose bbox is unchanged baseline→candidate; otherwise keep
 * (structural → fail). Fail-closed on every uncertainty.
 */
export function classifyCluster(
  clusterBbox: BBox,
  candidateMap: ElementMap,
  baselineMap: ElementMap,
  opts: LayoutOpts = {},
): LayoutVerdict {
  const containTol = opts.containTol ?? DEFAULT_CONTAIN_TOL;
  const bboxEqualTol = opts.bboxEqualTol ?? DEFAULT_BBOX_EQUAL_TOL;

  const hit = findSmallestContainingElement(
    clusterBbox,
    candidateMap.elements,
    containTol,
  );
  if (!hit) return { decision: "keep", reason: "orphan_no_container" };

  const baselineBbox = baselineMap.elements[hit.selector];
  if (!baselineBbox) {
    return {
      decision: "keep",
      reason: "absent_in_baseline",
      selector: hit.selector,
    };
  }

  if (bboxApproxEqual(hit.bbox, baselineBbox, bboxEqualTol)) {
    return {
      decision: "suppress",
      reason: "stable_element",
      selector: hit.selector,
    };
  }
  return {
    decision: "keep",
    reason: "moved_or_resized",
    selector: hit.selector,
  };
}

/**
 * Classify a checkpoint's L1 pixel-diff clusters under Layout, returning
 * one verdict per input cluster in order. When either element map is
 * missing the checkpoint cannot be evaluated geometrically, so every
 * cluster is `degraded_no_map` and the handler degrades the checkpoint to
 * Strict (fail-closed).
 */
export function classifyLayoutClusters(
  clusterBboxes: BBox[],
  candidateMap: ElementMap | null,
  baselineMap: ElementMap | null,
  opts: LayoutOpts = {},
): LayoutVerdict[] {
  if (!candidateMap || !baselineMap) {
    return clusterBboxes.map(
      (): LayoutVerdict => ({
        decision: "keep",
        reason: "degraded_no_map",
      }),
    );
  }
  return clusterBboxes.map((bbox) =>
    classifyCluster(bbox, candidateMap, baselineMap, opts),
  );
}
