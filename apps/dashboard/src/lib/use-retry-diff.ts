"use client";

import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";

import type { ReviewError } from "@/lib/review/review-copy";
import { trpc } from "@/lib/trpc";

const RETRY_ERROR = "Couldn't retry the diff. Try again.";
const ALREADY_RETRIED = "This step is already being re-diffed.";

/**
 * The server found nothing to retry: the step's failure is already cleared,
 * because another reviewer retried it first (`runs.retryDiff` is
 * PRECONDITION_FAILED `step_not_failed`). What the retry was for has happened.
 */
function isStepNotFailed(err: ReviewError): boolean {
  return (
    err.data?.code === "PRECONDITION_FAILED" &&
    err.message === "step_not_failed"
  );
}

/**
 * The toast for a failed retry. The server's own message names internals, so
 * only the code is read; anything unrecognised gets one plain sentence.
 */
function describeRetryDiffError(err: ReviewError): string {
  switch (err.data?.code) {
    case "FORBIDDEN":
      return "You don't have permission to retry this diff.";
    case "NOT_FOUND":
      return "This run no longer exists.";
    default:
      return RETRY_ERROR;
  }
}

export interface RetryDiff {
  /**
   * Asks the server to diff the failed step again, and settles once the views
   * that show it have been read again. It says its own failures (a toast), so
   * it never rejects.
   */
  retry(checkpointId: string): Promise<void>;
  /** A retry of some step is out, or its result is still being read. */
  pending: boolean;
  /** The retry of this step is out, or its result is still being read. */
  isPending(checkpointId: string): boolean;
}

/**
 * Retry for a step of run `runId` whose diff failed for good (spec
 * 2026-10-23 §6, §10). On success the run's steps, the run and the run lists
 * are read again, so the step reads as being diffed. A retry another reviewer
 * made first is already handled: the same reads, and at most a quiet word.
 *
 * One retry at a time per step: a press while that step's is out does nothing,
 * and another step's retry is not held up by it (a viewer moves between steps
 * while one is out).
 */
export function useRetryDiff(runId: string): RetryDiff {
  const utils = trpc.useUtils();
  const { mutateAsync } = trpc.runs.retryDiff.useMutation();
  // The steps whose retry is out: the ref for the guard (read between
  // renders), the state for what the views show.
  const out = useRef(new Set<string>());
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(new Set());

  const retry = useCallback(
    async (checkpointId: string) => {
      if (out.current.has(checkpointId)) return;
      out.current.add(checkpointId);
      setPendingIds(new Set(out.current));
      try {
        try {
          await mutateAsync({ runId, checkpointId });
        } catch (error) {
          if (!isStepNotFailed(error as ReviewError)) {
            toast.error(describeRetryDiffError(error as ReviewError));
            return;
          }
          toast.info(ALREADY_RETRIED);
        }
        await Promise.all([
          utils.runs.listCheckpoints.invalidate({ runId }),
          utils.runs.getById.invalidate({ runId }),
          utils.runs.list.invalidate(),
        ]);
      } finally {
        out.current.delete(checkpointId);
        setPendingIds(new Set(out.current));
      }
    },
    [mutateAsync, runId, utils],
  );
  const isPending = useCallback(
    (checkpointId: string) => pendingIds.has(checkpointId),
    [pendingIds],
  );

  return { retry, pending: pendingIds.size > 0, isPending };
}
