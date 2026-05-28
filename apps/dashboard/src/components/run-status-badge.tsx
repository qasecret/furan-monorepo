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

export const STATUS_CONFIG: Record<RunStatus, StatusConfig> = {
  new: {
    label: "New",
    className:
      "bg-zinc-100 text-zinc-700 border-zinc-200 dark:bg-zinc-900 dark:text-zinc-300 dark:border-zinc-800",
    tooltip: "First run for this test — baseline created",
  },
  running: {
    label: "Running",
    className: "bg-blue-500/10 text-blue-400 border-blue-500/20",
    tooltip: "Run is in progress",
  },
  passed: {
    label: "Passed",
    className: "bg-green-500/10 text-green-400 border-green-500/20",
    tooltip: "No visual differences",
  },
  unresolved: {
    label: "Unresolved",
    className: "bg-amber-500/10 text-amber-400 border-amber-500/20",
    tooltip: "Visual differences found — awaiting review",
  },
  failed: {
    label: "Failed",
    className: "bg-red-500/10 text-red-400 border-red-500/20",
    tooltip: "Differences rejected",
  },
  aborted: {
    label: "Aborted",
    className: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
    tooltip: "Run terminated before completion (worker issue)",
  },
  empty: {
    label: "Empty",
    className:
      "bg-zinc-100/70 text-zinc-500 border-zinc-200 dark:bg-zinc-900/50 dark:text-zinc-500 dark:border-zinc-800",
    tooltip: "Run completed but recorded no checks",
  },
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
