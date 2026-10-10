import { z } from "zod";

import type { RunStatus } from "./run-status.js";

/**
 * Per-checkpoint review model, shared by the db package, the api, the
 * diff-worker and the dashboard. Pure and dependency-free (zod only).
 *
 * A checkpoint is a `screenshots` row. The diff-worker computes its
 * `verdict` against the checkpoint's own baseline; a reviewer then records an
 * append-only `decision` (`checkpoint_decisions`). The run's status is a
 * rollup of both (see `rollupRunStatus`), written by exactly one DB function.
 *
 * DB source of truth for the enums is `packages/db/src/schema/enums.ts`
 * (`checkpoint_verdict`, `checkpoint_decision`, `run_status_override`); the
 * Zod schemas here mirror them for tRPC contracts.
 */

/** What the diff found for a checkpoint. NULL in the DB means "not diffed yet". */
export const checkpointVerdictSchema = z.enum(["new", "passed", "unresolved"]);
export type CheckpointVerdict = z.infer<typeof checkpointVerdictSchema>;

/** What a reviewer decided for a checkpoint. */
export const checkpointDecisionKindSchema = z.enum(["approved", "rejected"]);
export type CheckpointDecisionKind = z.infer<
  typeof checkpointDecisionKindSchema
>;

/** The "Force passed / Force failed" run-level override. */
export const runStatusOverrideSchema = z.enum(["passed", "failed"]);
export type RunStatusOverride = z.infer<typeof runStatusOverrideSchema>;

/** Where a decision came from (`checkpoint_decisions.source`). */
export const decisionSourceSchema = z.enum([
  "viewer",
  "batch",
  "group",
  "sdk",
  "inbox",
  "backfill",
]);
export type DecisionSource = z.infer<typeof decisionSourceSchema>;

/** Why a checkpoint was refused a decision. */
export const reviewRefusalReasonSchema = z.enum([
  "not_reviewable",
  "run_overridden",
  "already_decided",
  "nothing_to_approve",
  "not_in_run",
]);
export type ReviewRefusalReason = z.infer<typeof reviewRefusalReasonSchema>;

/** Why an undo left a decision as it was. */
export const revertSkipReasonSchema = z.enum([
  "already_undone",
  "not_undoable_legacy",
  "history_corrupt",
  "superseded_newer_capture",
  "superseded_newer_baseline",
  "history_expired",
  "superseded_variation_edit",
]);
export type RevertSkipReason = z.infer<typeof revertSkipReasonSchema>;

/**
 * The state every UI reads for one checkpoint: the reviewer's decision when
 * there is one, otherwise the diff verdict.
 */
export type CheckpointReviewState = CheckpointVerdict | CheckpointDecisionKind;

export function checkpointReviewState(
  verdict: CheckpointVerdict,
  decision: CheckpointDecisionKind | null,
): CheckpointReviewState {
  return decision ?? verdict;
}

/** True while a checkpoint still needs a reviewer: `new` or `unresolved`. */
export function isPending(state: CheckpointReviewState): boolean {
  return state === "new" || state === "unresolved";
}

export interface RollupInput {
  /** Current `test_runs.status`. */
  lifecycle: RunStatus;
  /** `test_runs.status_override`. */
  override: RunStatusOverride | null;
  /** One entry per checkpoint; `verdict` is NULL until it has been diffed. */
  checkpoints: ReadonlyArray<{
    verdict: CheckpointVerdict | null;
    decision: CheckpointDecisionKind | null;
  }>;
}

type RollupStatus = "failed" | "unresolved" | "new" | "passed";

/** Highest rank wins: failed > unresolved > new > passed. */
const STATUS_PRECEDENCE: Record<RollupStatus, number> = {
  passed: 0,
  new: 1,
  unresolved: 2,
  failed: 3,
};

/**
 * The run status implied by its checkpoints. The one rule; the DB writer
 * (`recomputeRunStatus`) is the only code that persists the result.
 *
 * Applied in order:
 * 1. `aborted` / `empty` are lifecycle states: returned unchanged.
 * 2. A run-level override wins.
 * 3. No checkpoints: the lifecycle status stands.
 * 4. Any checkpoint without a verdict: `running` (a diff is pending).
 * 5. Otherwise each checkpoint's effective state is `decision ?? verdict`
 *    (`approved` counts as passed, `rejected` as failed) and the highest by
 *    precedence wins: failed > unresolved > new > passed.
 */
