"use client";

import { Bug } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { GroupApprovalCallout } from "./GroupApprovalCallout";
import type { ReviewActions } from "./review-actions";

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
import { cn } from "@/lib/cn";

interface Props {
  runId: string;
  /**
   * ADR-038: the currently-selected checkpoint id. Selects the primary
   * button ("Approve" this checkpoint vs the legacy single-run approve),
   * gates "Approve all checkpoints", and feeds the group-approval callout.
   * Must match the `checkpointId` the `actions` were created with.
   */
  checkpointId?: string;
  /**
   * The run's review actions from `useReviewActions`. The bar renders them;
   * it owns no mutations. The DiffViewer keyboard shortcuts call the same
   * object, so a keypress and a click always take the same path. Status,
   * the reviewable gate, and pending/error state all come from here.
   */
  actions: ReviewActions;
  /**
   * Diff regions for the current run; feeds the AggregateSeverityPill chip
   * rendered next to the status badge. Optional + defaults to an empty list
   * so callers that don't have the data yet (or runs with no regions) render
   * cleanly.
   */
  diffRegions?: { severity: string }[];
  /**
   * Render as a compact inline action cluster for the ContextualHeader's
   * right slot (the reference's single-row top bar) instead of the
   * standalone bordered bar. In inline mode the group-approval callout is
   * rendered separately by the parent (below the header) so it doesn't
   * cram the h-14 row.
   */
  inline?: boolean;
  /**
   * Whether to render the leading Status pill. Off in inline mode because
   * the ContextualHeader already shows the status. Defaults true so the
   * standalone bar (and existing tests) are unchanged.
   */
  showStatus?: boolean;
  /**
   * Total checkpoints in the run. "Approve all checkpoints" in the More menu
   * only shows when this is > 1 (on a single-step run it just duplicates the
   * primary Approve). Defaults 0.
   */
  checkpointCount?: number;
}

/**
 * Run-action bar for the DiffViewer: status pill, More menu (approve all /
 * bulk approve / force status), Mark as Bug, Reject, and the primary
 * Approve. Disabled controls explain why via tooltip (spec §3.5).
 */
