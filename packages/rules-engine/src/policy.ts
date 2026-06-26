import type { PolicyContext, RuleMatch } from "./types.js";

export function applyPolicy(context: PolicyContext): RuleMatch[] {
  const { matches } = context;
  if (matches.length === 0) return [];

  const sorted = [...matches].sort((a, b) => b.severity - a.severity);
  return sorted.map((m, i) => ({ ...m, won: i === 0 }));
}
