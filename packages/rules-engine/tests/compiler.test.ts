import { describe, expect, it } from "vitest";

import { compileRules } from "../src/compiler.js";
import { maxDiffCondition } from "../src/conditions/max-diff.js";
import { ConditionRegistry } from "../src/conditions/registry.js";
import { MatcherRegistry } from "../src/matchers/registry.js";
import { selectorMatcher } from "../src/matchers/selector.js";
import type { AutoRule } from "../src/types.js";

function makeRegistries() {
  const matchers = new MatcherRegistry();
  matchers.register("selector", selectorMatcher);
  const conditions = new ConditionRegistry();
  conditions.register("maxDiff", maxDiffCondition);
  return { matchers, conditions };
}

const rule: AutoRule = {
  id: "r1",
  version: 3,
  label: "Ignore timestamps",
  enabled: true,
  match: { type: "selector", value: ".timestamp" },
  conditions: { maxDiff: 10 },
  action: "auto_approve",
};

describe("compileRules", () => {
  it("produces a CompiledRuleset with correct version", () => {
    const { matchers, conditions } = makeRegistries();
    const ruleset = compileRules([rule], matchers, conditions);
    expect(ruleset.version).toBe(3);
    expect(ruleset.rules).toHaveLength(1);
    expect(ruleset.diagnostics.compiledAt).toBeGreaterThan(0);
  });

  it("version is max across all rules", () => {
    const { matchers, conditions } = makeRegistries();
    const rules: AutoRule[] = [
      { ...rule, id: "a", version: 2 },
      { ...rule, id: "b", version: 7 },
      { ...rule, id: "c", version: 5 },
    ];
    const ruleset = compileRules(rules, matchers, conditions);
    expect(ruleset.version).toBe(7);
  });

  it("compiled rule has correct metadata", () => {
    const { matchers, conditions } = makeRegistries();
    const ruleset = compileRules([rule], matchers, conditions);
    const cr = ruleset.rules[0];
    expect(cr!.id).toBe("r1");
    expect(cr!.label).toBe("Ignore timestamps");
    expect(cr!.action).toBe("auto_approve");
    expect(cr!.severity).toBe(1);
    expect(typeof cr!.matcher).toBe("function");
    expect(typeof cr!.conditions).toBe("function");
  });

  it("compiled rule with null conditions always passes conditions", () => {
    const { matchers, conditions } = makeRegistries();
    const noCondRule: AutoRule = { ...rule, conditions: null };
    const ruleset = compileRules([noCondRule], matchers, conditions);
    const cr = ruleset.rules[0];
    const region = {
      id: "x",
      severity: "major",
      category: "layout",
      bbox: { x: 0, y: 0, width: 100, height: 100 },
      description: "",
      source: "l1",
      diffPercent: 99,
    };
    const candidate = { matched: true, overlap: 1, resolvedSelector: ".ts" };
    expect(cr!.conditions(region, candidate)).toBe(true);
  });

  it("freezes registries after compilation", () => {
    const { matchers, conditions } = makeRegistries();
    compileRules([rule], matchers, conditions);
    expect(() =>
      matchers.register("x", () => ({
        matched: false,
        overlap: 0,
        resolvedSelector: null,
      })),
    ).toThrow(/frozen/);
    expect(() => conditions.register("x", () => true)).toThrow(/frozen/);
  });
});
