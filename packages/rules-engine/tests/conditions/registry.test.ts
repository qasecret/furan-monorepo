import { describe, expect, it } from "vitest";

import { maxDiffCondition } from "../../src/conditions/max-diff.js";
import { ConditionRegistry } from "../../src/conditions/registry.js";
import type { DiffRegion, MatchCandidate } from "../../src/types.js";

const candidate: MatchCandidate = {
  matched: true,
  overlap: 0.8,
  resolvedSelector: ".ts",
};

const region: DiffRegion = {
  id: "r1",
  severity: "major",
  category: "layout",
  bbox: { x: 0, y: 0, width: 100, height: 100 },
  description: "test",
  source: "l1",
  diffPercent: 2,
};

function makeRegistry() {
  const reg = new ConditionRegistry();
  reg.register("maxDiff", maxDiffCondition);
  return reg;
}

describe("ConditionRegistry.evaluateAll", () => {
  it("returns true when conditions is null (no guard)", () => {
    expect(makeRegistry().evaluateAll(null, { region, candidate })).toBe(true);
  });

  it("returns true when an empty conditions object is given", () => {
    expect(makeRegistry().evaluateAll({}, { region, candidate })).toBe(true);
  });

  it("evaluates a registered condition (AND semantics)", () => {
    const reg = makeRegistry();
    expect(reg.evaluateAll({ maxDiff: 5 }, { region, candidate })).toBe(true);
    expect(reg.evaluateAll({ maxDiff: 1 }, { region, candidate })).toBe(false);
  });

  it("FAILS SAFE on an unknown condition name (typo) — rule must not match", () => {
    const reg = makeRegistry();
    // "mxaDiff" is a typo; the guard cannot be evaluated, so the rule must
    // NOT match rather than silently firing without the cap.
    expect(reg.evaluateAll({ mxaDiff: 5 }, { region, candidate })).toBe(false);
  });

  it("fails safe even when a known condition would otherwise pass", () => {
    const reg = makeRegistry();
    expect(
      reg.evaluateAll(
        { maxDiff: 100, unknownThing: true },
        { region, candidate },
      ),
    ).toBe(false);
  });

  it("ignores prototype-polluting keys from parsed jsonb", () => {
    const reg = makeRegistry();
    const malicious = JSON.parse(
      '{"maxDiff": 5, "__proto__": {"x": 1}}',
    ) as Record<string, unknown>;
    // JSON.parse makes "__proto__" an own-enumerable key; the RESERVED_KEYS
    // skip drops it so the legitimate maxDiff:5 condition still evaluates.
    expect(reg.evaluateAll(malicious, { region, candidate })).toBe(true);
  });
});
