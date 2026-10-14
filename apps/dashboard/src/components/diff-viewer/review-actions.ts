"use client";

import type {
  CheckpointReviewState,
  OverrideStatusInput,
  RunStatus,
  RunStatusOverride,
} from "@furan/shared-types";
import { useState } from "react";
import { toast } from "sonner";

import {
  buildIgnoreAreasPayload,
  hasUnsavedIgnoreChanges,
} from "./ignore-area-payload";
import { useViewerStore } from "./useViewerStore";

import { plural } from "@/lib/format";
import type { CheckpointItem } from "@/lib/review/optimistic";
import {
  DECISIONS_LOCKED_BY_OVERRIDE,
  describeBlockedRun,
  describeRefusal,
} from "@/lib/review/review-copy";
import { useReviewMutations } from "@/lib/review/use-review-mutations";
import { trpc } from "@/lib/trpc";

type Decision = NonNullable<CheckpointItem["decision"]>;
type NewerCapture = NonNullable<CheckpointItem["newerCapture"]>;

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

// A run in one of these states has nothing to review (yet). `running` also
// stands in for "a step has no verdict": the status rollup reports it so.
const NOT_REVIEWABLE: ReadonlySet<RunStatus> = new Set<RunStatus>([
  "running",
  "aborted",
  "empty",
]);

export interface UseReviewActionsArgs {
  runId: string;
  /**
   * ADR-038: the currently-selected checkpoint id. Approve, reject and mark
   * as bug decide this step only. Without one (before the step list has
   * resolved) the step actions do nothing.
   */
  checkpointId?: string;
  /**
   * Current `test_runs.status`. Defaults to the run's own status as the
   * `runs.getById` query reports it, and to `running` — the safest value,
   * since it disables every action — until that has loaded.
   */
  status?: RunStatus;
  /**
   * Called right after a step is approved, rejected or marked as a bug, so
   * the parent can advance to the next pending step (fast triage loop). It
   * fires when the decision is made, not when the server answers: the screen
   * has already moved on, and a refusal arrives as a toast naming the step
   * and puts it back. Not fired from approve-pending or override.
   */
  onResolved?: () => void;
}

export interface ReviewActions {
  /** Effective run status (`running` until the run has loaded). */
  status: RunStatus;
  /** Which header the selected step gets. */
  view: ReviewView;
  /**
   * Why a decided step cannot be undone right now, because of the run
   * (overridden, or not reviewable); null when the run takes decisions.
   */
  decisionLockedReason: string | null;
  /** The More menu applies: the run is overridden or can take decisions. */
  showRunMenu: boolean;
  /** The run takes step decisions: it is reviewable and not overridden. */
  canReview: boolean;
  /** Why step decisions are unavailable, or null when they're available. */
  disabledReason: string | null;
  /** The selected step has a decision, or an override, in flight. */
  pending: boolean;
  isApproving: boolean;
  isRejecting: boolean;
  /**
   * Always null: failures arrive as toasts, from the review hook and from the
   * override call. Kept so the shape stays the one callers were written for.
   */
  error: string | null;
  /** The selected step's review state; null until it has been diffed. */
  state: CheckpointReviewState | null;
  /** The active decision on the selected step. */
  decision: Decision | null;
  /** A later run captured this step again (approving would go backwards). */
  newerCapture: NewerCapture | null;
  /** The run's hand-set status, or null when it is computed. */
  statusOverride: RunStatusOverride | null;
  /** How many steps of the run still need a reviewer. */
  pendingSteps: number;
  /** The selected step may be approved / rejected right now. */
  canApprove: boolean;
  canReject: boolean;
  /** Approve pending steps is available: some are pending, none in flight. */
  canApprovePendingSteps: boolean;
  /**
   * The question asked before an older capture is approved. `confirm`
   * approves; `cancel` decides nothing.
   */
  staleConfirm: { open: boolean; confirm: () => void; cancel: () => void };
  /**
   * Approve the selected step (after a confirmation, for an older capture).
   * Folds any unsaved ignore-region edits into the call.
   */
  approve: () => void;
  reject: () => void;
  /** Reject the selected step, then open the comment panel for a bug note. */
  markAsBug: () => void;
  /** Approve every step of the run that still needs a reviewer. */
  approveAllCheckpoints: () => void;
  /** Take back an action; see `useReviewMutations().undo`. */
  undo: (actionId: string) => void;
  /** Set the run's status by hand, or `default` to compute it again. */
  override: (next: OverrideStatusInput) => void;
}

