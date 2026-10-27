import {
  reviewRefusalReasonSchema,
  type RevertSkipReason,
  type RunStatus,
  type ReviewErrorDetails,
  type ReviewRefusalReason,
} from "@furan/shared-types";

/**
 * Plain-English text for the reasons the review API gives. Each map is
 * exhaustive over its union, so a reason added in `@furan/shared-types` fails
 * the typecheck here until it has words.
 */

const REFUSAL = {
  not_reviewable: "This run is still processing",
  run_overridden: "Clear the run override to review steps",
  nothing_to_approve: "Nothing pending to approve",
  not_in_run: "This step is not part of the run",
  already_decided: "Already decided — undo it first",
  diff_failed: "Retry the diff first",
} as const satisfies Record<ReviewRefusalReason, string>;

const SKIP = {
  already_undone: "already undone",
  not_undoable_legacy: "decided before review history",
  history_corrupt: "its history can't be read",
  superseded_newer_capture: "a newer capture of this step exists",
  superseded_newer_baseline: "a newer baseline replaced it",
  history_expired: "its baseline was cleaned up",
  superseded_variation_edit: "the step's settings changed since",
  not_decider: "only the reviewer who decided or an admin can undo this",
} as const satisfies Record<RevertSkipReason | "not_decider", string>;

/** Why a run that will never be reviewable cannot be, in its own words. */
const BLOCKED_RUN = {
  aborted:
    "This run was aborted before it finished. Re-run the test to review it.",
  empty: "This run recorded no steps. Check the SDK integration.",
} as const;

/** Why a decided step cannot be undone while the run's status is overridden. */
export const DECISIONS_LOCKED_BY_OVERRIDE =
  "Clear the run override to change decisions";

/** Why a run's steps cannot be reviewed: for a disabled control's tooltip. */
export function describeBlockedRun(status: RunStatus): string {
  if (status === "aborted" || status === "empty") return BLOCKED_RUN[status];
  // Still running, or waiting on a step's diff: it will become reviewable.
  return describeRefusal("not_reviewable");
}

/** Why a decision was refused, as a sentence for a toast. */
export function describeRefusal(reason: ReviewRefusalReason): string {
  return REFUSAL[reason];
}

/** Why an undo left a decision as it was: a fragment that follows "because". */
export function describeSkip(reason: RevertSkipReason | "not_decider"): string {
  return SKIP[reason];
}

/** What the server tells the client when a review call is refused or fails. */
export interface ReviewError {
  /** The refusal word, e.g. `already_decided`, for a review refusal. */
  message: string;
  data?: { code?: string; details?: ReviewErrorDetails } | null;
}

const GENERIC_ERROR = "Couldn't save your review. Try again.";

/**
 * The toast for a failed review call. `stepName` finds a step's name by id for
 * the "already decided" message; a step it does not know reads as "this step".
 */
export function describeReviewError(
  err: ReviewError,
  stepName: (checkpointId: string) => string | undefined,
): string {
  const code = err.data?.code;
  if (code === "CONFLICT" && err.message === "already_decided") {
    const winner = err.data?.details?.winner;
    // Without a clear winner there is no one to name.
    if (winner?.kind !== "approved" && winner?.kind !== "rejected") {
      return describeRefusal("already_decided");
    }
    return `${winner.actorName ?? "Someone"} already ${winner.kind} ${stepName(winner.checkpointId) ?? "this step"}`;
  }
  if (code === "PRECONDITION_FAILED") {
    const reason = reviewRefusalReasonSchema.safeParse(err.message);
    if (reason.success) return describeRefusal(reason.data);
  }
  if (code === "FORBIDDEN" && err.message === "not_decider") {
    return describeSkip("not_decider");
  }
  return GENERIC_ERROR;
}

const OVERRIDE_ERROR = "Couldn't change the run status. Try again.";

/**
 * The toast for a failed run-status override. The server's own message names
 * internals (a lifecycle, a procedure), so only the code is read; anything
 * unrecognised gets one plain sentence.
 */
export function describeOverrideError(err: ReviewError): string {
  switch (err.data?.code) {
    case "BAD_REQUEST":
      return "The run's status can't be changed from where it is.";
    case "FORBIDDEN":
      return "You don't have permission to change this run's status.";
    case "NOT_FOUND":
      return "This run no longer exists.";
    default:
      return OVERRIDE_ERROR;
  }
}
