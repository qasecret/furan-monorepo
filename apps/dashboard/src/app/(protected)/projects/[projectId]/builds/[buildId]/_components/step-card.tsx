"use client";

import {
  isPending,
  type CheckpointReviewState,
  type RunStatus,
  type RunStatusOverride,
} from "@furan/shared-types";
import { Maximize2, Star, ThumbsDown, ThumbsUp, Undo2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { memo, useEffect, useRef } from "react";

import { deriveReviewHeader } from "@/components/diff-viewer/review-header-state";
import { DisabledAwareButton } from "@/components/ui/disabled-aware-button";
import { useAuthedImage } from "@/hooks/use-authed-image";
import { cn } from "@/lib/cn";
import type { CheckpointItem } from "@/lib/review/optimistic";
import {
  useIsInFlight,
  type DecideArgs,
} from "@/lib/review/use-review-mutations";
import {
  reviewStateStyle,
  statusStyle,
  type StatusStyle,
} from "@/lib/status-style";

export interface StepCheckpoint {
  id: string;
  name: string;
  /** The step's review state; null until it has been diffed. */
  state: CheckpointReviewState | null;
  /** The active decision on the step, or null. */
  decision: CheckpointItem["decision"];
  imageKey: string | null;
}

/**
 * What the card needs to know about its run to tell whether the run takes
 * decisions: the same facts the viewer header reads (spec §5.4). It holds
 * nothing that changes with every decision (not the list of steps), so the
 * run list can keep one object while its cards are decided one by one, and the
 * other cards are not redrawn.
 */
export interface StepRun {
  /** The run's status as its steps roll up. */
  status: RunStatus;
  /** The run's hand-set status, or null when it is computed. */
  statusOverride: RunStatusOverride | null;
  /** Some step of the run has no verdict yet, so the run is not reviewable. */
  undiffed: boolean;
}

interface Props {
  projectId: string;
  runId: string;
  /** Guests never see review actions. */
  canReview: boolean;
  checkpoint: StepCheckpoint;
  index: number;
  total: number;
  run: StepRun;
  /**
   * The review calls, from the run list's one `useReviewMutations()`. A card
   * does not make its own: that hook subscribes to every checkpoint in flight,
   * which would redraw every card on every decision. They must be stable.
   */
  decide: (args: DecideArgs) => void;
  undo: (actionId?: string) => void;
}

/**
 * How a step reads. One with a review state takes that state's style. One
 * without has not been diffed: it reads as running, unless the run ended
 * without ever diffing it (aborted, empty), and then as that.
 */
function lookOf(
  state: CheckpointReviewState | null,
  runStatus: RunStatus,
): { style: StatusStyle; running: boolean } {
  if (state !== null) return { style: reviewStateStyle(state), running: false };
  const ended = runStatus === "aborted" || runStatus === "empty";
  return {
    style: statusStyle(ended ? runStatus : "running"),
    running: !ended,
  };
}

/**
 * A single checkpoint rendered as the reference's "test step" card — left
 * accent, the screenshot thumbnail (loaded via the authed storage proxy), a
 * hover action toolbar (approve, reject, undo, open), and an "n/total name"
 * label led by the review-state icon. The card opens the checkpoint in the
 * diff viewer.
 *
 * A step that needs a reviewer offers Approve and Reject; a decided one
 * offers Undo while the server says it can be taken back. They are the
 * viewer header's decisions, through the same hook, and are held back by the
 * same rules: a run that is overridden or not reviewable, or a decision still
 * on its way. It is memoized: it redraws for its own step, its run's state or
 * its own in-flight state, not for its siblings'.
 */
export const StepCard = memo(function StepCard({
  projectId,
  runId,
  canReview,
  checkpoint,
  index,
  total,
  run,
  decide,
  undo,
}: Props) {
  const router = useRouter();
  const inFlight = useIsInFlight(checkpoint.id);
  const thumb = useAuthedImage(checkpoint.imageKey);
  const { id, name, state, decision } = checkpoint;
  const { style, running } = lookOf(state, run.status);
  const StatusIcon = style.icon;

  const header = deriveReviewHeader({
    status: run.status,
    statusOverride: run.statusOverride,
    step: { state, hasDecision: decision !== null },
    // Only whether some step has no verdict reaches the derivation.
    stepStates: run.undiffed ? [null] : [],
    stepInFlight: inFlight,
    runInFlight: false,
  });
  const needsReviewer = state !== null && isPending(state);
  const canUndo = decision?.undo.allowed === true;
  const undoLocked = header.decisionLockedReason !== null || inFlight;

  const open = () =>
    router.push(`/projects/${projectId}/runs/${runId}/checkpoints/${id}`);

  // The button a keyboard user pressed is about to be replaced (by Undo), and
  // focus would drop to the page. So when the card held focus at the time, it
  // follows the decision: to Undo, or failing that to opening the step. It
  // moves once the call has answered, since Undo cannot take focus before.
  // It only moves focus that is still lost (on the page) or on this card: a
  // user who has tabbed or clicked elsewhere meanwhile keeps their place.
  const toolbar = useRef<HTMLDivElement>(null);
  const undoButton = useRef<HTMLButtonElement>(null);
  const openButton = useRef<HTMLButtonElement>(null);
  const followFocus = useRef(false);
  useEffect(() => {
    if (!followFocus.current || inFlight) return;
    followFocus.current = false;
    const active = document.activeElement;
    const lost = active === null || active === document.body;
    if (!lost && toolbar.current?.contains(active) !== true) return;
    (decision !== null && canUndo ? undoButton : openButton).current?.focus();
  }, [inFlight, decision, canUndo]);

  const decideStep = (kind: "approved" | "rejected") => {
    followFocus.current =
      toolbar.current?.contains(document.activeElement) === true;
    decide({
      runId,
      checkpointIds: [id],
      kind,
      label: `${kind === "approved" ? "Approved" : "Rejected"} '${name}'`,
    });
  };

  // The icon buttons share one look; only the hover hue says which is which.
  // One that is unavailable (`aria-disabled`) does not react to hover: it
  // keeps its resting colours.
  const actionClass =
    "rounded p-1.5 text-fg-muted transition-colors hover:bg-edge aria-disabled:hover:bg-transparent aria-disabled:hover:text-fg-muted";

  return (
    <div
      data-testid={`step-card-${id}`}
      className="group relative w-[320px] shrink-0"
    >
      <div className="relative overflow-hidden rounded-lg border border-edge bg-raised transition-colors group-hover:border-brand/40">
        <span
          aria-hidden
          data-testid={`step-accent-${id}`}
          className={cn("absolute inset-y-0 left-0 z-10 w-1", style.dot)}
        />
        <button
          type="button"
          aria-label={`Open ${name}`}
          onClick={open}
          className="block aspect-video w-full cursor-pointer overflow-hidden bg-muted"
        >
          {thumb ? (
            <img
              src={thumb}
              alt=""
              className="h-full w-full object-cover object-top"
            />
          ) : (
            <div className="h-full w-full bg-[repeating-linear-gradient(45deg,var(--edge),var(--edge)_4px,transparent_4px,transparent_8px)]" />
          )}
        </button>
        <div
          ref={toolbar}
          data-testid={`step-toolbar-${id}`}
          className="flex items-center justify-between border-t border-edge bg-sunken px-2 py-1.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
        >
          <div className="flex items-center gap-1">
            {canReview && needsReviewer && (
              <>
                <DisabledAwareButton
                  variant="ghost"
                  label={`Approve ${name}`}
                  testId={`step-approve-${id}`}
                  disabled={!header.canApprove}
                  reason={header.disabledReason}
                  onClick={(e) => {
                    e.stopPropagation();
                    decideStep("approved");
                  }}
                  className={cn(actionClass, "hover:text-status-passed-text")}
                >
                  <ThumbsUp className="h-4 w-4" aria-hidden />
                </DisabledAwareButton>
                <DisabledAwareButton
                  variant="ghost"
                  label={`Reject ${name}`}
                  testId={`step-reject-${id}`}
                  disabled={!header.canReject}
                  reason={header.disabledReason}
                  onClick={(e) => {
                    e.stopPropagation();
                    decideStep("rejected");
                  }}
                  className={cn(actionClass, "hover:text-status-failed-text")}
                >
                  <ThumbsDown className="h-4 w-4" aria-hidden />
                </DisabledAwareButton>
              </>
            )}
            {canReview && decision !== null && canUndo && (
              <DisabledAwareButton
                ref={undoButton}
                variant="ghost"
                label={`Undo ${decision.kind === "approved" ? "approval" : "rejection"} of ${name}`}
                testId={`step-undo-${id}`}
                disabled={undoLocked}
                reason={header.decisionLockedReason}
                onClick={(e) => {
                  e.stopPropagation();
                  undo(decision.actionId);
                }}
                className={cn(actionClass, "hover:text-fg")}
              >
                <Undo2 className="h-4 w-4" aria-hidden />
              </DisabledAwareButton>
            )}
          </div>
          <button
            ref={openButton}
            type="button"
            aria-label={`Open ${name} in the viewer`}
            onClick={(e) => {
              e.stopPropagation();
              open();
            }}
            className="rounded p-1.5 text-fg-muted transition-colors hover:bg-edge hover:text-fg focus-ring"
          >
            <Maximize2 className="h-4 w-4" aria-hidden />
          </button>
        </div>
      </div>
      <div className="mt-2 flex items-center gap-2 px-0.5 text-sm">
        {/* The accent bar alone can't tell aborted from unresolved (near-
            identical yellows), nor a reviewer's decision from the machine's
            verdict, so the state icon names it too. */}
        <span
          title={style.tooltip}
          data-testid={`step-status-${id}`}
          className="inline-flex shrink-0"
        >
          <StatusIcon
            className={cn(
              "h-4 w-4",
              style.text,
              running && "motion-safe:animate-spin",
            )}
            aria-hidden
          />
          <span className="sr-only">{style.label}</span>
        </span>
        <Star className="h-4 w-4 shrink-0 text-edge-strong" aria-hidden />
        <span className="min-w-0 flex-1 truncate tabular-nums text-fg-secondary">
          {index + 1}/{total} {name}
        </span>
      </div>
    </div>
  );
});
