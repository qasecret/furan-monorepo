"use client";

import type { RunStatusOverride } from "@furan/shared-types";
import { Bug } from "lucide-react";
import { useEffect, useId, useRef } from "react";

import { DecisionChip } from "./DecisionChip";
import { GroupApprovalCallout } from "./GroupApprovalCallout";
import type { ReviewActions } from "./review-actions";
import { StaleStepConfirm } from "./StaleStepCallout";

import { AggregateSeverityPill } from "@/components/aggregate-severity-pill";
import { RunStatusBadge } from "@/components/run-status-badge";
import { Button } from "@/components/ui/button";
import { DisabledAwareButton } from "@/components/ui/disabled-aware-button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { useCommandKeys } from "@/lib/commands/registry";
import { statusStyle } from "@/lib/status-style";

interface Props {
  runId: string;
  /**
   * ADR-038: the currently-selected checkpoint id. Feeds the group-approval
   * callout. Must match the `checkpointId` the `actions` were created with.
   */
  checkpointId?: string;
  /**
   * The run's review actions from `useReviewActions`. The bar renders them;
   * it owns no mutations. The DiffViewer keyboard shortcuts call the same
   * object, so a keypress and a click always take the same path. The step's
   * state, the reviewable gate, and pending state all come from here.
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
   * The viewer may decide (the server's answer for the request's role,
   * R14). False: a read-only bar. The step's state, its decision and the
   * override still show; no button decides, undoes or overrides.
   */
  canReview: boolean;
}

/**
 * Review bar for the DiffViewer. What it shows follows the selected step
 * (spec §6.2): Mark as Bug / Reject / Approve while the step needs a
 * reviewer, the decision chip with Undo once it is decided, "Matches
 * baseline" for a step the machine passed, and the override chip with Reset
 * when the run's status was set by hand. The More menu carries the run-wide
 * actions. Disabled controls explain why via tooltip (spec §3.5).
 */
export function ApprovalBar({
  runId,
  checkpointId,
  actions,
  diffRegions,
  inline = false,
  showStatus = true,
  canReview,
}: Props) {
  const {
    status: effectiveStatus,
    view,
    state,
    decision,
    statusOverride,
    decisionLockedReason,
    showRunMenu,
    disabledReason,
    pending,
    canApprove,
    canReject,
    staleConfirm,
    newerCapture,
  } = actions;

  // Focus goes back to the control that opened the older-capture question
  // once it closes: the Approve button, or whatever held focus when the `a`
  // key opened it. The dialog is driven by state, so Radix has no trigger to
  // return it to; the opener is remembered here while it is open.
  const { open: confirmOpen, opener } = staleConfirm;
  const returnFocusTo = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (confirmOpen) {
      returnFocusTo.current = opener;
      return;
    }
    const target = returnFocusTo.current;
    returnFocusTo.current = null;
    if (target?.isConnected) target.focus();
  }, [confirmOpen, opener]);

  // The three step actions are the pending view's; a run that cannot take
  // them (override, still processing) shows them disabled, with the reason.
  const showStepActions =
    canReview &&
    (view === "pending" || view === "overridden" || view === "not-reviewable");

  // The keys that do what Approve and Reject do, from the registry: none for
  // a role that cannot review, or while single-key shortcuts are off.
  const approveKeys = useCommandKeys("review.approve");
  const rejectKeys = useCommandKeys("review.reject");

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
        {!inline && canReview && (
          <GroupApprovalCallout runId={runId} checkpointId={checkpointId} />
        )}

        <div className="flex flex-wrap items-center gap-2 md:ml-auto">
          {/* "More" is secondary; kept left of the primary cluster so Approve
              stays the rightmost CTA (reference TestStep layout). Commenting
              lives in the sidebar's COMMENTS tab, so there's no separate
              Comment button here. */}
          {canReview && showRunMenu && <MoreMenu actions={actions} />}

          {/* The override cluster shows with whatever the step shows: a
              decided step keeps its chip beside it. */}
          {statusOverride && (
            <>
              <OverrideChip override={statusOverride} />
              {canReview && (
                <Button
                  variant="secondary"
                  disabled={pending}
                  data-testid="reset-override"
                  onClick={() => actions.override("default")}
                >
                  Reset to computed
                </Button>
              )}
            </>
          )}

          {view === "decided" && decision && (
            <DecisionChip
              decision={decision}
              busy={pending}
              onUndo={
                canReview && decision.undo.allowed && !decisionLockedReason
                  ? () => actions.undo(decision.actionId)
                  : undefined
              }
              // Read-only, there is no Undo to explain the absence of.
              unavailable={
                canReview ? (decisionLockedReason ?? undefined) : undefined
              }
            />
          )}

          {view === "machine-passed" && (
            <span
              className="text-sm text-fg-muted"
              data-testid="matches-baseline"
            >
              Matches baseline
            </span>
          )}

          {showStepActions && (
            <>
              {/* Mark as Bug (reference top bar): rejects this step and
                  opens a pre-filled note explaining why. */}
              <DisabledAwareButton
                disabled={!canReject}
                reason={disabledReason}
                testId="mark-as-bug-button"
                variant="secondary"
                onClick={actions.markAsBug}
                title="Reject this step and open a note explaining the bug."
              >
                <Bug className="mr-1.5 h-4 w-4" aria-hidden />
                Mark as Bug
              </DisabledAwareButton>

              <DisabledAwareButton
                disabled={!canReject}
                reason={disabledReason}
                testId="reject-button"
                variant="destructive"
                onClick={actions.reject}
                ariaKeyShortcuts={rejectKeys.ariaKeyShortcuts}
                title={
                  rejectKeys.titleSuffix
                    ? `Reject${rejectKeys.titleSuffix}`
                    : undefined
                }
              >
                Reject
              </DisabledAwareButton>

              <DisabledAwareButton
                disabled={!canApprove}
                reason={disabledReason}
                testId="approve-checkpoint-button"
                variant="default"
                // The older-capture question, if it opens, hands focus back to
                // this button when it closes.
                onClick={(e) => actions.approve(e.currentTarget)}
                ariaKeyShortcuts={approveKeys.ariaKeyShortcuts}
                title={`${
                  state === "new"
                    ? "Sets this candidate as the first baseline. Ignore regions are persisted onto the variation for future runs."
                    : "Promotes this step's candidate as the new baseline for its test variation."
                }${approveKeys.titleSuffix}`}
              >
                {state === "new" ? "Save as baseline" : "Approve"}
              </DisabledAwareButton>
            </>
          )}
        </div>

        <StaleStepConfirm
          buildName={newerCapture?.buildName ?? ""}
          open={staleConfirm.open}
          onCancel={staleConfirm.cancel}
          onConfirm={staleConfirm.confirm}
        />
      </div>
    </TooltipProvider>
  );
}

