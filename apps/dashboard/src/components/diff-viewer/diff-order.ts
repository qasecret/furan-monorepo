import { compareSeverity } from "@furan/shared-types";

import { asSeverity, type BBox, type DiffRegion } from "./layers/regionTypes";
import { isRegionHidden } from "./region-visibility";

function area(bbox: BBox | unknown): number {
  if (!bbox || typeof bbox !== "object") return 0;
  const b = bbox as Partial<BBox>;
  if (typeof b.width !== "number" || typeof b.height !== "number") return 0;
  return b.width * b.height;
}

/**
 * Stepper/list ordering for diff regions. Surfaces l1_pixel image regions
 * (the primary "what changed" signal) and drops only dynamic-text audit rows
 * (shown via the audit toggle) and, optionally, position-only `layout`
 * changes. Worst severity first, then larger area first.
 */
export function orderDiffRegions(
  regions: DiffRegion[],
  opts: { hideDisplacement?: boolean } = {},
): DiffRegion[] {
  return (
    regions
      // Image-first (ADR-047): l1_pixel image regions ARE the meaningful set —
      // surface them in the stepper + side-by-side shading. dynamic_text audit
      // rows stay out (shown only via the audit toggle). P2 re-bases the
      // engine's checkpoint-signature onto these same image regions to re-sync
      // grouping.
      // ADR-053: layout_suppressed audit rows are hidden here too (shown via
      // the "Show suppressed" toggle), mirroring the engine's EXCLUDED_SOURCES.
      .filter((r) => !isRegionHidden(r, { showSuppressed: false }))
      .filter((r) => !(opts.hideDisplacement && r.category === "layout"))
      .slice()
      .sort(
        (a, b) =>
          compareSeverity(asSeverity(a.severity), asSeverity(b.severity)) ||
          area(b.bbox) - area(a.bbox),
      )
  );
}
