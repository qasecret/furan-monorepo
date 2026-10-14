"use client";

import {
  isPending,
  type CheckpointReviewState,
  type RunStatus,
  type RunStatusOverride,
} from "@furan/shared-types";
import { Maximize2, Star, ThumbsDown, ThumbsUp, Undo2 } from "lucide-react";
import { useRouter } from "next/navigation";

import { deriveReviewHeader } from "@/components/diff-viewer/review-header-state";
import { useAuthedImage } from "@/hooks/use-authed-image";
import { cn } from "@/lib/cn";
import type { CheckpointItem } from "@/lib/review/optimistic";
import {
  useIsInFlight,
  useReviewMutations,
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
 * decisions: the same facts the viewer header reads (spec §5.4).
 */
export interface StepRun {
  /** The run's status as its steps roll up. */
  status: RunStatus;
  /** The run's hand-set status, or null when it is computed. */
  statusOverride: RunStatusOverride | null;
  /** The review state of every step of the run, not just of this row. */
  stepStates: ReadonlyArray<CheckpointReviewState | null>;
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
 * on its way.
 */
export function StepCard({
  projectId,
  runId,
  canReview,
  checkpoint,
  index,
  total,
  run,
}: Props) {
  const router = useRouter();
  const { decide, undo } = useReviewMutations();
  const inFlight = useIsInFlight(checkpoint.id);
  const thumb = useAuthedImage(checkpoint.imageKey);
  const { id, name, state, decision } = checkpoint;
  const { style, running } = lookOf(state, run.status);
  const StatusIcon = style.icon;

  const header = deriveReviewHeader({
    status: run.status,
    statusOverride: run.statusOverride,
    step: { state, hasDecision: decision !== null },
    stepStates: run.stepStates,
    stepInFlight: inFlight,
    runInFlight: false,
  });
  const needsReviewer = state !== null && isPending(state);
  const canUndo = decision?.undo.allowed === true;
  const undoLocked = header.decisionLockedReason !== null || inFlight;

  const open = () =>
    router.push(`/projects/${projectId}/runs/${runId}/checkpoints/${id}`);

  const decideStep = (kind: "approved" | "rejected") =>
    decide({
      runId,
      checkpointIds: [id],
      kind,
      label: `${kind === "approved" ? "Approved" : "Rejected"} '${name}'`,
    });

  const actionClass =
    "rounded p-1.5 text-fg-muted transition-colors hover:bg-edge focus-ring disabled:opacity-50";

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
          data-testid={`step-toolbar-${id}`}
          className="flex items-center justify-between border-t border-edge bg-sunken px-2 py-1.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
        >
          <div className="flex items-center gap-1">
            {canReview && needsReviewer && (
              <>
                <button
                  type="button"
                  aria-label={`Approve ${name}`}
                  data-testid={`step-approve-${id}`}
                  disabled={!header.canApprove}
                  title={
                    header.canApprove
                      ? undefined
                      : (header.disabledReason ?? undefined)
                  }
                  onClick={(e) => {
                    e.stopPropagation();
                    decideStep("approved");
                  }}
                  className={cn(actionClass, "hover:text-status-passed-text")}
                >
                  <ThumbsUp className="h-4 w-4" aria-hidden />
                </button>
                <button
                  type="button"
                  aria-label={`Reject ${name}`}
                  data-testid={`step-reject-${id}`}
                  disabled={!header.canReject}
                  title={
                    header.canReject
                      ? undefined
                      : (header.disabledReason ?? undefined)
                  }
                  onClick={(e) => {
                    e.stopPropagation();
                    decideStep("rejected");
                  }}
                  className={cn(actionClass, "hover:text-status-failed-text")}
                >
                  <ThumbsDown className="h-4 w-4" aria-hidden />
                </button>
              </>
            )}
            {canReview && decision !== null && canUndo && (
              <button
                type="button"
                aria-label={`Undo ${decision.kind === "approved" ? "approval" : "rejection"} of ${name}`}
                data-testid={`step-undo-${id}`}
                disabled={undoLocked}
                title={header.decisionLockedReason ?? undefined}
                onClick={(e) => {
                  e.stopPropagation();
                  undo(decision.actionId);
                }}
                className={cn(actionClass, "hover:text-fg")}
              >
                <Undo2 className="h-4 w-4" aria-hidden />
              </button>
            )}
          </div>
          <button
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
}
