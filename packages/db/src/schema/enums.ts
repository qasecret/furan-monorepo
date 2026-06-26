import { pgEnum } from "drizzle-orm/pg-core";

export const userRoleEnum = pgEnum("user_role", ["admin", "editor", "guest"]);
export const environmentEnum = pgEnum("environment", [
  "default",
  "staging",
  "prod",
]);
export const imageComparisonEnum = pgEnum("image_comparison", [
  "pixelmatch",
  "looks_same",
  "odiff",
  "vlm",
]);
export const baselineSourceEnum = pgEnum("baseline_source", [
  "this_branch",
  "parent_pr",
  "default_branch",
]);
export const runStatusEnum = pgEnum("run_status", [
  "new",
  "running",
  "passed",
  "unresolved",
  "failed",
  "aborted",
  "empty",
]);

export type RunStatus = (typeof runStatusEnum.enumValues)[number];

export const autoRuleActionEnum = pgEnum("auto_rule_action", [
  "auto_approve",
  "flag",
]);
export type AutoRuleAction = (typeof autoRuleActionEnum.enumValues)[number];

export const resolutionSourceEnum = pgEnum("resolution_source", ["rule"]);
export type ResolutionSource = (typeof resolutionSourceEnum.enumValues)[number];
