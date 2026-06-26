import type { Action, RegionDecision } from "@furan/rules-engine";
import { describe, expect, it } from "vitest";

import {
  aggregateRuleStatus,
  regionEngineId,
  type ViewportStatusInput,
} from "../src/rules-aggregation.js";

function decision(
  regionId: string,
  finalAction: Action | null,
): RegionDecision {
  return { regionId, matchedRules: [], winningRule: null, finalAction };
}

function rulesResult(
  decisions: RegionDecision[],
  counts: Partial<Record<Action | "unmatched", number>> = {},
) {
  return {
    decisions,
    counts: { auto_approve: 0, flag: 0, unmatched: 0, ...counts },
  };
}

const vp = (
  viewport: string | null,
  passed: boolean,
  regionCount: number,
): ViewportStatusInput => ({ viewport, passed, regionCount });

describe("regionEngineId", () => {
  it("encodes viewport + index, defaulting a null viewport", () => {
    expect(regionEngineId("1280x720", 2)).toBe("1280x720:2");
    expect(regionEngineId(null, 0)).toBe("default:0");
    expect(regionEngineId(undefined, 1)).toBe("default:1");
  });
});

describe("aggregateRuleStatus", () => {
  it("passes the run when every viewport passed", () => {
    const r = aggregateRuleStatus([vp("a", true, 0)], null);
    expect(r.aggregateFailed).toBe(false);
    expect(r.resolutionSource).toBeNull();
  });

  it("with no rules, any failed viewport fails the run (legacy semantics)", () => {
    const r = aggregateRuleStatus([vp("a", true, 0), vp("b", false, 3)], null);
    expect(r.aggregateFailed).toBe(true);
    expect(r.resolutionSource).toBeNull();
  });

  it("resolves a failed viewport when ALL its regions are auto_approved", () => {
    const decisions = [
      decision("a:0", "auto_approve"),
      decision("a:1", "auto_approve"),
    ];
    const r = aggregateRuleStatus(
      [vp("a", false, 2)],
      rulesResult(decisions, { auto_approve: 2 }),
    );
    expect(r.aggregateFailed).toBe(false);
    expect(r.resolutionSource).toBe("rule");
  });

  it("a flag-only match leaves the run unresolved and NOT attributed to a rule (#4)", () => {
    const decisions = [decision("a:0", "flag")];
    const r = aggregateRuleStatus(
      [vp("a", false, 1)],
      rulesResult(decisions, { flag: 1 }),
    );
    expect(r.aggregateFailed).toBe(true);
    expect(r.resolutionSource).toBeNull();
  });

  it("a failed viewport with ZERO regions stays failed even when rules exist (#3)", () => {
    // Without the explicit zero-region guard, some() over an empty array is
    // false and the viewport would be silently flipped to passed.
    const r = aggregateRuleStatus(
      [vp("a", false, 0)],
      rulesResult([], { auto_approve: 0 }),
    );
    expect(r.aggregateFailed).toBe(true);
    expect(r.resolutionSource).toBeNull();
  });

  it("a region with no decision keeps the viewport failed", () => {
    const decisions = [decision("a:0", "auto_approve")]; // a:1 missing
    const r = aggregateRuleStatus(
      [vp("a", false, 2)],
      rulesResult(decisions, { auto_approve: 1 }),
    );
    expect(r.aggregateFailed).toBe(true);
    expect(r.resolutionSource).toBeNull();
  });

  it("a partially auto-approved viewport (one region flagged) stays failed", () => {
    const decisions = [
      decision("a:0", "auto_approve"),
      decision("a:1", "flag"),
    ];
    const r = aggregateRuleStatus(
      [vp("a", false, 2)],
      rulesResult(decisions, { auto_approve: 1, flag: 1 }),
    );
    expect(r.aggregateFailed).toBe(true);
    expect(r.resolutionSource).toBeNull();
  });

  it("resolves across multiple viewports (one passed, one fully auto-approved)", () => {
    const decisions = [decision("b:0", "auto_approve")];
    const r = aggregateRuleStatus(
      [vp("a", true, 0), vp("b", false, 1)],
      rulesResult(decisions, { auto_approve: 1 }),
    );
    expect(r.aggregateFailed).toBe(false);
    expect(r.resolutionSource).toBe("rule");
  });

  it("does not attribute to a rule when the run passed without any auto_approve", () => {
    // All viewports passed on pixels; rules ran but approved nothing.
    const r = aggregateRuleStatus(
      [vp("a", true, 0)],
      rulesResult([], { auto_approve: 0 }),
    );
    expect(r.aggregateFailed).toBe(false);
    expect(r.resolutionSource).toBeNull();
  });
});
