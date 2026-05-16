import type { DiffRegion } from "./types.js";

const SEV_RANK: Record<DiffRegion["severity"], number> = {
  breaking: 4,
  major: 3,
  minor: 2,
  cosmetic: 1,
  none: 0,
};

export function classifyRegions(regions: DiffRegion[]): DiffRegion[] {
  const upgraded = regions.map((r) => {
    if (
      r.category === "text" &&
      /\b<h[12]>|heading|title\b/i.test(r.description)
    ) {
      return { ...r, severity: "breaking" as const };
    }
    return r;
  });
  return upgraded.sort((a, b) => {
    const sa = SEV_RANK[a.severity];
    const sb = SEV_RANK[b.severity];
    if (sa !== sb) return sb - sa;
    return b.bbox.width * b.bbox.height - a.bbox.width * a.bbox.height;
  });
}
