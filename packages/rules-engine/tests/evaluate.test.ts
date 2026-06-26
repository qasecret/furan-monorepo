import { describe, expect, it } from "vitest";

import { compileRules } from "../src/compiler.js";
import {
  createDefaultRegistries,
  evaluate,
  evaluateCompiled,
} from "../src/evaluate.js";
import type { AutoRule, DiffRegion, ElementMap } from "../src/types.js";

const elementMap: ElementMap = [
  { selector: ".timestamp", bbox: { x: 0, y: 0, width: 200, height: 50 } },
  { selector: ".banner", bbox: { x: 0, y: 60, width: 400, height: 100 } },
];

function region(
  id: string,
  bbox: { x: number; y: number; width: number; height: number },
  diffPercent = 5,
): DiffRegion {
  return {
    id,
    severity: "major",
    category: "layout",
    bbox,
    description: "test",
    source: "l1",
    diffPercent,
  };
}

const rules: AutoRule[] = [
  {
    id: "rule-ts",
    version: 1,
    label: "Ignore timestamps",
    enabled: true,
    match: { type: "selector", value: ".timestamp" },
    conditions: { maxDiff: 10 },
    action: "auto_approve",
  },
  {
    id: "rule-banner",
    version: 2,
    label: "Flag banner changes",
    enabled: true,
    match: { type: "selector", value: ".banner" },
    conditions: null,
    action: "flag",
  },
];

describe("evaluate (convenience)", () => {
  it("evaluates rules against regions", () => {
    const result = evaluate({
      diffRegions: [
        region("r1", { x: 10, y: 10, width: 50, height: 30 }),
        region("r2", { x: 10, y: 70, width: 100, height: 50 }),
        region("r3", { x: 500, y: 500, width: 50, height: 50 }),
      ],
      elementMap,
      rules,
    });

    expect(result.decisions).toHaveLength(3);
    expect(result.counts.auto_approve).toBe(1);
    expect(result.counts.flag).toBe(1);
    expect(result.counts.unmatched).toBe(1);

    const r1Decision = result.decisions.find((d) => d.regionId === "r1");
    expect(r1Decision?.finalAction).toBe("auto_approve");
    expect(r1Decision?.winningRule?.ruleLabel).toBe("Ignore timestamps");

    const r2Decision = result.decisions.find((d) => d.regionId === "r2");
    expect(r2Decision?.finalAction).toBe("flag");

    const r3Decision = result.decisions.find((d) => d.regionId === "r3");
    expect(r3Decision?.finalAction).toBeNull();
    expect(r3Decision?.matchedRules).toHaveLength(0);
  });

  it("most restrictive wins when multiple rules match same region", () => {
    const overlappingRegion = region("r1", {
      x: 10,
      y: 10,
      width: 400,
      height: 150,
    });
    const result = evaluate({
      diffRegions: [overlappingRegion],
      elementMap,
      rules,
    });

    const d = result.decisions[0];
    expect(d!.matchedRules).toHaveLength(2);
    expect(d!.finalAction).toBe("flag");
    expect(d!.winningRule?.ruleLabel).toBe("Flag banner changes");
  });

  it("condition filters: maxDiff exceeded skips match", () => {
    const highDiffRegion = region(
      "r1",
      { x: 10, y: 10, width: 50, height: 30 },
      15,
    );
    const result = evaluate({
      diffRegions: [highDiffRegion],
      elementMap,
      rules,
    });

    const d = result.decisions[0];
    expect(
      d!.matchedRules.find((m) => m.ruleLabel === "Ignore timestamps"),
    ).toBeUndefined();
  });

  it("returns diagnostics", () => {
    const result = evaluate({
      diffRegions: [region("r1", { x: 10, y: 10, width: 50, height: 30 })],
      elementMap,
      rules,
    });
    expect(result.diagnostics.evaluatedRules).toBe(2);
    expect(result.diagnostics.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("handles empty rules", () => {
    const result = evaluate({
      diffRegions: [region("r1", { x: 10, y: 10, width: 50, height: 30 })],
      elementMap,
      rules: [],
    });
    expect(result.decisions).toHaveLength(1);
    expect(result.counts.unmatched).toBe(1);
  });

  it("handles null element map — all selectors miss", () => {
    const result = evaluate({
      diffRegions: [region("r1", { x: 10, y: 10, width: 50, height: 30 })],
      elementMap: null,
      rules,
    });
    expect(result.counts.unmatched).toBe(1);
    expect(result.diagnostics.skippedBecauseNoElementMap).toBeGreaterThan(0);
  });
});

describe("evaluateCompiled", () => {
  it("accepts pre-compiled ruleset", () => {
    const { matchers, conditions } = createDefaultRegistries();
    const ruleset = compileRules(rules, matchers, conditions);
    const result = evaluateCompiled({
      diffRegions: [region("r1", { x: 10, y: 10, width: 50, height: 30 })],
      elementMap,
      ruleset,
    });
    expect(result.decisions).toHaveLength(1);
    expect(result.counts.auto_approve).toBe(1);
  });
});
