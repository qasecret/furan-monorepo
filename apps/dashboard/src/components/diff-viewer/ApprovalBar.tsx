"use client";

import type { OverrideStatusInput, RunStatus } from "@furan/shared-types";
import { useState } from "react";

import { useViewerStore } from "./useViewerStore";

import { RunStatusBadge } from "@/components/run-status-badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { trpc } from "@/lib/trpc";

interface Props {
  runId: string;
  /**
   * Current `test_runs.status`. Drives:
   * - The status pill rendered at the top of the bar.
   * - Whether approve/reject/override are enabled (legality matrix
   *   from spec §3.3 — only `passed | unresolved | failed` are
   *   reviewer-overridable; the rest get a disabled-tooltip explaining
   *   why and pointing the reviewer at the right next action).
   *
   * Optional with a sane fallback so callers that haven't migrated yet
   * (or that render the bar before `getById` resolves) don't break —
   * `running` is the safest default since it disables every control.
   */
  status?: RunStatus;
}

/**
 * Per spec §3.3: only terminal review states can be approved / rejected
 * / overridden. `running` is mid-flight; `new | aborted | empty` are
 * terminal system states where the right action is re-run / fix SDK
 * usage, not override.
 */
const REVIEW_LEGAL: ReadonlySet<RunStatus> = new Set<RunStatus>([
  "passed",
  "unresolved",
  "failed",
]);

const DISABLED_REASON: Record<
  Exclude<RunStatus, "passed" | "unresolved" | "failed">,
  string
> = {
  running: "Run is still in progress — wait for the diff to finish.",
  new: "First run for this test — there's no baseline to compare against yet.",
  aborted: "Run was aborted before completion — re-run the test instead.",
  empty: "Run recorded no checks — verify your SDK integration.",
};

/**
 * Run-action footer for the DiffViewer.
 *
 * Owns its own `runs.approve` / `runs.reject` / `runs.overrideStatus`
 * mutation hooks. The keyboard shortcuts in `<DiffViewer>` use a separate
 * pair of hooks — they share effective behavior via the global React
 * Query cache because both mutation hooks issue an invalidation against
 * `runs.getById` after success.
 *
 * Query-cache invalidation strategy: we use a predicate that matches any
 * cached `runs.getById` entry. tRPC-react-query's exact queryKey shape
 * (`[["runs", "getById"], { input, type }]`) is treated as an implementation
 * detail; the predicate is resilient to minor encoder changes between tRPC
 * patch releases.
 */
export function ApprovalBar({ runId, status }: Props) {
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
  const override = trpc.runs.overrideStatus.useMutation({
    onMutate: () => setError(null),
    onSuccess: () => invalidate(),
    onError: (e) => setError(e.message),
  });

  const effectiveStatus: RunStatus = status ?? "running";
  const canReview = REVIEW_LEGAL.has(effectiveStatus);
  const disabledReason = canReview
    ? null
    : DISABLED_REASON[
        effectiveStatus as Exclude<
          RunStatus,
          "passed" | "unresolved" | "failed"
        >
      ];

  const pending = approve.isPending || reject.isPending || override.isPending;

  const callOverride = (next: OverrideStatusInput) => {
    override.mutate({ runId, status: next });
  };

  return (
    <TooltipProvider delayDuration={200}>
      <div
        className="flex flex-wrap items-center gap-3 p-3 border-t bg-background"
        data-testid="approval-bar"
      >
        <div
          className="flex items-center gap-2"
          data-testid="approval-bar-status"
        >
          <span className="text-xs uppercase tracking-wide text-muted-foreground">
            Status
          </span>
          <RunStatusBadge status={effectiveStatus} />
        </div>

        <div className="flex items-center gap-2">
          <DisabledAwareButton
            disabled={!canReview || pending}
            reason={disabledReason}
            testId="approve-button"
            variant="default"
            onClick={() => approve.mutate({ runId })}
          >
            {approve.isPending ? "Approving…" : "Approve"}
          </DisabledAwareButton>
          <DisabledAwareButton
            disabled={!canReview || pending}
            reason={disabledReason}
            testId="reject-button"
            variant="destructive"
            onClick={() => reject.mutate({ runId })}
          >
            {reject.isPending ? "Rejecting…" : "Reject"}
          </DisabledAwareButton>

          {canReview ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="secondary"
                  disabled={pending}
                  data-testid="override-button"
                  aria-label="Override status"
                >
                  {override.isPending ? "Overriding…" : "Override ▾"}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  data-testid="override-set-passed"
                  onSelect={() => callOverride("passed")}
                >
                  Set Passed
                </DropdownMenuItem>
                <DropdownMenuItem
                  data-testid="override-set-failed"
                  onSelect={() => callOverride("failed")}
                >
                  Set Failed
                </DropdownMenuItem>
                <DropdownMenuItem
                  data-testid="override-set-default"
                  onSelect={() => callOverride("default")}
                >
                  Default (recompute)
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <DisabledAwareButton
              disabled
              reason={disabledReason}
              testId="override-button"
              variant="secondary"
              onClick={() => undefined}
            >
              Override ▾
            </DisabledAwareButton>
          )}
        </div>

        <Button
          variant="secondary"
          onClick={() =>
            useViewerStore
              .getState()
              .setCommentPanelOpen(!useViewerStore.getState().commentPanelOpen)
          }
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
    </TooltipProvider>
  );
}

/**
 * Button + Radix tooltip wrapper. Renders the tooltip only when the
 * button is disabled AND a reason is supplied — per spec §3.5 we want
 * reviewers to see *why* an action is unavailable rather than hide the
 * control. When enabled, the tooltip is suppressed to avoid noise.
 */
function DisabledAwareButton({
  disabled,
  reason,
  testId,
  variant,
  onClick,
  children,
}: {
  disabled: boolean;
  reason: string | null;
  testId: string;
  variant: "default" | "secondary" | "destructive";
  onClick: () => void;
  children: React.ReactNode;
}) {
  const button = (
    <Button
      variant={variant}
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
    >
      {children}
    </Button>
  );
  if (!disabled || !reason) return button;
  return (
    <Tooltip>
      {/* span wrapper: Radix tooltips don't fire on a disabled <button>
          because the browser swallows pointer events. */}
      <TooltipTrigger asChild>
        <span tabIndex={0} data-testid={`${testId}-disabled-wrapper`}>
          {button}
        </span>
      </TooltipTrigger>
      <TooltipContent sideOffset={4} data-testid={`${testId}-disabled-reason`}>
        {reason}
      </TooltipContent>
    </Tooltip>
  );
}
