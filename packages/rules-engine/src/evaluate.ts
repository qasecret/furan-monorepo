import { compileRules } from "./compiler.js";
import { maxDiffCondition } from "./conditions/max-diff.js";
import { ConditionRegistry } from "./conditions/registry.js";
import { MatcherRegistry } from "./matchers/registry.js";
import { selectorMatcher } from "./matchers/selector.js";
import { applyPolicy } from "./policy.js";
import { summarize } from "./summary.js";
import type {
  CompiledEvaluationInput,
  CompiledRuleset,
  DiffRegion,
  ElementMap,
  EvaluationInput,
  EvaluationResult,
  RegionDecision,
  RuleMatch,
} from "./types.js";

export function createDefaultRegistries(): {
  matchers: MatcherRegistry;
  conditions: ConditionRegistry;
} {
  const matchers = new MatcherRegistry();
  matchers.register("selector", selectorMatcher);
  const conditions = new ConditionRegistry();
  conditions.register("maxDiff", maxDiffCondition);
  return { matchers, conditions };
}

export function evaluateRegion(
  region: DiffRegion,
  ruleset: CompiledRuleset,
  elementMap: ElementMap | null,
): { decision: RegionDecision; selectorMisses: number; noElementMap: number } {
  const matches: RuleMatch[] = [];
  let selectorMisses = 0;
  let noElementMap = 0;

  for (const rule of ruleset.rules) {
    const candidate = rule.matcher(region, elementMap);

    if (!candidate.matched) {
      if (!elementMap) noElementMap++;
      else selectorMisses++;
      continue;
    }

    if (!rule.conditions(region, candidate)) continue;

    matches.push({
      ruleId: rule.id,
      ruleVersion: rule.version,
      ruleLabel: rule.label,
      action: rule.action,
      severity: rule.severity,
      regionDiffPct: region.diffPercent,
      won: false,
    });
  }

  const resolved = applyPolicy({ region, matches });
  const winner = resolved.find((r) => r.won) ?? null;

  return {
    decision: {
      regionId: region.id,
      matchedRules: resolved,
      winningRule: winner,
      finalAction: winner?.action ?? null,
    },
    selectorMisses,
    noElementMap,
  };
}

export function evaluateCompiled(
  input: CompiledEvaluationInput,
): EvaluationResult {
  const t0 = performance.now();
  const decisions: RegionDecision[] = [];
  let totalSelectorMisses = 0;
  let totalNoElementMap = 0;
  let totalMatched = 0;

  for (const region of input.diffRegions) {
    const { decision, selectorMisses, noElementMap } = evaluateRegion(
      region,
      input.ruleset,
      input.elementMap,
    );
    decisions.push(decision);
    totalSelectorMisses += selectorMisses;
    totalNoElementMap += noElementMap;
    totalMatched += decision.matchedRules.length;
  }

  return {
    decisions,
    counts: summarize(decisions),
    diagnostics: {
      evaluatedRules: input.ruleset.rules.length,
      matchedRules: totalMatched,
      skippedBecauseNoElementMap: totalNoElementMap,
      selectorMisses: totalSelectorMisses,
      durationMs: performance.now() - t0,
    },
  };
}

export function evaluate(input: EvaluationInput): EvaluationResult {
  const { matchers, conditions } = createDefaultRegistries();
  const ruleset = compileRules(input.rules, matchers, conditions);
  return evaluateCompiled({
    diffRegions: input.diffRegions,
    elementMap: input.elementMap,
    ruleset,
  });
}
