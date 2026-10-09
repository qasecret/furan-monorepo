import type { Action, RegionDecision } from "@furan/rules-engine";
import { describe, expect, it } from "vitest";

import {
  aggregateRuleStatus,
  checkpointFailures,
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

const vp = (passed: boolean, regionCount: number): ViewportStatusInput => ({
  passed,
  regionCount,
});

describe("regionEngineId", () => {
  it("encodes checkpoint index + region index", () => {
    expect(regionEngineId(0, 2)).toBe("0:2");
    expect(regionEngineId(3, 0)).toBe("3:0");
  });
});

describe("checkpointFailures", () => {
  it("returns one verdict per checkpoint, in input order", () => {
    const decisions = [
      decision("0:0", "auto_approve"),
      decision("0:1", "auto_approve"),
    ];
    const r = checkpointFailures(
      [vp(false, 2), vp(true, 0), vp(false, 1)],
      rulesResult(decisions, { auto_approve: 2 }),
    );
    // cp0 fully auto-approved -> not failed; cp1 passed -> not failed;
    // cp2 failed with no decision for 2:0 -> still failed.
    expect(r).toEqual([false, false, true]);
  });

  it("with no rules, a checkpoint fails iff it did not pass", () => {
    expect(
      checkpointFailures([vp(true, 0), vp(false, 3), vp(false, 0)], null),
    ).toEqual([false, true, true]);
  });

  it("returns an empty array for no checkpoints", () => {
    expect(checkpointFailures([], null)).toEqual([]);
    expect(checkpointFailures([], rulesResult([]))).toEqual([]);
  });

  it("a failed checkpoint with ZERO regions stays failed even when rules exist", () => {
    expect(checkpointFailures([vp(false, 0)], rulesResult([]))).toEqual([true]);
  });

  it("a checkpoint with one non-auto_approve region stays failed", () => {
    const decisions = [
      decision("0:0", "auto_approve"),
      decision("0:1", "flag"),
    ];
    expect(
      checkpointFailures(
        [vp(false, 2)],
        rulesResult(decisions, { auto_approve: 1, flag: 1 }),
      ),
    ).toEqual([true]);
  });

  it("a region decided with a null finalAction keeps the checkpoint failed", () => {
    const decisions = [decision("0:0", null)];
    expect(checkpointFailures([vp(false, 1)], rulesResult(decisions))).toEqual([
      true,
    ]);
  });

  it("scores each checkpoint on its own decisions (index-keyed ids, shared viewport)", () => {
    const decisions = [
      decision("0:0", "auto_approve"),
      decision("1:0", "flag"),
    ];
    expect(
      checkpointFailures(
        [vp(false, 1), vp(false, 1)],
        rulesResult(decisions, { auto_approve: 1, flag: 1 }),
      ),
    ).toEqual([false, true]);
  });
});

describe("aggregateRuleStatus", () => {
  it("passes the run when every viewport passed", () => {
    const r = aggregateRuleStatus([vp(true, 0)], null);
    expect(r.aggregateFailed).toBe(false);
    expect(r.resolutionSource).toBeNull();
  });

  it("with no rules, any failed viewport fails the run (legacy semantics)", () => {
    const r = aggregateRuleStatus([vp(true, 0), vp(false, 3)], null);
    expect(r.aggregateFailed).toBe(true);
    expect(r.resolutionSource).toBeNull();
  });

  it("resolves a failed viewport when ALL its regions are auto_approved", () => {
    const decisions = [
      decision("0:0", "auto_approve"),
      decision("0:1", "auto_approve"),
    ];
    const r = aggregateRuleStatus(
      [vp(false, 2)],
      rulesResult(decisions, { auto_approve: 2 }),
    );
    expect(r.aggregateFailed).toBe(false);
    expect(r.resolutionSource).toBe("rule");
  });

  it("a flag-only match leaves the run unresolved and NOT attributed to a rule (#4)", () => {
    const decisions = [decision("0:0", "flag")];
    const r = aggregateRuleStatus(
      [vp(false, 1)],
      rulesResult(decisions, { flag: 1 }),
    );
    expect(r.aggregateFailed).toBe(true);
    expect(r.resolutionSource).toBeNull();
  });

  it("a failed viewport with ZERO regions stays failed even when rules exist (#3)", () => {
    // Without the explicit zero-region guard, some() over an empty array is
    // false and the viewport would be silently flipped to passed.
    const r = aggregateRuleStatus(
      [vp(false, 0)],
      rulesResult([], { auto_approve: 0 }),
    );
    expect(r.aggregateFailed).toBe(true);
    expect(r.resolutionSource).toBeNull();
  });

  it("a region with no decision keeps the viewport failed", () => {
    const decisions = [decision("0:0", "auto_approve")]; // 0:1 missing
    const r = aggregateRuleStatus(
      [vp(false, 2)],
      rulesResult(decisions, { auto_approve: 1 }),
    );
    expect(r.aggregateFailed).toBe(true);
    expect(r.resolutionSource).toBeNull();
  });

  it("a partially auto-approved viewport (one region flagged) stays failed", () => {
    const decisions = [
      decision("0:0", "auto_approve"),
      decision("0:1", "flag"),
    ];
    const r = aggregateRuleStatus(
      [vp(false, 2)],
      rulesResult(decisions, { auto_approve: 1, flag: 1 }),
    );
    expect(r.aggregateFailed).toBe(true);
    expect(r.resolutionSource).toBeNull();
  });

  it("resolves across multiple viewports (one passed, one fully auto-approved)", () => {
    const decisions = [decision("1:0", "auto_approve")];
    const r = aggregateRuleStatus(
      [vp(true, 0), vp(false, 1)],
      rulesResult(decisions, { auto_approve: 1 }),
    );
    expect(r.aggregateFailed).toBe(false);
    expect(r.resolutionSource).toBe("rule");
  });

  it("does not cross-wire two checkpoints that SHARE a viewport (index-keyed ids)", () => {
    // Both checkpoints would have been keyed "1280x720:0" under viewport-keyed
    // ids; checkpoint 1's decision would overwrite checkpoint 0's in the lookup
    // Map. With checkpoint-index keys (0:0 vs 1:0) each is resolved on its own
    // decision: checkpoint 0 is auto-approved (resolved), checkpoint 1 is
    // flagged (still failed) → the run stays failed.
    const decisions = [
      decision("0:0", "auto_approve"), // first 1280x720 checkpoint
      decision("1:0", "flag"), // second 1280x720 checkpoint
    ];
    const r = aggregateRuleStatus(
      [vp(false, 1), vp(false, 1)],
      rulesResult(decisions, { auto_approve: 1, flag: 1 }),
    );
    expect(r.aggregateFailed).toBe(true);
    expect(r.resolutionSource).toBeNull();
  });

  it("does not attribute to a rule when the run passed without any auto_approve", () => {
    // All viewports passed on pixels; rules ran but approved nothing.
    const r = aggregateRuleStatus(
      [vp(true, 0)],
      rulesResult([], { auto_approve: 0 }),
    );
    expect(r.aggregateFailed).toBe(false);
    expect(r.resolutionSource).toBeNull();
  });
});
