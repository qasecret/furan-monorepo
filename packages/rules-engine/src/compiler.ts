import type { ConditionRegistry } from "./conditions/registry.js";
import type { MatcherRegistry } from "./matchers/registry.js";
import type { AutoRule, CompiledRule, CompiledRuleset } from "./types.js";
import { SEVERITY as SEVERITY_MAP } from "./types.js";

export function compileRules(
  rules: AutoRule[],
  matchers: MatcherRegistry,
  conditions: ConditionRegistry,
): CompiledRuleset {
  matchers.freeze();
  conditions.freeze();

  const compiled: CompiledRule[] = rules.map((rule) => ({
    id: rule.id,
    version: rule.version,
    label: rule.label,
    action: rule.action,
    severity: SEVERITY_MAP[rule.action],
    matcher: (region, elementMap) =>
      matchers.resolve(rule.match, region, elementMap),
    conditions: (region, candidate) =>
      conditions.evaluateAll(rule.conditions, { region, candidate }),
  }));

  const version =
    rules.length > 0 ? Math.max(...rules.map((r) => r.version)) : 0;

  return {
    version,
    rules: compiled,
    diagnostics: { compiledAt: performance.now() },
  };
}
