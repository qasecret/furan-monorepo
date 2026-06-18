import type { BBox, DiffRegion, Severity } from "./layers/regionTypes";

const SEVERITY_RANK: Record<Severity, number> = {
  breaking: 0,
  major: 1,
  minor: 2,
  cosmetic: 3,
  none: 4,
};

function rank(sev: string): number {
  return SEVERITY_RANK[sev as Severity] ?? SEVERITY_RANK.none;
}

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
      .filter((r) => r.source !== "dynamic_text")
      .filter((r) => !(opts.hideDisplacement && r.category === "layout"))
      .slice()
      .sort(
        (a, b) =>
          rank(a.severity) - rank(b.severity) || area(b.bbox) - area(a.bbox),
      )
  );
}