export function ApprovalBar({
  runId,
  checkpointId,
  actions,
  diffRegions,
  inline = false,
  showStatus = true,
  checkpointCount = 0,
}: Props) {
  const [confirmBulk, setConfirmBulk] = useState(false);
  const {
    status: effectiveStatus,
    canReview,
    disabledReason,
    pending,
    error,
  } = actions;

  // In inline (header) mode there's no room for an inline error string, so
  // surface mutation failures as a toast instead. The standalone bar keeps
  // its inline error text below.
  useEffect(() => {
    if (inline && error) toast.error(error);
  }, [inline, error]);

  return (
    <TooltipProvider delayDuration={200}>
      <div
        className={cn(
          inline
            ? "flex items-center gap-2"
            : "flex flex-wrap items-center gap-3 border-t border-edge bg-canvas/95 px-4 py-2.5 backdrop-blur-sm",
        )}
        data-testid="approval-bar"
      >
        {showStatus && (
          <>
            <div
              className="flex items-center gap-2"
              data-testid="approval-bar-status"
            >
              <span className="text-2xs font-semibold uppercase tracking-wider text-fg-muted">
                Status
              </span>
              <RunStatusBadge status={effectiveStatus} />
              <AggregateSeverityPill regions={diffRegions ?? []} />
            </div>
            <span className="hidden h-5 w-px bg-edge md:block" />
          </>
        )}

        {/* Phase B: "same change in N checkpoints → Accept all" callout. In
            inline (header) mode the parent renders it below the header so it
            doesn't cram the single row; renders null when no group exists. */}
        {!inline && (
          <GroupApprovalCallout runId={runId} checkpointId={checkpointId} />
        )}

        <div className="flex flex-wrap items-center gap-2 md:ml-auto">
          {/* "More" is secondary; kept left of the primary cluster so Approve
              stays the rightmost green CTA (reference TestStep layout).
              Commenting lives in the sidebar's COMMENTS tab, so there's no
              separate Comment button here. */}
          {canReview && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="secondary"
                  disabled={pending}
                  data-testid="approval-more-menu"
                  aria-label="More actions"
                >
                  More ▾
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {checkpointId && checkpointCount > 1 && (
                  <DropdownMenuItem
                    data-testid="approve-all-checkpoints-button"
                    onSelect={actions.approveAllCheckpoints}
                  >
                    Approve all checkpoints
                  </DropdownMenuItem>
                )}
                {!checkpointId && (
                  <DropdownMenuItem
                    data-testid="approve-bulk-variation"
                    onSelect={() => setConfirmBulk(true)}
                  >
                    Approve all runs of this test
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  data-testid="override-set-passed"
                  onSelect={() => actions.override("passed")}
                >
                  Force passed
                </DropdownMenuItem>
                <DropdownMenuItem
                  data-testid="override-set-failed"
                  onSelect={() => actions.override("failed")}
                >
                  Force failed
                </DropdownMenuItem>
                <DropdownMenuItem
                  data-testid="override-set-default"
                  onSelect={() => actions.override("default")}
                >
                  Reset to computed
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {/* Mark as Bug (reference top bar): rejects this checkpoint and
              opens a pre-filled note explaining why. */}
          <DisabledAwareButton
            disabled={!canReview || pending}
            reason={disabledReason}
            testId="mark-as-bug-button"
            variant="secondary"
            onClick={actions.markAsBug}
            title="Reject this checkpoint and open a note explaining the bug."
          >
            <Bug className="mr-1.5 h-4 w-4" aria-hidden />
            Mark as Bug
          </DisabledAwareButton>

          <DisabledAwareButton
            disabled={!canReview || pending}
            reason={disabledReason}
            testId="reject-button"
            variant="destructive"
            onClick={actions.reject}
          >
            {actions.isRejecting ? "Rejecting…" : "Reject"}
          </DisabledAwareButton>

          {/* ADR-038: with a checkpointId the primary action approves this
              checkpoint; the legacy path keeps the single-run approve. */}
          {checkpointId ? (
            <DisabledAwareButton
              disabled={!canReview || pending}
              reason={disabledReason}
              testId="approve-checkpoint-button"
              variant="default"
              onClick={actions.approve}
              title="Promotes this checkpoint's candidate as the new baseline for its test variation."
            >
              {actions.isApproving ? "Approving…" : "Approve"}
            </DisabledAwareButton>
          ) : (
            <DisabledAwareButton
              disabled={!canReview || pending}
              reason={disabledReason}
              testId="approve-button"
              variant="default"
              onClick={actions.approve}
              title={
                effectiveStatus === "new"
                  ? "Sets this candidate as the first baseline. Ignore regions are persisted onto the variation for future runs."
                  : "Accepts this diff outcome. Ignore regions are persisted onto the variation for future runs."
              }
            >
              {actions.isApproving
                ? effectiveStatus === "new"
                  ? "Saving…"
                  : "Approving…"
                : effectiveStatus === "new"
                  ? "Save as baseline"
                  : "Approve"}
            </DisabledAwareButton>
          )}
        </div>

        {!inline && error && (
          <span
            className="text-sm text-destructive ml-auto"
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
            className="flex items-center gap-2 text-xs ml-auto rounded-md border border-edge bg-hover px-3 py-2 text-fg-secondary"
          >
            <span>
              Approve every reviewer-actionable run of this test variation? Each
              approved run becomes the variation's baseline for its branch.
            </span>
            <Button
              variant="default"
              className="h-7 px-2 text-xs"
              data-testid="approve-bulk-confirm-yes"
              disabled={actions.isBulkApproving}
              onClick={() => {
                actions.bulkApproveVariation();
                setConfirmBulk(false);
              }}
            >
              {actions.isBulkApproving ? "Approving…" : "Approve all"}
            </Button>
            <Button
              variant="secondary"
              className="h-7 px-2 text-xs"
              data-testid="approve-bulk-confirm-no"
              onClick={() => setConfirmBulk(false)}
              disabled={actions.isBulkApproving}
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
