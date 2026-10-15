"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, type KeyboardEvent } from "react";

import { Button } from "@/components/ui/button";
import { announce } from "@/lib/review/review-announcer";
import type { ReviewCard } from "@/lib/review/use-review-loop";
import type { RouterOutputs } from "@/lib/trpc";

type NextBatch = NonNullable<RouterOutputs["review"]["next"]["nextBatch"]>;

export interface BatchDoneCardProps {
  /**
   * `batch`: nothing is pending in the batch. `filtered`: the steps inside
   * the reviewer's filters are done, others are not. `all`: nothing is
   * pending anywhere.
   */
  variant: ReviewCard;
  /** The next batch that needs review, inside the filters; null: no Continue. */
  nextBatch: NextBatch | null;
  /** This batch's pending steps outside the filters (Clear filter's count). */
  batchUnfiltered: number;
  /** Continue to the next batch (the review loop's move). */
  onContinue: () => void;
  /** Clear the filter, to this batch's steps outside it (the loop's move). */
  onClearFilter: () => void;
  /**
   * Continue or Clear filter is on its way: both say so (`aria-busy`) until
   * the route commits; pressing again does nothing (the loop sees to it).
   */
  busy?: boolean;
  /** Back to batch, and Esc: the batch, as the reviewer left it. */
  backHref: string;
  /**
   * Back to batches, on any card with no Continue: the Batches page, its
   * status and branch kept.
   */
  batchesHref: string;
}

const TITLES: Record<ReviewCard, string> = {
  batch: "Batch done",
  filtered: "Done with the filtered steps",
  all: "All caught up",
};

const ALL_BODY = "Nothing needs review in this project.";

/** "Continue to build #43 · main · 5 pending" (the arrow is drawn, not read). */
function continueLabel(batch: NextBatch): string {
  const name = batch.number !== null ? `build #${batch.number}` : batch.name;
  return [`Continue to ${name}`, batch.branch, `${batch.pending} pending`]
    .filter(Boolean)
    .join(" · ");
}

type Action = "continue" | "clear" | "batches" | "batch";

/**
 * The card the viewer shows in place of the canvas when the review loop has
 * nowhere left to go in this batch (spec §5.4): Batch done, Done with the
 * filtered steps, or All caught up, with the way on.
 *
 * Presentational: Continue and Clear filter are the loop's moves, handed in;
 * Back to batch and Back to batches are links. The actions come in a fixed
 * order (Continue, Clear filter, Back to batches, Back to batch) and the
 * first one shown is the primary: it has the focus, and it is announced with
 * the title through the page's one polite region, once per time the card
 * appears. Enter is the focused button's; Esc goes back to the batch.
 *
 * A dialog, so the viewer's shortcuts yield to it while focus is in it, but
 * not a modal one: no focus trap, and the header stays usable. ⌘Z still
 * reaches the viewer (`data-passes-undo`): undoing the decision that brought
 * the card up brings the step back.
 */
export function BatchDoneCard({
  variant,
  nextBatch,
  batchUnfiltered,
  onContinue,
  onClearFilter,
  busy = false,
  backHref,
  batchesHref,
}: BatchDoneCardProps) {
  const router = useRouter();
  const titleId = useId();
  const bodyId = useId();
  const title = TITLES[variant];
  const nextLabel = nextBatch ? continueLabel(nextBatch) : null;
  const clearLabel = `Clear filter (${batchUnfiltered} more in this batch)`;

  const actions: Action[] = [];
  if (nextBatch) actions.push("continue");
  // Only the filtered card has steps outside the filters to clear it for.
  if (variant === "filtered" && batchUnfiltered > 0) actions.push("clear");
  // Nowhere to continue to: the batches are the way on.
  if (!nextBatch) actions.push("batches");
  actions.push("batch");
  const primary = actions[0];

  const labels: Record<Action, string> = {
    continue: nextLabel ?? "",
    clear: clearLabel,
    batches: "Back to batches",
    batch: "Back to batch",
  };
  const primaryLabel = primary ? labels[primary] : "";

  // The primary action takes the focus when the card appears.
  const primaryRef = useRef<HTMLElement | null>(null);
  const setPrimary = (el: HTMLElement | null) => {
    primaryRef.current = el;
  };
  useEffect(() => {
    primaryRef.current?.focus();
  }, []);

  // Said once per time the card appears; a count that changes while it is up
  // is not news (and strict mode's second run of this effect is not either).
  const said = useRef(false);
  useEffect(() => {
    if (said.current) return;
    said.current = true;
    announce(`${title}. ${primaryLabel}.`);
  }, [title, primaryLabel]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    e.preventDefault();
    if (e.repeat) return;
    router.push(backHref);
  };

  const variantFor = (action: Action) =>
    action === primary ? "default" : "secondary";

  return (
    <div
      className="flex flex-1 items-center justify-center p-6"
      data-testid="batch-done-card-area"
    >
      <div
        role="dialog"
        aria-labelledby={titleId}
        {...(variant === "all" ? { "aria-describedby": bodyId } : {})}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        data-passes-undo=""
        data-variant={variant}
        data-testid="batch-done-card"
        className="w-full max-w-md rounded-overlay bg-overlay p-6 text-fg shadow-overlay outline-none motion-safe:[animation:var(--animate-content-in)]"
      >
        <h2 id={titleId} className="text-lg font-semibold text-fg">
          {title}
        </h2>
        {variant === "all" ? (
          <p id={bodyId} className="mt-1.5 text-sm text-fg-secondary">
            {ALL_BODY}
          </p>
        ) : null}
        <div className="mt-5 flex flex-col gap-2">
          {actions.map((action) => {
            const ref = action === primary ? setPrimary : undefined;
            switch (action) {
              case "continue":
                return (
                  <Button
                    key={action}
                    ref={ref}
                    variant={variantFor(action)}
                    className="justify-between gap-2 aria-busy:cursor-progress"
                    aria-busy={busy}
                    onClick={onContinue}
                    data-testid="batch-done-continue"
                  >
                    <span className="truncate">{labels.continue}</span>{" "}
                    <span aria-hidden="true">→</span>
                  </Button>
                );
              case "clear":
                return (
                  <Button
                    key={action}
                    ref={ref}
                    variant={variantFor(action)}
                    className="aria-busy:cursor-progress"
                    aria-busy={busy}
                    onClick={onClearFilter}
                    data-testid="batch-done-clear-filter"
                  >
                    {labels.clear}
                  </Button>
                );
              case "batches":
                return (
                  <Button
                    key={action}
                    ref={ref}
                    variant={variantFor(action)}
                    asChild
                  >
                    <Link href={batchesHref} data-testid="batch-done-batches">
                      {labels.batches}
                    </Link>
                  </Button>
                );
              case "batch":
                return (
                  <Button
                    key={action}
                    ref={ref}
                    variant={variantFor(action)}
                    asChild
                  >
                    <Link
                      href={backHref}
                      aria-keyshortcuts="Escape"
                      title="Back to batch (Esc)"
                      data-testid="batch-done-back"
                    >
                      {labels.batch}
                    </Link>
                  </Button>
                );
            }
          })}
        </div>
      </div>
    </div>
  );
}
