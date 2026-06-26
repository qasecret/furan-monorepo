import type { ConditionHandler } from "../types.js";

export const maxDiffCondition: ConditionHandler = (
  config,
  context,
): boolean => {
  // Fail SAFE on a malformed threshold. A non-finite value (string, null,
  // undefined, NaN from corrupt jsonb) would make `diffPercent <= NaN`
  // silently false for every region — indistinguishable from "matched
  // nothing". Treat it as an unsatisfiable condition so the rule does not
  // fire, rather than guessing a threshold.
  if (typeof config !== "number" || !Number.isFinite(config)) return false;
  return context.region.diffPercent <= config;
};
