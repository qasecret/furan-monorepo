import type { Action, RegionDecision } from "@furan/rules-engine";
import { describe, expect, it } from "vitest";

import {
  checkpointFails,
  regionEngineId,
  type ViewportStatusInput,
} from "../src/rules-aggregation.js";

function decision(
  regionId: string,
  finalAction: Action | null,
): RegionDecision {
  return { regionId, matchedRules: [], winningRule: null, finalAction };
}

const rulesResult = (decisions: RegionDecision[]) => ({ decisions });

const vp = (passed: boolean, regionCount: number): ViewportStatusInput => ({
  passed,
  regionCount,
});

describe("regionEngineId", () => {
  it("encodes the step's region index, in the 0:i shape", () => {
    expect(regionEngineId(0)).toBe("0:0");
    expect(regionEngineId(2)).toBe("0:2");
  });
});

describe("checkpointFails", () => {
  it("a passed checkpoint never fails, rules or not", () => {
    expect(checkpointFails(vp(true, 0), null)).toBe(false);
    expect(
      checkpointFails(vp(true, 2), rulesResult([decision("0:0", "flag")])),
    ).toBe(false);
  });

  it("with no rules, a checkpoint fails iff it did not pass", () => {
    expect(checkpointFails(vp(false, 3), null)).toBe(true);
    expect(checkpointFails(vp(false, 0), null)).toBe(true);
  });

  it("is resolved when ALL its regions are auto_approved", () => {
    const decisions = [
      decision("0:0", "auto_approve"),
      decision("0:1", "auto_approve"),
    ];
    expect(checkpointFails(vp(false, 2), rulesResult(decisions))).toBe(false);
  });

  it("a failed checkpoint with ZERO regions stays failed even when rules exist", () => {
    // Without the explicit zero-region guard, an empty region loop would
    // silently flip the checkpoint to passed.
    expect(checkpointFails(vp(false, 0), rulesResult([]))).toBe(true);
  });

  it("a checkpoint with one non-auto_approve region stays failed", () => {
    const decisions = [
      decision("0:0", "auto_approve"),
      decision("0:1", "flag"),
    ];
    expect(checkpointFails(vp(false, 2), rulesResult(decisions))).toBe(true);
  });

  it("a flag-only match leaves the checkpoint failed", () => {
    expect(
      checkpointFails(vp(false, 1), rulesResult([decision("0:0", "flag")])),
    ).toBe(true);
  });

  it("a region with no decision keeps the checkpoint failed", () => {
    // 0:1 has no decision.
    const decisions = [decision("0:0", "auto_approve")];
    expect(checkpointFails(vp(false, 2), rulesResult(decisions))).toBe(true);
  });

  it("a region decided with a null finalAction keeps the checkpoint failed", () => {
    expect(
      checkpointFails(vp(false, 1), rulesResult([decision("0:0", null)])),
    ).toBe(true);
  });
});
