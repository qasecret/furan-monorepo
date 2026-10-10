"use client";

import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { formatRelativeTime } from "@/lib/format";
import type { CheckpointItem } from "@/lib/review/optimistic";
import { describeSkip } from "@/lib/review/review-copy";
import { reviewStateStyle } from "@/lib/status-style";

type Decision = NonNullable<CheckpointItem["decision"]>;

interface Props {
  decision: Decision;
  /**
   * Takes the decision back. Undo is offered only when the server says the
   * viewer may undo it (`decision.undo.allowed`) and this is given.
   */
  onUndo?: () => void;
  /** The decision is still on its way to the server: Undo waits. */
  busy?: boolean;
}

/**
 * Who decided a step and when, with Undo while it can be taken back. A
 * decision from before review history (`legacy`) says so instead of naming a
 * reviewer, and cannot be undone: the same tooltip that explains any other
 * refusal explains that one.
 */
export function DecisionChip({ decision, onUndo, busy = false }: Props) {
  const style = reviewStateStyle(decision.kind);
  const Icon = style.icon;
  const word = style.label;
  const canUndo = decision.undo.allowed && onUndo !== undefined;

  const pill = (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium",
        style.pill,
      )}
    >
      <Icon className="h-3 w-3" aria-hidden />
      <span className="sr-only">Step decision: </span>
      {decision.legacy ? `${word} (before review history)` : word}
    </span>
  );

  return (
    <TooltipProvider delayDuration={200}>
      <span
        className="inline-flex items-center gap-2"
        data-testid="decision-chip"
      >
        {decision.undo.allowed ? (
          pill
        ) : (
          <Tooltip>
            {/* Focusable, so the reason reaches keyboard users too. */}
            <TooltipTrigger asChild>
              <span tabIndex={0} className="rounded-full focus-ring">
                {pill}
              </span>
            </TooltipTrigger>
            <TooltipContent sideOffset={4} data-testid="decision-undo-reason">
              {decision.undo.reason
                ? `Can't undo: ${describeSkip(decision.undo.reason)}`
                : "Can't undo this decision"}
            </TooltipContent>
          </Tooltip>
        )}
        {!decision.legacy && (
          <span className="inline-flex items-center gap-1 text-xs text-fg-muted">
            <span aria-hidden>·</span>
            {decision.actor && (
              <>
                <span>{decision.actor.name}</span>
                <span aria-hidden>·</span>
              </>
            )}
            {/* Its own element, holding only the relative time. */}
            <span>{formatRelativeTime(decision.at)}</span>
          </span>
        )}
        {canUndo && (
          <Button
            variant="secondary"
            className="px-3 py-1 text-xs"
            data-testid="decision-undo"
            aria-label={`Undo ${decision.kind === "approved" ? "approval" : "rejection"}`}
            disabled={busy}
            onClick={onUndo}
          >
            Undo
          </Button>
        )}
      </span>
    </TooltipProvider>
  );
}
