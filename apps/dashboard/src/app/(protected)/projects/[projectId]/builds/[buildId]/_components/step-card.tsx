"use client";

import {
  isPending,
  type CheckpointReviewState,
  type RunStatus,
  type RunStatusOverride,
} from "@furan/shared-types";
import { Maximize2, Star, ThumbsDown, ThumbsUp, Undo2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { memo, useEffect, useRef, useState } from "react";

import { stepItemId, useCursorItem } from "./batch-cursor-context";
import { useRegisterStepActions } from "./step-actions-context";

import { deriveReviewHeader } from "@/components/diff-viewer/review-header-state";
import { StaleStepConfirm } from "@/components/diff-viewer/StaleStepCallout";
import { DisabledAwareButton } from "@/components/ui/disabled-aware-button";
import { useAuthedImage } from "@/hooks/use-authed-image";
import { cn } from "@/lib/cn";
import { useCommandKeys } from "@/lib/commands/registry";
import { diffViewerHref } from "@/lib/diff-viewer-href";
import type { CheckpointItem } from "@/lib/review/optimistic";
import {
  useIsInFlight,
  type DecideArgs,
} from "@/lib/review/use-review-mutations";
import type { ReviewContext } from "@/lib/review-context";
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
  /**
   * A later run captured this step again: approving it here would make the
   * older image the baseline, so Approve asks first. Absent or null: none.
   */
  newerCapture?: CheckpointItem["newerCapture"];
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
  /**
   * The page's review context (status and facets): the viewer opens with it.
   * One object for as long as the URL's filters are the same, so a decision
   * redraws no card but its own.
   */
  ctx: ReviewContext;
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
  ctx,
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

  // The step in the viewer, inside the page's filters: where opening it goes,
  // and where the Undone toast of its decision offers to go back to.
  const stepHref = diffViewerHref(projectId, runId, id, ctx);
  const open = () => router.push(stepHref);

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

  const decideStep = (
    kind: "approved" | "rejected",
    fromToolbar = toolbar.current?.contains(document.activeElement) === true,
  ) => {
    followFocus.current = fromToolbar;
    decide({
      runId,
      checkpointIds: [id],
      kind,
      label: `${kind === "approved" ? "Approved" : "Rejected"} '${name}'`,
      goTo: { href: stepHref, name },
    });
  };

  // An older capture is approved only after the viewer's stale-step question
  // (StaleStepConfirm, the same dialog and copy). `staleOpener` is the Approve
  // button while it is open; focus goes back to it on Cancel, and follows the
  // decision on Confirm as a plain Approve's would.
  const newerCapture = checkpoint.newerCapture ?? null;
  // The question exists only while this step can be approved here; once it
  // is decided elsewhere (or loses its newer capture) a question left open
  // ends with it, and never comes back by itself.
  const canAskStale = canReview && needsReviewer && newerCapture !== null;
  const [staleOpener, setStaleOpener] = useState<HTMLElement | null>(null);
  // The batch list's continuation for a question its `a` key asked (R26):
  // kept while the question is open, then, once Confirm has decided, until
  // the question has closed (`afterClose`), when it places focus itself.
  const onDecided = useRef<(() => void) | null>(null);
  const afterClose = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (canAskStale) return;
    onDecided.current = null;
    setStaleOpener(null);
  }, [canAskStale]);
  const returnFocusTo = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (staleOpener) {
      returnFocusTo.current = staleOpener;
      return;
    }
    const target = returnFocusTo.current;
    returnFocusTo.current = null;
    if (target?.isConnected) target.focus();
  }, [staleOpener]);

  const approveStep = (opener: HTMLElement, then?: () => void) => {
    if (newerCapture) {
      onDecided.current = then ?? null;
      setStaleOpener(opener);
      return;
    }
    decideStep("approved");
    then?.();
  };

  // Inside the batch list: the card is a cursor item (spec §6), and the
  // list's `a`, `r` and Enter / `o` run these, the same functions its buttons
  // call. A decision is available exactly when its buttons are.
  const card = useRef<HTMLDivElement>(null);
  const item = useCursorItem(stepItemId(id));
  const decidable = canReview && needsReviewer && header.canApprove;
  useRegisterStepActions(id, {
    approve: (then) => {
      const el = card.current;
      if (!decidable || el === null) return;
      // The question's Cancel gives focus back to what had it: the card, or
      // the control inside it.
      const active = document.activeElement;
      approveStep(
        active instanceof HTMLElement && el.contains(active) ? active : el,
        then,
      );
    },
    reject: () => {
      if (decidable) decideStep("rejected");
    },
    open,
    needsReviewer,
    decidable,
  });
  const approveKeys = useCommandKeys("batch.approve");
  const rejectKeys = useCommandKeys("batch.reject");
  // The list is one Tab stop (spec §6): the card's own controls are in the
  // Tab order only while the card is that stop, after it. A click still
  // focuses them, which makes the card the cursor.
  const innerTab = item !== null && item.tabIndex !== 0 ? -1 : undefined;

  // The icon buttons share one look; only the hover hue says which is which.
  // One that is unavailable (`aria-disabled`) does not react to hover: it
  // keeps its resting colours.
  const actionClass =
    "rounded p-1.5 text-fg-muted transition-colors hover:bg-edge aria-disabled:hover:bg-transparent aria-disabled:hover:text-fg-muted";

  return (
    <div
      ref={card}
      {...item}
      role="listitem"
      aria-label={`${name}, ${style.label}`}
      data-testid={`step-card-${id}`}
      className="group relative w-[320px] shrink-0 rounded-lg focus-ring"
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
          tabIndex={innerTab}
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
                  tabIndex={innerTab}
                  disabled={!header.canApprove}
                  reason={header.disabledReason}
                  ariaKeyShortcuts={approveKeys.ariaKeyShortcuts}
                  title={
                    approveKeys.titleSuffix
                      ? `Approve${approveKeys.titleSuffix}`
                      : undefined
                  }
                  onClick={(e) => {
                    e.stopPropagation();
                    approveStep(e.currentTarget);
                  }}
                  className={cn(actionClass, "hover:text-status-passed-text")}
                >
                  <ThumbsUp className="h-4 w-4" aria-hidden />
                </DisabledAwareButton>
                <DisabledAwareButton
                  variant="ghost"
                  label={`Reject ${name}`}
                  testId={`step-reject-${id}`}
                  tabIndex={innerTab}
                  disabled={!header.canReject}
                  reason={header.disabledReason}
                  ariaKeyShortcuts={rejectKeys.ariaKeyShortcuts}
                  title={
                    rejectKeys.titleSuffix
                      ? `Reject${rejectKeys.titleSuffix}`
                      : undefined
                  }
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
            {canAskStale && newerCapture && (
              <StaleStepConfirm
                buildName={newerCapture.buildName}
                open={staleOpener !== null}
                onCancel={() => {
                  onDecided.current = null;
                  setStaleOpener(null);
                }}
                onConfirm={() => {
                  const opener = staleOpener;
                  const then = onDecided.current;
                  onDecided.current = null;
                  // The step may have changed under the dialog: approve only
                  // what is still approvable.
                  const approving = header.canApprove;
                  if (approving && then !== null) {
                    // The list moves focus on, once the question has let
                    // go of it: not back to the card first.
                    returnFocusTo.current = null;
                    afterClose.current = then;
                  }
                  setStaleOpener(null);
                  if (approving) {
                    decideStep(
                      "approved",
                      opener !== null &&
                        toolbar.current?.contains(opener) === true,
                    );
                  }
                }}
                onCloseAutoFocus={(e) => {
                  const then = afterClose.current;
                  afterClose.current = null;
                  if (then === null) return;
                  e.preventDefault();
                  then();
                }}
              />
            )}
            {canReview && decision !== null && canUndo && (
              <DisabledAwareButton
                ref={undoButton}
                variant="ghost"
                label={`Undo ${decision.kind === "approved" ? "approval" : "rejection"} of ${name}`}
                testId={`step-undo-${id}`}
                tabIndex={innerTab}
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
            tabIndex={innerTab}
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
