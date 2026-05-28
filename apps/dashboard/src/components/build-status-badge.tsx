import type { BuildAggregateStatus } from "@furan/shared-types";

import { cn } from "@/lib/cn";

/**
 * Visual presentation for a `BuildAggregateStatus` — the six-value roll-up
 * across a build's runs. Distinct from `RunStatusBadge` which renders the
 * seven-value run-level enum (no `"new"` exists at the build level — runs
 * with `"new"` aggregate to `"passed"`; spec §3.2).
 */
const styles: Record<BuildAggregateStatus, { label: string; classes: string }> =
  {
    running: {
      label: "Running",
      classes: "bg-blue-500/10 text-blue-400 ring-blue-500/20",
    },
    unresolved: {
      label: "Unresolved",
      classes: "bg-amber-500/10 text-amber-400 ring-amber-500/20",
    },
    failed: {
      label: "Failed",
      classes: "bg-red-500/10 text-red-400 ring-red-500/20",
    },
    aborted: {
      label: "Aborted",
      classes:
        "bg-zinc-100 text-zinc-600 ring-zinc-200 dark:bg-zinc-900 dark:text-zinc-400 dark:ring-zinc-800",
    },
    passed: {
      label: "Passed",
      classes: "bg-green-500/10 text-green-400 ring-green-500/20",
    },
    empty: {
      label: "Empty",
      classes:
        "bg-zinc-100/70 text-zinc-500 ring-zinc-200 dark:bg-zinc-900/50 dark:text-zinc-500 dark:ring-zinc-800",
    },
  };

interface Props {
  status: BuildAggregateStatus;
  className?: string;
}

export function BuildStatusBadge({ status, className }: Props) {
  const s = styles[status];
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset",
        s.classes,
        className,
      )}
      data-testid={`build-status-${status}`}
    >
      {s.label}
    </span>
  );
}
