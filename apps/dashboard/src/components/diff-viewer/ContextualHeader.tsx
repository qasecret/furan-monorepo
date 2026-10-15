"use client";

import type { RunStatus } from "@furan/shared-types";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  ChevronsRight,
  Loader2,
  RefreshCw,
} from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { RunStatusBadge } from "@/components/run-status-badge";
import { Button } from "@/components/ui/button";

/** The review loop's place in the header: how many are left, and the way on. */
export interface HeaderLoop {
  /**
   * "‹N› left in batch", or "‹N› left in batch · ‹M› in filter" with facets
   * set; empty until the count is known (no pill then).
   */
  remaining: string;
  /** Next pending: the same move as J. */
  onNextPending?: () => void;
  /**
   * A decision is waiting for the next step to be looked up (spec §5.4):
   * the button shows it is busy, and stays pressable (pressing again is
   * harmless).
   */
  pending?: boolean;
  /** The Next pending button's text. */
  nextLabel: string;
  /**
   * The cue of the move that opened this test, while it is shown (R15). The
   * chip is aria-hidden: the live region has already said it.
   */
  cue?: string;
  /** Why the next step could not be looked up; shown beside the pill. */
  error?: string;
  /** Look it up again after `error`. */
  onRetry?: () => void;
}

interface Props {
  /** Test / run name — the bold breadcrumb leaf. */
  title: string;
  /** Optional pre-built status node. Falls back to a RunStatusBadge. */
  statusNode?: ReactNode;
  status?: RunStatus;
  /** Back link to the parent batch. */
  backHref?: string;
  /** Branch segment shown before the title in the breadcrumb. */
  branch?: string | null;
  /** Step navigation through the run's checkpoints. */
  nav?: {
    index: number;
    total: number;
    onPrev?: () => void;
    onNext?: () => void;
  };
  /** Right-aligned slot for actions (approve / reject / mark-as-bug, …). */
  rightActions?: ReactNode;
  /** The review loop: the pill, the cue and Next pending. Absent: hidden. */
  loop?: HeaderLoop;
}

/**
 * Single-row contextual top bar above the diff viewer, modelled on the
 * reference TestStep header: back ← · breadcrumb (branch / test) · step
 * prev-next · status, with a right-aligned action slot led by the review
 * loop (left in batch · Next pending). Pure presentation — the DiffViewer
 * composes the data and actions.
 */
export function ContextualHeader({
  title,
  statusNode,
  status,
  backHref,
  branch,
  nav,
  rightActions,
  loop,
}: Props) {
  return (
    <header
      className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-edge bg-canvas px-4"
      data-testid="contextual-header"
    >
      <div className="flex min-w-0 items-center gap-3">
        {backHref ? (
          <>
            <Link
              href={backHref}
              aria-label="Back to batch"
              data-testid="contextual-header-back"
              className="rounded-md p-1.5 text-fg-muted transition-colors hover:bg-hover hover:text-fg focus-ring"
            >
              <ArrowLeft className="h-5 w-5" aria-hidden />
            </Link>
            <span className="h-4 w-px bg-edge" aria-hidden />
          </>
        ) : null}
        <div className="flex min-w-0 items-center gap-2 text-sm">
          {branch ? (
            <>
              <span className="truncate font-mono text-fg-muted">{branch}</span>
              <span className="text-edge-strong" aria-hidden>
                /
              </span>
            </>
          ) : null}
          <h1
            className="truncate font-medium text-fg"
            data-testid="contextual-header-title"
          >
            {title}
          </h1>
        </div>
        {nav && nav.total > 1 ? (
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label="Previous step"
              data-testid="contextual-header-prev"
              onClick={nav.onPrev}
              disabled={!nav.onPrev}
              className="rounded p-1 text-fg-muted transition-colors hover:text-fg focus-ring disabled:opacity-40"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden />
            </button>
            <span className="w-12 text-center font-mono text-xs tabular-nums text-fg-muted">
              {nav.index + 1} / {nav.total}
            </span>
            <button
              type="button"
              aria-label="Next step"
              data-testid="contextual-header-next"
              onClick={nav.onNext}
              disabled={!nav.onNext}
              className="rounded p-1 text-fg-muted transition-colors hover:text-fg focus-ring disabled:opacity-40"
            >
              <ChevronRight className="h-4 w-4" aria-hidden />
            </button>
          </div>
        ) : null}
        {statusNode ?? (status ? <RunStatusBadge status={status} /> : null)}
      </div>
      {rightActions || loop ? (
        <div className="flex shrink-0 items-center gap-2">
          {loop ? <LoopControls loop={loop} /> : null}
          {loop && rightActions ? (
            <span className="h-4 w-px bg-edge" aria-hidden />
          ) : null}
          {rightActions}
        </div>
      ) : null}
    </header>
  );
}

/** Left in batch, the move's cue, a failed lookup, and Next pending. */
function LoopControls({ loop }: { loop: HeaderLoop }) {
  const { remaining, onNextPending, pending, nextLabel, cue, error, onRetry } =
    loop;
  return (
    <div className="flex items-center gap-2" data-testid="header-loop">
      {remaining ? (
        <span
          className="whitespace-nowrap rounded-full border border-edge px-2 py-0.5 text-xs tabular-nums text-fg-secondary"
          data-testid="header-loop-remaining"
        >
          {remaining}
        </span>
      ) : null}
      {cue ? (
        // Seen, not heard: the live region announces the same words. Bounded,
        // so a long test name cannot push the actions out of the header.
        <span
          aria-hidden="true"
          className="max-w-64 truncate rounded-md bg-hover px-2 py-0.5 text-2xs text-fg-secondary motion-safe:[animation:var(--animate-overlay-in)]"
          data-testid="header-loop-cue"
        >
          {cue}
        </span>
      ) : null}
      {/* Always mounted, only its text changes: a screen reader announces a
          change inside a live region that was already there. Empty, it is
          visually hidden and out of the flow. */}
      <span
        role="status"
        className={
          error ? "whitespace-nowrap text-2xs text-fg-muted" : "sr-only"
        }
        data-testid="header-loop-error"
      >
        {error ?? ""}
      </span>
      {error && onRetry ? (
        <Button
          variant="ghost"
          className="h-7 gap-1 px-2 text-xs"
          aria-label="Retry loading the next step"
          data-testid="header-loop-retry"
          onClick={onRetry}
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          Retry
        </Button>
      ) : null}
      <Button
        variant="secondary"
        className="h-8 gap-1 px-3 text-xs"
        aria-label="Next pending step"
        aria-busy={pending ?? false}
        title="Next pending step (J)"
        data-testid="header-next-pending"
        onClick={onNextPending}
        disabled={!onNextPending}
      >
        {nextLabel}
        {pending ? (
          // Turns only when motion is allowed; still, it reads as busy.
          <Loader2
            className="h-4 w-4 text-fg-muted motion-safe:animate-spin"
            aria-hidden
            data-testid="header-next-pending-busy"
          />
        ) : (
          <ChevronsRight className="h-4 w-4" aria-hidden />
        )}
      </Button>
    </div>
  );
}
