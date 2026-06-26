import type { ConditionHandler } from "../types.js";

export const maxDiffCondition: ConditionHandler = (
  config,
  context,
): boolean => {
  const threshold = Number(config);
  return context.region.diffPercent <= threshold;
};
