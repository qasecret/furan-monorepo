"use client";

import type { OverrideStatusInput, RunStatus } from "@furan/shared-types";
import { useState } from "react";
import { toast } from "sonner";

import {
  buildIgnoreAreasPayload,
  hasUnsavedIgnoreChanges,
} from "./ignore-area-payload";
import { useViewerStore } from "./useViewerStore";

import { trpc } from "@/lib/trpc";

// ADR-036/037: `new` (no prior baseline) is a legal first-baseline path —
// approve promotes the candidate to baseline and persists ignoreAreas.
// `passed | unresolved | failed` are the post-diff review states.
// `running | aborted | empty` are non-reviewable system states.
const REVIEW_LEGAL: ReadonlySet<RunStatus> = new Set<RunStatus>([
  "new",
  "passed",
  "unresolved",
  "failed",
]);

const DISABLED_REASON: Record<
  Exclude<RunStatus, "new" | "passed" | "unresolved" | "failed">,
  string
> = {
  running: "Run is still in progress — wait for the diff to finish.",
  aborted: "Run was aborted before completion — re-run the test instead.",
  empty: "Run recorded no checks — verify your SDK integration.",
};

export interface UseReviewActionsArgs {
  runId: string;
  /**
   * ADR-038: the currently-selected checkpoint id. When present, `approve`
   * calls `runs.approveCheckpoint`; when absent (legacy path) it falls back
   * to the single-run `runs.approve`.
   */
  checkpointId?: string;
  /**
   * Current `test_runs.status`. Only `new | passed | unresolved | failed`
   * are reviewable (spec §3.3). Defaults to `running` — the safest value,
   * since it disables every action — so callers that render before
   * `getById` resolves don't break.
   */
  status?: RunStatus;
  /**
   * Called after a successful checkpoint approve/reject so the parent can
   * advance to the next unresolved checkpoint (fast triage loop). Not fired
   * from approve-all, bulk-approve, or override.
   */
  onResolved?: () => void;
}

export interface ReviewActions {
  /** Effective run status (`running` until the run has loaded). */
  status: RunStatus;
  canReview: boolean;
  /** Why the actions are unavailable, or null when they're available. */
  disabledReason: string | null;
  /** Any review mutation in flight. */
  pending: boolean;
  isApproving: boolean;
  isRejecting: boolean;
  isBulkApproving: boolean;
  /** Last mutation error message, cleared when the next one starts. */
  error: string | null;
  /**
   * Primary approve: this checkpoint when `checkpointId` is set, otherwise
   * the whole run. Folds any unsaved ignore-region edits into the call.
   */
  approve: () => void;
  reject: () => void;
  /** Reject, then open the comment panel pre-filled for a bug note. */
  markAsBug: () => void;
  approveAllCheckpoints: () => void;
  bulkApproveVariation: () => void;
  override: (next: OverrideStatusInput) => void;
}

/**
 * The single source of truth for the review actions on a run. The
 * ApprovalBar buttons and the DiffViewer keyboard shortcuts both call the
 * object this returns, so a keypress can never take a different path than
 * the matching button — same mutation, same status gate, same payload,
 * same toast and auto-advance.
 *
 * Every action is a no-op unless the run is reviewable and no review
 * mutation is in flight (the same condition that disables the buttons).
 *
 * Query-cache invalidation: success refreshes `runs.getById` and
 * `runs.listCheckpoints` for this run so mutation- and SSE-driven
 * refreshes converge on the same data.
 */
