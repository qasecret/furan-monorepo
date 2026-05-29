"use client";

import type { RunStatus } from "@furan/shared-types";

import { cn } from "@/lib/cn";

export interface CheckpointSummary {
  id: string;
  name: string;
  status: RunStatus;
  diffPercent: number | null;
  thumbnailUrl?: string;
  testVariationId?: string | null;
}

/**
 * Status → dot color mapping. Mirrors `STATUS_CONFIG` in run-status-badge
 * but renders as a tiny solid dot — used in the rail where the full pill
 * would dominate the row. The two mappings are coupled by convention; if
 * `STATUS_CONFIG` shifts a status color, update this too.
 */
const STATUS_DOT_CLASS: Record<RunStatus, string> = {
  new: "bg-zinc-400 dark:bg-zinc-500",
  running: "bg-blue-500",
  passed: "bg-emerald-500",
  unresolved: "bg-amber-500",
  failed: "bg-red-500",
  aborted: "bg-yellow-500",
  empty: "bg-zinc-300 dark:bg-zinc-700",
};

export function CheckpointCard({
  item,
  selected,
  onClick,
}: {
  item: CheckpointSummary;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "group relative flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors",
        selected
          ? "bg-zinc-100 dark:bg-zinc-900"
          : "hover:bg-zinc-100/60 dark:hover:bg-zinc-900/40",
      )}
      data-testid={`checkpoint-card-${item.id}`}
    >
      {selected ? (
        <span
          className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-r-full bg-brand"
          aria-hidden
        />
      ) : null}
      <span className="relative h-8 w-8 shrink-0 overflow-hidden rounded bg-zinc-200 dark:bg-zinc-800">
        {item.thumbnailUrl ? (
          <img
            src={item.thumbnailUrl}
            alt=""
            className="h-full w-full object-cover"
          />
        ) : null}
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            "block truncate text-sm",
            selected
              ? "font-medium text-zinc-900 dark:text-white"
              : "text-zinc-600 group-hover:text-zinc-900 dark:text-zinc-400 dark:group-hover:text-white",
          )}
        >
          {item.name}
        </span>
        {item.diffPercent !== null ? (
          <span className="block text-[10px] font-mono text-zinc-500 dark:text-zinc-500">
            {item.diffPercent.toFixed(1)}%
          </span>
        ) : null}
      </span>
      <StatusDot status={item.status} />
    </button>
  );
}

function StatusDot({ status }: { status: RunStatus }) {
  const dotClass = STATUS_DOT_CLASS[status];
  // Capitalized label so screen readers say "Status: Running" not "running".
  // The visible status pill in ApprovalBar already carries the text label; this
  // dot is the rail-only visual cue, so without an aria-label colourblind +
  // screen-reader users can't distinguish unresolved (amber) from failed (red).
  const ariaLabel = `Status: ${status.charAt(0).toUpperCase()}${status.slice(1)}`;
  if (status === "running") {
    // Animated ping for in-flight runs so reviewers see live progress.
    return (
      <span
        role="img"
        aria-label={ariaLabel}
        className="relative inline-flex h-2 w-2 shrink-0"
        data-testid="checkpoint-card-status-dot"
        title="Running"
      >
        <span
          aria-hidden
          className={cn(
            "absolute inline-flex h-full w-full animate-ping rounded-full opacity-75",
            dotClass,
          )}
        />
        <span
          aria-hidden
          className={cn("relative inline-flex h-2 w-2 rounded-full", dotClass)}
        />
      </span>
    );
  }
  return (
    <span
      role="img"
      aria-label={ariaLabel}
      className={cn("inline-block h-2 w-2 shrink-0 rounded-full", dotClass)}
      data-testid="checkpoint-card-status-dot"
      title={status}
    />
  );
}