/** "Run overridden to Failed": the run's status was set by hand. */
function OverrideChip({ override }: { override: RunStatusOverride }) {
  const style = statusStyle(override);
  const Icon = style.icon;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium",
        style.pill,
      )}
      data-testid="override-chip"
    >
      <Icon className="h-3 w-3" aria-hidden />
      Run overridden to {style.label}
    </span>
  );
}

/**
 * Run-wide actions: approve every pending step, reject a step the machine
 * passed, and set the run's status by hand. The override does not touch step
 * decisions, and the menu says so.
 */
function MoreMenu({ actions }: { actions: ReviewActions }) {
  const { view, pending, pendingSteps, statusOverride } = actions;
  // The line that says what the override does, read out with each override item.
  const explainerId = useId();
  return (
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
        {view === "machine-passed" && (
          <DropdownMenuItem
            data-testid="reject-anyway"
            disabled={!actions.canReject}
            onSelect={actions.reject}
          >
            Reject anyway
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          data-testid="approve-pending-steps"
          disabled={!actions.canApprovePendingSteps}
          onSelect={actions.approveAllCheckpoints}
        >
          Approve pending steps ({pendingSteps})
        </DropdownMenuItem>
        {/* Only where the server accepts an override (not on a `new` run). */}
        {actions.canOverride && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Run status</DropdownMenuLabel>
            <p
              id={explainerId}
              className="px-2 pb-1.5 text-xs text-fg-muted"
              data-testid="override-explainer"
            >
              Sets the run's status directly. Step decisions are kept.
            </p>
            <DropdownMenuItem
              data-testid="override-set-passed"
              aria-describedby={explainerId}
              onSelect={() => actions.override("passed")}
            >
              Force passed (run override)
            </DropdownMenuItem>
            <DropdownMenuItem
              data-testid="override-set-failed"
              aria-describedby={explainerId}
              onSelect={() => actions.override("failed")}
            >
              Force failed (run override)
            </DropdownMenuItem>
            {statusOverride !== null && (
              <DropdownMenuItem
                data-testid="override-set-default"
                aria-describedby={explainerId}
                onSelect={() => actions.override("default")}
              >
                Reset to computed
              </DropdownMenuItem>
            )}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