export function useReviewActions({
  runId,
  checkpointId,
  status,
  onResolved,
}: UseReviewActionsArgs): ReviewActions {
  const utils = trpc.useUtils();
  const [error, setError] = useState<string | null>(null);

  const invalidate = () => {
    void utils.runs.getById.invalidate({ runId });
    // Refresh the checkpoint rail so per-checkpoint status reflects the
    // outcome without a page reload.
    void utils.runs.listCheckpoints.invalidate({ runId });
  };

  const approveRun = trpc.runs.approve.useMutation({
    onMutate: () => setError(null),
    onSuccess: () => invalidate(),
    onError: (e) => setError(e.message),
  });
  // ADR-038: per-checkpoint approval
  const approveCheckpoint = trpc.runs.approveCheckpoint.useMutation({
    onMutate: () => setError(null),
    onSuccess: () => {
      invalidate();
      toast.success("Checkpoint approved");
      onResolved?.();
    },
    onError: (e) => setError(e.message),
  });
  // ADR-038: approve all checkpoints in the run
  const approveAll = trpc.runs.approveAllCheckpoints.useMutation({
    onMutate: () => setError(null),
    onSuccess: (res) => {
      invalidate();
      toast.success(
        `Approved ${res.approved} checkpoint${res.approved === 1 ? "" : "s"}`,
      );
    },
    onError: (e) => setError(e.message),
  });
  const bulkApprove = trpc.runs.bulkApproveByVariation.useMutation({
    onMutate: () => setError(null),
    onSuccess: (res) => {
      invalidate();
      toast.success(
        `Approved ${res.approved} run${res.approved === 1 ? "" : "s"} of this test${
          res.capped ? ` (capped at ${res.cap} — run again for more)` : ""
        }`,
      );
    },
    onError: (e) => setError(e.message),
  });
  const rejectRun = trpc.runs.reject.useMutation({
    onMutate: () => setError(null),
    onSuccess: () => {
      invalidate();
      onResolved?.();
    },
    onError: (e) => setError(e.message),
  });
  const overrideStatus = trpc.runs.overrideStatus.useMutation({
    onMutate: () => setError(null),
    onSuccess: () => invalidate(),
    onError: (e) => setError(e.message),
  });

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

  const effectiveStatus: RunStatus = status ?? "running";
  const canReview = REVIEW_LEGAL.has(effectiveStatus);
  const disabledReason = canReview
    ? null
    : DISABLED_REASON[
        effectiveStatus as Exclude<
          RunStatus,
          "new" | "passed" | "unresolved" | "failed"
        >
      ];

  const pending =
    approveRun.isPending ||
    approveCheckpoint.isPending ||
    approveAll.isPending ||
    rejectRun.isPending ||
    overrideStatus.isPending ||
    bulkApprove.isPending;

  const whenReviewable =
    <A extends unknown[]>(fn: (...args: A) => void) =>
    (...args: A) => {
      if (!canReview || pending) return;
      fn(...args);
    };

  return {
    status: effectiveStatus,
    canReview,
    disabledReason,
    pending,
    isApproving: approveRun.isPending || approveCheckpoint.isPending,
    isRejecting: rejectRun.isPending,
    isBulkApproving: bulkApprove.isPending,
    error,
    approve: whenReviewable(() => {
      if (checkpointId) {
        approveCheckpoint.mutate({
          runId,
          checkpointId,
          ...pendingIgnoreAreas(),
        });
      } else {
        approveRun.mutate({ runId, ...pendingIgnoreAreas() });
      }
    }),
    reject: whenReviewable(() => rejectRun.mutate({ runId })),
    // "Mark as bug" (reference TestStep top bar): reject the checkpoint AND
    // seed + open the comments tab so the reviewer logs why.
    markAsBug: whenReviewable(() => {
      rejectRun.mutate({ runId });
      const store = useViewerStore.getState();
      store.setCommentPrefill("Marked as bug: ");
      store.setCommentPanelOpen(true);
    }),
    approveAllCheckpoints: whenReviewable(() => approveAll.mutate({ runId })),
    bulkApproveVariation: whenReviewable(() => bulkApprove.mutate({ runId })),
    override: whenReviewable((next: OverrideStatusInput) =>
      overrideStatus.mutate({ runId, status: next }),
    ),
  };
}
