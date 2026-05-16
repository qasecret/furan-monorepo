"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";

interface Props {
  runId: string;
}

/**
 * Run-action footer for the DiffViewer.
 *
 * Owns its own `runs.approve` / `runs.reject` mutation hooks. The keyboard
 * shortcuts in `<DiffViewer>` use a separate pair of hooks — they share
 * effective behavior via the global React Query cache because both mutation
 * hooks issue an invalidation against `runs.getById` after success.
 *
 * Query-cache invalidation strategy: we use a predicate that matches any
 * cached `runs.getById` entry. tRPC-react-query's exact queryKey shape
 * (`[["runs", "getById"], { input, type }]`) is treated as an implementation
 * detail; the predicate is resilient to minor encoder changes between tRPC
 * patch releases.
 */
export function ApprovalBar({ runId }: Props) {
  const utils = trpc.useUtils();
  const [error, setError] = useState<string | null>(null);

  const invalidate = () => {
    // Invalidate the canonical query for this run so SSE-driven and
    // mutation-driven cache refreshes converge to the same fresh data.
    void utils.runs.getById.invalidate({ runId });
  };

  const approve = trpc.runs.approve.useMutation({
    onMutate: () => setError(null),
    onSuccess: () => invalidate(),
    onError: (e) => setError(e.message),
  });
  const reject = trpc.runs.reject.useMutation({
    onMutate: () => setError(null),
    onSuccess: () => invalidate(),
    onError: (e) => setError(e.message),
  });

  const pending = approve.isPending || reject.isPending;

  return (
    <div
      className="flex items-center gap-2 p-3 border-t bg-background"
      data-testid="approval-bar"
    >
      <Button
        variant="default"
        onClick={() => approve.mutate({ runId })}
        disabled={pending}
        data-testid="approve-button"
      >
        {approve.isPending ? "Approving…" : "Approve"}
      </Button>
      <Button
        variant="destructive"
        onClick={() => reject.mutate({ runId })}
        disabled={pending}
        data-testid="reject-button"
      >
        {reject.isPending ? "Rejecting…" : "Reject"}
      </Button>
      <Button
        variant="secondary"
        disabled
        title="Comments arrive in Phase 3"
        data-testid="comment-button"
      >
        Comment
      </Button>
      {error && (
        <span
          className="text-sm text-red-600 ml-auto"
          role="alert"
          data-testid="approval-error"
        >
          {error}
        </span>
      )}
    </div>
  );
}
