import { severityRank } from "@furan/shared-types";

import type { DiffRegion } from "./types.js";

// Re-exported so `@furan/diff-engine` keeps its public `severityRank`; the
// rank table itself lives in `@furan/shared-types`.
export { severityRank };

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
    const sa = severityRank(a.severity);
    const sb = severityRank(b.severity);
    if (sa !== sb) return sb - sa;
    return b.bbox.width * b.bbox.height - a.bbox.width * a.bbox.height;
  });
}
