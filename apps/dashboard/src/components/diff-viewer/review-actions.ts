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
import { deriveReviewHeader, type ReviewView } from "./review-header-state";
import { useViewerStore } from "./useViewerStore";

import { plural } from "@/lib/format";
import type { CheckpointItem } from "@/lib/review/optimistic";
import { describeOverrideError } from "@/lib/review/review-copy";
import { useReviewMutations } from "@/lib/review/use-review-mutations";
import { trpc } from "@/lib/trpc";

type Decision = NonNullable<CheckpointItem["decision"]>;
type NewerCapture = NonNullable<CheckpointItem["newerCapture"]>;

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
   * Called right after a step is approved or rejected, so the parent can
   * advance to the next pending step (fast triage loop). It fires when the
   * decision is made, not when the server answers: the screen has already
   * moved on, and a refusal arrives as a toast naming the step and puts it
   * back. Not fired from Mark as Bug (the reviewer stays to write the note),
   * approve-pending or override.
   */
  onResolved?: () => void;
}

export interface ReviewActions {
  /** Effective run status (`running` until the run has loaded). */
  status: RunStatus;
  /** Which header the selected step gets. */
  view: ReviewView;
  /** Why Mark as Bug / Reject / Approve are disabled, or null when they aren't. */
  disabledReason: string | null;
  /**
   * Why a decided step cannot be undone right now, because of the run
   * (overridden, or not reviewable); null when the run takes decisions.
   */
  decisionLockedReason: string | null;
  /** The More menu applies: the run is overridden or can take decisions. */
  showRunMenu: boolean;
  /** The selected step has a decision, or an override, in flight. */
  pending: boolean;
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
   * approves; `cancel` decides nothing. `opener` is the control to give focus
   * back to once it closes.
   */
  staleConfirm: {
    open: boolean;
    opener: HTMLElement | null;
    confirm: () => void;
    cancel: () => void;
  };
  /**
   * Approve the selected step (after a confirmation, for an older capture).
   * Folds any unsaved ignore-region edits into the call. `opener` is the
   * button that was used; a key press has none, and the element holding focus
   * is remembered instead.
   */
  approve: (opener?: HTMLElement) => void;
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

/**
 * The review actions on a run, as a thin hook: it reads the queries, hands
 * them to `deriveReviewHeader` (which decides what is shown and allowed), and
 * turns each action into the matching `useReviewMutations` call. The
 * ApprovalBar buttons and the DiffViewer keyboard shortcuts both call the
 * object this returns, so a keypress can never take a different path than the
 * matching button — same call, same gate, same payload, same auto-advance.
 *
 * Every action is a no-op unless the header derivation allows it, so the UI
 * never sends a decision that would be refused (spec §5.4).
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

  // The older-capture question: which step it is open for, and the control to
  // give focus back to.
  const [confirming, setConfirming] = useState<{
    checkpointId: string;
    opener: HTMLElement | null;
  } | null>(null);
  // It belongs to the step it was opened for; moving away closes it for good,
  // so coming back never re-opens it unprompted.
  if (confirming && confirming.checkpointId !== checkpointId) {
    setConfirming(null);
  }

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
  const effectiveStatus: RunStatus = status ?? run?.status ?? "running";

  const stepInFlight = checkpointId ? isInFlight(checkpointId) : false;
  const header = deriveReviewHeader({
    status: effectiveStatus,
    statusOverride,
    step: current && { state, hasDecision: decision !== null },
    stepStates: items?.map((i) => i.state),
    stepInFlight,
    runInFlight: (items ?? []).some((i) => isInFlight(i.id)),
  });

  const invalidate = () => {
    void utils.runs.getById.invalidate({ runId });
    void utils.runs.listCheckpoints.invalidate({ runId });
  };
  // The run-level override is not a decision, so it is not optimistic and
  // not undoable: the refetch brings the header its new state.
  const overrideStatus = trpc.runs.overrideStatus.useMutation({
    onSuccess: () => invalidate(),
    onError: (e) => toast.error(describeOverrideError(e)),
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

  const rejectStep = (label: string): boolean => {
    if (!checkpointId) return false;
    decide({ runId, checkpointIds: [checkpointId], kind: "rejected", label });
    return true;
  };

  return {
    status: effectiveStatus,
    view: header.view,
    disabledReason: header.disabledReason,
    decisionLockedReason: header.decisionLockedReason,
    showRunMenu: header.showRunMenu,
    pending,
    state,
    decision,
    newerCapture,
    statusOverride,
    pendingSteps: header.pendingSteps,
    canApprove: header.canApprove,
    canReject: header.canReject,
    canApprovePendingSteps: header.canApprovePendingSteps,
    staleConfirm: {
      open: confirming !== null,
      opener: confirming?.opener ?? null,
      confirm: () => {
        setConfirming(null);
        // The step may have changed under the dialog (another reviewer);
        // approve only what is still approvable.
        if (header.canApprove) approveNow();
      },
      cancel: () => setConfirming(null),
    },
    approve: (opener) => {
      if (!header.canApprove || !checkpointId) return;
      // An older capture is approved only after the reviewer says so.
      if (newerCapture) {
        const focused = document.activeElement;
        setConfirming({
          checkpointId,
          opener:
            opener ??
            (focused instanceof HTMLElement && focused !== document.body
              ? focused
              : null),
        });
        return;
      }
      approveNow();
    },
    reject: () => {
      if (!header.canReject) return;
      if (rejectStep(`Rejected ${quoted}`)) onResolved?.();
    },
    // "Mark as bug" (reference TestStep top bar): reject the step AND seed +
    // open the comments tab so the reviewer logs why. It rejects this step
    // only, never the run's others, and stays on it: the note is about the
    // step on screen. The comment is run-scoped, so it names the step.
    markAsBug: () => {
      if (!header.canReject) return;
      if (!rejectStep(`Marked ${quoted} as a bug`)) return;
      const store = useViewerStore.getState();
      store.setCommentPrefill(`Marked ${quoted} as a bug: `);
      store.setCommentPanelOpen(true);
    },
    approveAllCheckpoints: () => {
      if (!header.canApprovePendingSteps) return;
      const count = header.pendingSteps;
      decide({
        runId,
        kind: "approved",
        label: `Approved ${count} step${plural(count)}`,
      });
    },
    undo,
    override: (next: OverrideStatusInput) => {
      // Setting or clearing the override needs a run that is reviewable, or
      // one that is already overridden (to reset it).
      if (!header.canOverride || pending) return;
      overrideStatus.mutate({ runId, status: next });
    },
  };
}
