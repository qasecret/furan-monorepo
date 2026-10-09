"use client";

import type { RunStatus } from "@furan/shared-types";
import { ArrowLeft, ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { RunStatusBadge } from "@/components/run-status-badge";

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
}

/**
 * Single-row contextual top bar above the diff viewer, modelled on the
 * reference TestStep header: back ← · breadcrumb (branch / test) · step
 * prev-next · status, with a right-aligned action slot. Pure presentation —
 * the DiffViewer composes the data and actions.
 */
export function ContextualHeader({
  title,
  statusNode,
  status,
  backHref,
  branch,
  nav,
  rightActions,
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
      {rightActions ? (
        <div className="flex shrink-0 items-center gap-2">{rightActions}</div>
      ) : null}
    </header>
  );
}
