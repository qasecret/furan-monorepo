"use client";

import type { RunStatusOverride } from "@furan/shared-types";
import { Bug } from "lucide-react";
import { useEffect, useRef, type MouseEvent, type ReactNode } from "react";

import { DecisionChip } from "./DecisionChip";
import { GroupApprovalCallout } from "./GroupApprovalCallout";
import type { ReviewActions } from "./review-actions";
import { StaleStepConfirm } from "./StaleStepCallout";

import { AggregateSeverityPill } from "@/components/aggregate-severity-pill";
import { RunStatusBadge } from "@/components/run-status-badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
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
}: Props) {
  const {
    status: effectiveStatus,
    view,
    state,
    decision,
    statusOverride,
    disabledReason,
    pending,
    canApprove,
    canReject,
    staleConfirm,
    newerCapture,
  } = actions;

  // Where focus goes back to when the older-capture question closes. The
  // dialog is driven by state, so Radix has no trigger to return it to.
  const approveTrigger = useRef<HTMLElement | null>(null);
  const confirmOpen = staleConfirm.open;
  useEffect(() => {
    if (confirmOpen) return;
    approveTrigger.current?.focus();
    approveTrigger.current = null;
  }, [confirmOpen]);

  // The three step actions are the pending view's; a run that cannot take
  // them (override, still processing) shows them disabled, with the reason.
  const showStepActions =
    view === "pending" || view === "overridden" || view === "not-reviewable";

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
              stays the rightmost CTA (reference TestStep layout). Commenting
              lives in the sidebar's COMMENTS tab, so there's no separate
              Comment button here. */}
          {view !== "not-reviewable" && <MoreMenu actions={actions} />}

          {view === "overridden" && statusOverride && (
            <>
              <OverrideChip override={statusOverride} />
              <Button
                variant="secondary"
                disabled={pending}
                data-testid="reset-override"
                onClick={() => actions.override("default")}
              >
                Reset to computed
              </Button>
            </>
          )}

          {view === "decided" && decision && (
            <DecisionChip
              decision={decision}
              busy={pending}
              onUndo={
                decision.undo.allowed
                  ? () => actions.undo(decision.actionId)
                  : undefined
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
              >
                Reject
              </DisabledAwareButton>

              <DisabledAwareButton
                disabled={!canApprove}
                reason={disabledReason}
                testId="approve-checkpoint-button"
                variant="default"
                onClick={(e) => {
                  // The older-capture question, if it opens, hands focus back
                  // here when it closes.
                  approveTrigger.current = e.currentTarget;
                  actions.approve();
                }}
                title={
                  state === "new"
                    ? "Sets this candidate as the first baseline. Ignore regions are persisted onto the variation for future runs."
                    : "Promotes this step's candidate as the new baseline for its test variation."
                }
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
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Run status</DropdownMenuLabel>
        <p
          className="px-2 pb-1.5 text-xs text-fg-muted"
          data-testid="override-explainer"
        >
          Sets the run's status directly. Step decisions are kept.
        </p>
        <DropdownMenuItem
          data-testid="override-set-passed"
          onSelect={() => actions.override("passed")}
        >
          Force passed (run override)
        </DropdownMenuItem>
        <DropdownMenuItem
          data-testid="override-set-failed"
          onSelect={() => actions.override("failed")}
        >
          Force failed (run override)
        </DropdownMenuItem>
        {statusOverride !== null && (
          <DropdownMenuItem
            data-testid="override-set-default"
            onSelect={() => actions.override("default")}
          >
            Reset to computed
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
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
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  children: ReactNode;
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
