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
 * Stepper/list ordering for diff regions. Drops noisy L1 pixel clusters and
 * dynamic-text audit rows (shown only in `Difference` mode / the audit
 * toggle), and optionally position-only `layout` changes. Worst severity
 * first, then larger area first.
 */
export function orderDiffRegions(
  regions: DiffRegion[],
  opts: { hideDisplacement?: boolean } = {},
): DiffRegion[] {
  return (
    regions
      // KEEP IN SYNC with EXCLUDED_SOURCES in the diff-engine's
      // checkpoint-signature.ts: the same "meaningful region" set must drive both
      // what the reviewer sees here and what the grouping signature hashes there.
      .filter((r) => r.source !== "l1_pixel" && r.source !== "dynamic_text")
      .filter((r) => !(opts.hideDisplacement && r.category === "layout"))
      .slice()
      .sort(
        (a, b) =>
          rank(a.severity) - rank(b.severity) || area(b.bbox) - area(a.bbox),
      )
  );
}