export function rollupRunStatus(input: RollupInput): RunStatus {
  const { lifecycle, override, checkpoints } = input;

  if (lifecycle === "aborted" || lifecycle === "empty") return lifecycle;
  if (override !== null) return override;
  if (checkpoints.length === 0) return lifecycle;

  let worst: RollupStatus = "passed";
  for (const c of checkpoints) {
    // A diff is still pending for this checkpoint: it outranks everything.
    if (c.verdict === null) return "running";
    const status: RollupStatus =
      c.decision === "approved"
        ? "passed"
        : c.decision === "rejected"
          ? "failed"
          : c.verdict;
    if (STATUS_PRECEDENCE[status] > STATUS_PRECEDENCE[worst]) worst = status;
  }
  return worst;
}

/**
 * A jsonb column value inside a snapshot: any JSON value (including `null`),
 * but the KEY must be present. Plain `z.unknown()` would accept an omitted key
 * and drop it, so a revert built from the parsed snapshot would silently skip
 * restoring that column instead of refusing a corrupt snapshot. The declared
 * type excludes `undefined` so the inferred object keeps the key required.
 */
const jsonColumn = z.custom<NonNullable<unknown> | null>(
  (v) => v !== undefined,
  { message: "required" },
);

/** The variation fields an approve writes, and an undo puts back. */
const variationFields = {
  baselineName: z.string().nullable(),
  matchLevel: z.string(),
  ignoreRegions: jsonColumn,
  layoutRegions: jsonColumn,
  floatingRegions: jsonColumn,
  contentRegions: jsonColumn,
  accessibilityRegions: jsonColumn,
};

/**
 * The undo snapshot stored in `checkpoint_decisions.before`: what a decision
 * overwrote, so a revert can put it back. Written and read through this one
 * schema; a snapshot that fails to parse is refused (`history_corrupt`),
 * never half-applied.
 *
 * `baseline` and `variation` are both null for a reject (nothing to restore).
 * `prev.createdAt` is included because baseline writes re-stamp `created_at`
 * on the upsert's update branch (ADR-068) and `created_at` decides which
 * baseline is current. Timestamps are ISO strings; the region fields are
 * opaque JSON, but each key must be present (a missing key is a corrupt
 * snapshot, not an empty value).
 */
export const decisionSnapshotSchema = z.object({
  baseline: z
    .discriminatedUnion("op", [
      z.object({ op: z.literal("inserted"), id: z.string() }),
      z.object({
        op: z.literal("updated"),
        id: z.string(),
        prev: z.object({
          baselineName: z.string().nullable(),
          userId: z.string().nullable(),
          branchName: z.string(),
          createdAt: z.string(),
          updatedAt: z.string(),
        }),
      }),
    ])
    .nullable(),
  variation: z.object({ id: z.string(), ...variationFields }).nullable(),
  /**
   * The same fields exactly as the approve wrote them. An undo is refused
   * (`superseded_variation_edit`) when the variation no longer matches, so a
   * later reviewer edit is never silently wiped. Absent on rejects, and on
   * snapshots written before it existed (those keep the unchecked undo).
   */
  variationAfter: z.object(variationFields).optional(),
});
export type DecisionSnapshot = z.infer<typeof decisionSnapshotSchema>;

/** What "Approve all pending" in a build would do, shown before confirming. */
export interface ApproveBuildPreview {
  pendingCheckpoints: number;
  tests: number;
  rejectedLeftAsIs: number;
  notReviewableTests: number;
  capped: boolean;
  cap: number;
}

/** The `details` payload of review errors (standard `{ code, message, details }`). */
export interface ReviewErrorDetails {
  reasons?: Array<{ checkpointId: string; reason: ReviewRefusalReason }>;
  winner?: {
    checkpointId: string;
    kind: CheckpointDecisionKind;
    actorName: string | null;
  };
  preview?: ApproveBuildPreview;
}
