import { pgEnum } from "drizzle-orm/pg-core";

export const userRoleEnum = pgEnum("user_role", [
  "admin",
  "editor",
  "guest",
  "owner",
]);
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

/**
 * What the diff found for one checkpoint (`screenshots.verdict`). NULL on the
 * column means "not diffed yet". Mirrors `checkpointVerdictSchema` in
 * `@furan/shared-types` (`review.ts`).
 */
export const checkpointVerdictEnum = pgEnum("checkpoint_verdict", [
  "new",
  "passed",
  "unresolved",
]);
export type CheckpointVerdict =
  (typeof checkpointVerdictEnum.enumValues)[number];

/**
 * The run-level "Force passed / Force failed" override
 * (`test_runs.status_override`). NULL = use the computed rollup.
 */
export const runStatusOverrideEnum = pgEnum("run_status_override", [
  "passed",
  "failed",
]);
export type RunStatusOverride =
  (typeof runStatusOverrideEnum.enumValues)[number];

/** What a reviewer decided for a checkpoint (`checkpoint_decisions.decision`). */
export const checkpointDecisionEnum = pgEnum("checkpoint_decision", [
  "approved",
  "rejected",
]);
export type CheckpointDecision =
  (typeof checkpointDecisionEnum.enumValues)[number];
