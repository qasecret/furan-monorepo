import { describe, expect, it } from "vitest";

import { applyPolicy } from "../src/policy.js";
import type { DiffRegion, PolicyContext, RuleMatch } from "../src/types.js";

const region: DiffRegion = {
  id: "r1",
  severity: "major",
  category: "layout",
  bbox: { x: 0, y: 0, width: 100, height: 100 },
  description: "test",
  source: "l1",
  diffPercent: 5,
};

function match(
  ruleId: string,
  severity: number,
  action: "auto_approve" | "flag" = severity === 1 ? "auto_approve" : "flag",
  overrides?: Partial<RuleMatch>,
): RuleMatch {
  return {
    ruleId,
    ruleVersion: 1,
    ruleLabel: `Rule ${ruleId}`,
    action,
    severity,
    regionDiffPct: 5,
    won: false,
    ...overrides,
  };
}

describe("applyPolicy", () => {
  it("returns empty array for no matches", () => {
    const result = applyPolicy({ region, matches: [] });
    expect(result).toEqual([]);
  });

  it("marks single match as winner", () => {
    const ctx: PolicyContext = {
      region,
      matches: [match("a", 1)],
    };
    const result = applyPolicy(ctx);
    expect(result).toHaveLength(1);
    expect(result[0]!.won).toBe(true);
  });

  it("most restrictive wins (flag > auto_approve)", () => {
    const ctx: PolicyContext = {
      region,
      matches: [match("a", 1), match("b", 2)],
    };
    const result = applyPolicy(ctx);
    const winner = result.find((r) => r.won);
    expect(winner).toBeDefined();
    expect(winner!.ruleId).toBe("b");
    expect(winner!.severity).toBe(2);
    const loser = result.find((r) => !r.won);
    expect(loser).toBeDefined();
    expect(loser!.ruleId).toBe("a");
  });

  it("preserves all matches with correct won flags", () => {
    const ctx: PolicyContext = {
      region,
      matches: [match("a", 1), match("b", 2), match("c", 1)],
    };
    const result = applyPolicy(ctx);
    expect(result.filter((r) => r.won)).toHaveLength(1);
    expect(result.filter((r) => !r.won)).toHaveLength(2);
  });
});
