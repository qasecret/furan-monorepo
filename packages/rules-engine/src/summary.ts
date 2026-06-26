import type { Action, RegionDecision } from "./types.js";

export function summarize(
  decisions: RegionDecision[],
): Record<Action | "unmatched", number> {
  const counts: Record<Action | "unmatched", number> = {
    auto_approve: 0,
    flag: 0,
    unmatched: 0,
  };

  for (const d of decisions) {
    if (d.finalAction) {
      counts[d.finalAction]++;
    } else {
      counts.unmatched++;
    }
  }

  return counts;
}
