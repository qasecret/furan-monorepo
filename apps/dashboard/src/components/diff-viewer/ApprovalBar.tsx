"use client";

import type { OverrideStatusInput, RunStatus } from "@furan/shared-types";
import { useState } from "react";
import { toast } from "sonner";

import { useViewerStore } from "./useViewerStore";

import { AggregateSeverityPill } from "@/components/aggregate-severity-pill";
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
   * ADR-038: the currently-selected checkpoint id. When present, the
   * "Approve this checkpoint" button calls `runs.approveCheckpoint`;
   * "Approve all checkpoints" always calls `runs.approveAllCheckpoints`.
   * When absent (legacy path), falls back to the old `runs.approve` single-run flow.
   */
  checkpointId?: string;
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
  /**
   * Diff regions for the current run; feeds the AggregateSeverityPill chip
   * rendered next to the status badge. Optional + defaults to an empty list
   * so callers that don't have the data yet (or runs with no regions) render
   * cleanly.
   */
  diffRegions?: { severity: string }[];
}

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
export function ApprovalBar({
  runId,
  checkpointId,
  status,
  diffRegions,
}: Props) {
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
  // ADR-038: per-checkpoint approval
  const approveCheckpoint = trpc.runs.approveCheckpoint.useMutation({
    onMutate: () => setError(null),
    onSuccess: () => {
      invalidate();
      toast.success("Checkpoint approved");
    },
    onError: (e) => setError(e.message),
  });
  // ADR-038: approve all checkpoints in the run
  const approveAllCheckpoints = trpc.runs.approveAllCheckpoints.useMutation({
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
  const [confirmBulk, setConfirmBulk] = useState(false);
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
          "new" | "passed" | "unresolved" | "failed"
        >
      ];

  const pending =
    approve.isPending ||
    approveCheckpoint.isPending ||
    approveAllCheckpoints.isPending ||
    reject.isPending ||
    override.isPending ||
    bulkApprove.isPending;

  const callOverride = (next: OverrideStatusInput) => {
    override.mutate({ runId, status: next });
  };

  return (
    <TooltipProvider delayDuration={200}>
      <div
        className="flex flex-wrap items-center gap-3 border-t border-zinc-200 bg-white/95 px-4 py-2.5 backdrop-blur-sm dark:border-zinc-800 dark:bg-zinc-950/95"
        data-testid="approval-bar"
      >
        <div
          className="flex items-center gap-2"
          data-testid="approval-bar-status"
        >
          <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
            Status
          </span>
          <RunStatusBadge status={effectiveStatus} />
          <AggregateSeverityPill regions={diffRegions ?? []} />
        </div>

        <span className="hidden h-5 w-px bg-zinc-200 dark:bg-zinc-800 md:block" />

        <div className="flex flex-wrap items-center gap-2 md:ml-auto">
          {/* ADR-038: when a checkpointId is present, the primary action is
              "Approve this checkpoint" and the secondary is "Approve all checkpoints".
              Legacy path (no checkpointId) keeps the old single-run approve. */}
          {checkpointId ? (
            <>
              <DisabledAwareButton
                disabled={!canReview || pending}
                reason={disabledReason}
                testId="approve-checkpoint-button"
                variant="default"
                onClick={() =>
                  approveCheckpoint.mutate({ runId, checkpointId })
                }
                title="Promotes this checkpoint's candidate as the new baseline for its test variation."
              >
                {approveCheckpoint.isPending
                  ? "Approving…"
                  : "Approve this checkpoint"}
              </DisabledAwareButton>
              {canReview ? (
                <DisabledAwareButton
                  disabled={!canReview || pending}
                  reason={disabledReason}
                  testId="approve-all-checkpoints-button"
                  variant="secondary"
                  onClick={() => approveAllCheckpoints.mutate({ runId })}
                  title="Promotes all checkpoints in this run as new baselines."
                >
                  {approveAllCheckpoints.isPending
                    ? "Approving all…"
                    : "Approve all checkpoints"}
                </DisabledAwareButton>
              ) : null}
            </>
          ) : (
            <>
              {/* Split-button pattern: primary action is single-run approve;
                  chevron exposes bulk-approve. Keeps the most common path one
                  click and pushes the riskier multi-row write behind a
                  confirmation step. */}
              <DisabledAwareButton
                disabled={!canReview || pending}
                reason={disabledReason}
                testId="approve-button"
                variant="default"
                onClick={() => approve.mutate({ runId })}
                title={
                  effectiveStatus === "new"
                    ? "Sets this candidate as the first baseline. Ignore regions are persisted onto the variation for future runs."
                    : "Accepts this diff outcome. Ignore regions are persisted onto the variation for future runs."
                }
              >
                {approve.isPending
                  ? effectiveStatus === "new"
                    ? "Saving…"
                    : "Approving…"
                  : effectiveStatus === "new"
                    ? "Save as baseline"
                    : "Approve"}
              </DisabledAwareButton>
              {canReview ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="default"
                      disabled={pending}
                      data-testid="approve-more-menu"
                      aria-label="More approve actions"
                      className="px-2"
                    >
                      ▾
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      data-testid="approve-bulk-variation"
                      onSelect={() => setConfirmBulk(true)}
                    >
                      Approve all runs of this test
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
            </>
          )}
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
            className="text-sm text-red-400 ml-auto"
            role="alert"
            data-testid="approval-error"
          >
            {error}
          </span>
        )}

        {confirmBulk && (
          <div
            role="alertdialog"
            data-testid="approve-bulk-confirm"
            className="flex items-center gap-2 text-xs ml-auto rounded-md border border-zinc-200 bg-zinc-100 px-3 py-2 text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300"
          >
            <span>
              Approve every reviewer-actionable run of this test variation? Each
              approved run becomes the variation's baseline for its branch.
            </span>
            <Button
              variant="default"
              className="h-7 px-2 text-xs"
              data-testid="approve-bulk-confirm-yes"
              disabled={bulkApprove.isPending}
              onClick={() => {
                bulkApprove.mutate({ runId });
                setConfirmBulk(false);
              }}
            >
              {bulkApprove.isPending ? "Approving…" : "Approve all"}
            </Button>
            <Button
              variant="secondary"
              className="h-7 px-2 text-xs"
              data-testid="approve-bulk-confirm-no"
              onClick={() => setConfirmBulk(false)}
              disabled={bulkApprove.isPending}
            >
              Cancel
            </Button>
          </div>
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
  title,
}: {
  disabled: boolean;
  reason: string | null;
  testId: string;
  variant: "default" | "secondary" | "destructive";
  onClick: () => void;
  children: React.ReactNode;
  title?: string;
}) {
  const button = (
    <Button
      variant={variant}
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      title={title}
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
