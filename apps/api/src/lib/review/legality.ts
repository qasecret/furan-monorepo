import type {
  CheckpointDecisionKind,
  CheckpointVerdict,
  ReviewRefusalReason,
  RunStatus,
  RunStatusOverride,
} from "@furan/shared-types";

/**
 * Review legality (spec §5.4). Pure: the server enforces it through
 * `decideCheckpoints` / `selectPendingTargets`, and the dashboard mirrors it.
 */

/** What legality needs to know about one checkpoint and its run. */
export interface TargetFacts {
  /** The run's `test_runs.status`. */
  lifecycle: RunStatus;
  /** The run's `status_override`. */
  override: RunStatusOverride | null;
  /** Every checkpoint of the run has a verdict (no diff pending). */
  allVerdictsSet: boolean;
  /** This checkpoint's verdict; NULL = not diffed yet. */
  verdict: CheckpointVerdict | null;
  /** This checkpoint's active decision (`reverted_at IS NULL`), if any. */
  active: CheckpointDecisionKind | null;
}

/** Lifecycles in which nothing may be decided: a diff is still out, or the run never finished. */
const UNREVIEWABLE_LIFECYCLES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  "running",
  "aborted",
  "empty",
]);

/**
 * Why a run's checkpoints can't be reviewed right now, or null when they can.
 *
 * Checked in this order:
 * 1. A lifecycle of `running`, `aborted` or `empty` → `not_reviewable`.
 * 2. A `status_override` → `run_overridden`. The override must be cleared
 *    ("Reset to computed") before per-checkpoint review resumes; reported
 *    ahead of a pending diff because clearing it is the reviewer's next step.
 * 3. A checkpoint without a verdict → `not_reviewable`.
 */
export function assessRun(
  f: Pick<TargetFacts, "lifecycle" | "override" | "allVerdictsSet">,
): ReviewRefusalReason | null {
  if (UNREVIEWABLE_LIFECYCLES.has(f.lifecycle)) return "not_reviewable";
  if (f.override !== null) return "run_overridden";
  if (!f.allVerdictsSet) return "not_reviewable";
  return null;
}

/**
 * Whether `decision` may be recorded for a checkpoint (spec §5.4); null when
 * legal, otherwise the refusal reason.
 *
 * | Action  | Legal when                                                 | Otherwise                                              |
 * | ------- | ---------------------------------------------------------- | ------------------------------------------------------ |
 * | approve | reviewable, verdict ∈ {new, unresolved}, no active decision | not_reviewable / already_decided / nothing_to_approve |
 * | reject  | reviewable, verdict ∈ {new, unresolved, passed}, no active  | not_reviewable / already_decided                       |
 *
 * A decision is never changed directly (undo it first), so an active one is
 * `already_decided` whatever its kind and whatever the verdict.
 */
export function assessDecision(
  f: TargetFacts,
  decision: CheckpointDecisionKind,
): ReviewRefusalReason | null {
  const run = assessRun(f);
  if (run !== null) return run;
  // Unreachable while allVerdictsSet holds; kept so a caller passing
  // inconsistent facts can never decide an undiffed checkpoint.
  if (f.verdict === null) return "not_reviewable";
  if (f.active !== null) return "already_decided";
  if (decision === "approved" && f.verdict === "passed") {
    return "nothing_to_approve";
  }
  return null;
}
