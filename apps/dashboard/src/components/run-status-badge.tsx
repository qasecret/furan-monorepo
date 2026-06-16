"use client";

import type { RunStatus } from "@furan/shared-types";

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/**
 * Visual presentation for a single `RunStatus` value. Single source of truth
 * for the status → label / pill colour / tooltip mapping (spec §3.5).
 *
 * The amber/yellow split is load-bearing: `unresolved` (amber) is "needs
 * reviewer attention", `aborted` (yellow) is "infra issue — re-run". Do not
 * collapse them into one colour without revisiting the spec.
 */
type StatusConfig = {
  label: string;
  className: string;
  tooltip: string;
};

/*
 * Per-mode color values. Dark mode keeps the original `text-{c}-400 bg-{c}-500/10`
 * scheme (the dark surface gives high contrast against the lighter text).
 * Light mode darkens the text so the badge passes WCAG-AA against a near-white
 * tinted bg (`bg-{c}-500/10` over white ≈ #EAF…). The original light-mode values
 * measured at ~1.6–2.5:1; the new shades hit ≥4.5:1.
 */
export const STATUS_CONFIG: Record<RunStatus, StatusConfig> = {
  new: {
    label: "New",
    className:
      "bg-zinc-100 text-zinc-700 border-zinc-200 dark:bg-zinc-900 dark:text-zinc-300 dark:border-zinc-800",
    tooltip: "First run for this test — baseline created",
  },
  running: {
    label: "Running",
    className:
      "bg-blue-500/10 text-blue-700 border-blue-500/30 dark:text-blue-400 dark:border-blue-500/20",
    tooltip: "Run is in progress",
  },
  passed: {
    label: "Passed",
    className:
      "bg-green-500/10 text-green-800 border-green-500/30 dark:text-green-400 dark:border-green-500/20",
    tooltip: "No visual differences",
  },
  unresolved: {
    label: "Unresolved",
    className:
      "bg-amber-500/10 text-amber-800 border-amber-500/30 dark:text-amber-400 dark:border-amber-500/20",
    tooltip: "Visual differences found — awaiting review",
  },
  failed: {
    label: "Failed",
    className:
      "bg-red-500/10 text-red-700 border-red-500/30 dark:text-red-400 dark:border-red-500/20",
    tooltip: "Differences rejected",
  },
  aborted: {
    label: "Aborted",
    className:
      "bg-yellow-500/10 text-yellow-800 border-yellow-500/30 dark:text-yellow-400 dark:border-yellow-500/20",
    tooltip: "Run terminated before completion (worker issue)",
  },
  empty: {
    label: "Empty",
    className:
      "bg-zinc-100/70 text-zinc-600 border-zinc-200 dark:bg-zinc-900/50 dark:text-zinc-500 dark:border-zinc-800",
    tooltip: "Run completed but recorded no checks",
  },
};

/**
 * Left border-accent for table-row status stripes (runs index). Co-located
 * with STATUS_CONFIG so status→colour stays defined in exactly one file.
 * Static literals so Tailwind's JIT keeps every class.
 */
export const STATUS_STRIPE: Record<RunStatus, string> = {
  unresolved: "border-l-amber-500",
  failed: "border-l-red-500",
  aborted: "border-l-yellow-500",
  running: "border-l-blue-500",
  passed: "border-l-green-500",
  new: "border-l-zinc-300 dark:border-l-zinc-600",
  empty: "border-l-zinc-200 dark:border-l-zinc-800",
};

/** Text-emphasis for a run's change magnitude, keyed to reviewer-actionability. */
export const STATUS_ACCENT: Record<RunStatus, string> = {
  unresolved: "text-amber-700 dark:text-amber-400",
  failed: "text-red-600 dark:text-red-400",
  aborted: "text-zinc-700 dark:text-zinc-300",
  running: "text-zinc-700 dark:text-zinc-300",
  passed: "text-zinc-700 dark:text-zinc-300",
  new: "text-zinc-700 dark:text-zinc-300",
  empty: "text-zinc-700 dark:text-zinc-300",
};

interface Props {
  status: RunStatus;
}

/**
 * Coloured status pill for a `test_runs.status` value, with a Radix tooltip
 * that explains what the status means. Consumed by run-row, the runs-list
 * filter, and ApprovalBar — keep this the only place that maps a status to
 * a visual representation.
 */
export function RunStatusBadge({ status }: Props) {
  const config = STATUS_CONFIG[status];
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            data-testid={`run-status-badge-${status}`}
            className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${config.className}`}
          >
            {config.label}
          </span>
        </TooltipTrigger>
        <TooltipContent sideOffset={4}>{config.tooltip}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
