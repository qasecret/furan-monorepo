import type {
  RevertSkipReason,
  ReviewRefusalReason,
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

/** Why a decision was refused, as a sentence for a toast. */
export function describeRefusal(reason: ReviewRefusalReason): string {
  return REFUSAL[reason];
}

/** Why an undo left a decision as it was: a fragment that follows "because". */
export function describeSkip(reason: RevertSkipReason | "not_decider"): string {
  return SKIP[reason];
}