const isPendingState = (state: CheckpointReviewState | null): boolean =>
  state === "new" || state === "unresolved";

/**
 * The single source of truth for the review actions on a run. The
 * ApprovalBar buttons and the DiffViewer keyboard shortcuts both call the
 * object this returns, so a keypress can never take a different path than
 * the matching button — same call, same gate, same payload, same
 * auto-advance.
 *
 * The step actions mirror what the server will accept (spec §5.4): approve
 * only a `new` / `unresolved` step, reject those and a `passed` one, and
 * either only while the run is reviewable and not overridden. Anything else
 * is a no-op, so the UI never sends a decision that would be refused.
 *
 * The decisions themselves, their optimistic result, the undo and the error
 * toasts live in `useReviewMutations`. The run-level override is not a
 * decision: it keeps `runs.overrideStatus`.
 */
export function useReviewActions({
  runId,
  checkpointId,
  status,
  onResolved,
}: UseReviewActionsArgs): ReviewActions {
  const utils = trpc.useUtils();
  const { decide, undo, isInFlight } = useReviewMutations();
  // The same queries the viewer reads, so these do not fetch twice.
  const checkpoints = trpc.runs.listCheckpoints.useQuery({ runId });
  const runQuery = trpc.runs.getById.useQuery({ runId });
  // Which step the confirm is open for; it closes if the selection moves.
  const [confirmingFor, setConfirmingFor] = useState<string | null>(null);

  const items = checkpoints.data?.items;
  const run = runQuery.data;
  const listed = checkpointId
    ? items?.find((i) => i.id === checkpointId)
    : undefined;
  // The run detail carries the same review fields; use them until the list
  // has loaded.
  const current:
    Pick<CheckpointItem, "state" | "decision" | "newerCapture"> | undefined =
    listed ??
    (checkpointId ? run?.checkpointContexts?.[checkpointId] : undefined);

  const state = current?.state ?? null;
  const decision = current?.decision ?? null;
  const newerCapture = current?.newerCapture ?? null;
  const statusOverride = run?.statusOverride ?? null;
  const overridden = statusOverride !== null;

  const effectiveStatus: RunStatus = status ?? run?.status ?? "running";
  const blocked =
    NOT_REVIEWABLE.has(effectiveStatus) ||
    (items?.some((i) => i.state === null) ?? false);
  // The selected step is not known (the `_first` placeholder, an id the run
  // does not have, a list still loading) or has no verdict yet: there is
  // nothing to act on, and it reads as still processing.
  const loading = current === undefined || state === null;

  const isDecided =
    decision !== null && (state === "approved" || state === "rejected");
  const view: ReviewView = isDecided
    ? "decided"
    : overridden
      ? "overridden"
      : blocked || loading
        ? "not-reviewable"
        : state === "passed"
          ? "machine-passed"
          : "pending";

  const canReview = !overridden && !blocked;
  const disabledReason = overridden
    ? describeRefusal("run_overridden")
    : blocked
      ? describeBlockedRun(effectiveStatus)
      : loading
        ? describeRefusal("not_reviewable")
        : null;
  const decisionLockedReason = overridden
    ? DECISIONS_LOCKED_BY_OVERRIDE
    : blocked
      ? describeBlockedRun(effectiveStatus)
      : null;
  const showRunMenu = overridden || !(blocked || loading);

  const stepInFlight = checkpointId ? isInFlight(checkpointId) : false;
  const actionable = canReview && current !== undefined && !stepInFlight;
  const canApprove = actionable && isPendingState(state);
  const canReject = actionable && (isPendingState(state) || state === "passed");

  const pendingSteps = (items ?? []).filter((i) =>
    isPendingState(i.state),
  ).length;
  const runInFlight = (items ?? []).some((i) => isInFlight(i.id));
  const canApprovePendingSteps = canReview && pendingSteps > 0 && !runInFlight;

  const invalidate = () => {
    void utils.runs.getById.invalidate({ runId });
    void utils.runs.listCheckpoints.invalidate({ runId });
  };
  // The run-level override is not a decision, so it is not optimistic and
  // not undoable: the refetch brings the header its new state.
  const overrideStatus = trpc.runs.overrideStatus.useMutation({
    onSuccess: () => invalidate(),
    onError: (e) => toast.error(e.message),
  });

  const pending = stepInFlight || overrideStatus.isPending;

  // The step's name, for the labels the toasts and the undo list show.
  const quoted = listed?.name ? `'${listed.name}'` : "this step";

  // ADR-036: when the reviewer has drawn/edited ignore regions but not
  // separately saved them, fold them into the approve call so approving
  // doesn't silently drop them. Read at call time (not render) so the latest
  // drawn regions are captured. Persisted onto the variation atomically
  // server-side — no diff re-enqueue.
  const pendingIgnoreAreas = () => {
    const s = useViewerStore.getState();
    return hasUnsavedIgnoreChanges(s)
      ? { ignoreAreas: buildIgnoreAreasPayload(s, "variation") }
      : {};
  };

  const approveNow = () => {
    if (!checkpointId) return;
    decide({
      runId,
      checkpointIds: [checkpointId],
      kind: "approved",
      label: `Approved ${quoted}`,
      ...pendingIgnoreAreas(),
    });
    onResolved?.();
  };

  const rejectNow = (label: string) => {
    if (!checkpointId) return;
    decide({
      runId,
      checkpointIds: [checkpointId],
      kind: "rejected",
      label,
    });
    onResolved?.();
  };

  const staleOpen = confirmingFor !== null && confirmingFor === checkpointId;

  return {
    status: effectiveStatus,
    view,
    decisionLockedReason,
    showRunMenu,
    canReview,
    disabledReason,
    pending,
    isApproving: pending && state === "approved",
    isRejecting: pending && state === "rejected",
    error: null,
    state,
    decision,
    newerCapture,
    statusOverride,
    pendingSteps,
    canApprove,
    canReject,
    canApprovePendingSteps,
    staleConfirm: {
      open: staleOpen,
      confirm: () => {
        setConfirmingFor(null);
        // The step may have changed under the dialog (another reviewer);
        // approve only what is still approvable.
        if (canApprove) approveNow();
      },
      cancel: () => setConfirmingFor(null),
    },
    approve: () => {
      if (!canApprove) return;
      // An older capture is approved only after the reviewer says so.
      if (newerCapture) {
        setConfirmingFor(checkpointId ?? null);
        return;
      }
      approveNow();
    },
    reject: () => {
      if (!canReject) return;
      rejectNow(`Rejected ${quoted}`);
    },
    // "Mark as bug" (reference TestStep top bar): reject the step AND
    // seed + open the comments tab so the reviewer logs why. It rejects this
    // step only, never the run's others.
    markAsBug: () => {
      if (!canReject) return;
      rejectNow(`Marked ${quoted} as a bug`);
      const store = useViewerStore.getState();
      store.setCommentPrefill("Marked as bug: ");
      store.setCommentPanelOpen(true);
    },
    approveAllCheckpoints: () => {
      if (!canApprovePendingSteps) return;
      decide({
        runId,
        kind: "approved",
        label: `Approved ${pendingSteps} step${plural(pendingSteps)}`,
      });
    },
    undo,
    override: (next: OverrideStatusInput) => {
      // Setting or clearing the override needs a run that is reviewable, or
      // one that is already overridden (to reset it).
      if ((blocked && !overridden) || pending) return;
      overrideStatus.mutate({ runId, status: next });
    },
  };
}
