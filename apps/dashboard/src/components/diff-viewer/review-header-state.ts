import type {
  CheckpointReviewState,
  RunStatus,
  RunStatusOverride,
} from "@furan/shared-types";

import {
  DECISIONS_LOCKED_BY_OVERRIDE,
  describeBlockedRun,
  describeRefusal,
} from "@/lib/review/review-copy";

/**
 * Which header the viewer shows for the selected step (spec §6.2).
 *
 * - `decided`: `approved` / `rejected`, with who and when. A decided step
 *   always shows its decision (R41); a run that cannot take decisions only
 *   takes the Undo away.
 * - `overridden`: the run's status was set by hand, so step decisions are off.
 * - `not-reviewable`: the run is not reviewable (processing, aborted, empty),
 *   or the selected step is not known / not diffed yet.
 * - `pending`: `new` / `unresolved`, waiting for a reviewer.
 * - `machine-passed`: the diff found nothing; no decision is asked for.
 */
export type ReviewView =
  "pending" | "decided" | "machine-passed" | "overridden" | "not-reviewable";

export interface ReviewHeaderInput {
  /** The run's status as the viewer knows it. */
  status: RunStatus;
  /** The run's hand-set status, or null when it is computed. */
  statusOverride: RunStatusOverride | null;
  /**
   * The selected step. Undefined when it is not known: the `_first`
   * placeholder, an id the run does not have, a list that has not loaded.
   */
  step:
    { state: CheckpointReviewState | null; hasDecision: boolean } | undefined;
  /** The review state of every step loaded for the run; undefined until loaded. */
  stepStates: ReadonlyArray<CheckpointReviewState | null> | undefined;
  /** The selected step has a decision on its way to the server. */
  stepInFlight: boolean;
  /** Some step of the run has a decision on its way to the server. */
  runInFlight: boolean;
}

export interface ReviewHeader {
  view: ReviewView;
  /** Why Mark as Bug / Reject / Approve are disabled; null when they are not. */
  disabledReason: string | null;
  /**
   * Why a decided step cannot be undone right now, because of the run
   * (overridden, or not reviewable); null when the run takes decisions.
   */
  decisionLockedReason: string | null;
  /** The More menu applies: the run is overridden or can take decisions. */
  showRunMenu: boolean;
  /** The selected step may be approved / rejected right now. */
  canApprove: boolean;
  canReject: boolean;
  /** How many steps of the run still need a reviewer. */
  pendingSteps: number;
  /** Approve pending steps is available: some are pending, none in flight. */
  canApprovePendingSteps: boolean;
  /**
   * The run's status may be set by hand (where the server accepts it), or
   * cleared if it was.
   */
  canOverride: boolean;
}

// A run in one of these states has nothing to review (yet). `running` also
// stands in for "a step has no verdict": the status rollup reports it so.
const NOT_REVIEWABLE: ReadonlySet<RunStatus> = new Set<RunStatus>([
  "running",
  "aborted",
  "empty",
]);

// The statuses `runs.overrideStatus` accepts an override from, mirroring the
// server's REVIEWER_LEGAL_FROM (apps/api/src/trpc/v1/runs.ts): Force passed /
// Force failed are offered nowhere the server would refuse them (a `new` run).
// An overridden run's status is its override, so it can always be reset.
const OVERRIDE_LEGAL_FROM: ReadonlySet<RunStatus> = new Set<RunStatus>([
  "passed",
  "unresolved",
  "failed",
]);

const isPendingState = (state: CheckpointReviewState | null): boolean =>
  state === "new" || state === "unresolved";

/**
 * What the review header shows and allows, from what the viewer knows. Pure:
 * `useReviewActions` feeds it the queries and the in-flight state, and the
 * buttons, the menu and the keyboard shortcuts all follow its answer.
 *
 * The step actions mirror what the server will accept (spec §5.4): approve
 * only a `new` / `unresolved` step, reject those and a `passed` one, and
 * either only while the run is reviewable and not overridden.
 */
export function deriveReviewHeader(input: ReviewHeaderInput): ReviewHeader {
  const { status, statusOverride, step, stepStates } = input;
  const state = step?.state ?? null;

  const overridden = statusOverride !== null;
  // The run cannot be reviewed: it is processing, was aborted or recorded
  // nothing, or some step of it has no verdict yet.
  const blocked =
    NOT_REVIEWABLE.has(status) ||
    (stepStates?.some((s) => s === null) ?? false);
  // The selected step is not known, or has no verdict yet: nothing to act on,
  // and it reads as still processing.
  const loading = step === undefined || state === null;

  const decided =
    step?.hasDecision === true &&
    (state === "approved" || state === "rejected");
  const view: ReviewView = decided
    ? "decided"
    : overridden
      ? "overridden"
      : blocked || loading
        ? "not-reviewable"
        : state === "passed"
          ? "machine-passed"
          : "pending";

  const disabledReason = overridden
    ? describeRefusal("run_overridden")
    : blocked
      ? describeBlockedRun(status)
      : loading
        ? describeRefusal("not_reviewable")
        : null;
  const decisionLockedReason = overridden
    ? DECISIONS_LOCKED_BY_OVERRIDE
    : blocked
      ? describeBlockedRun(status)
      : null;

  const reviewable = !overridden && !blocked;
  const actionable = reviewable && step !== undefined && !input.stepInFlight;
  const pendingSteps = (stepStates ?? []).filter(isPendingState).length;

  return {
    view,
    disabledReason,
    decisionLockedReason,
    showRunMenu: overridden || !(blocked || loading),
    canApprove: actionable && isPendingState(state),
    canReject: actionable && (isPendingState(state) || state === "passed"),
    pendingSteps,
    canApprovePendingSteps:
      reviewable && pendingSteps > 0 && !input.runInFlight,
    canOverride: overridden || (!blocked && OVERRIDE_LEGAL_FROM.has(status)),
  };
}
