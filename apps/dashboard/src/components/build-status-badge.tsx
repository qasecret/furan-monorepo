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
      classes: "bg-blue-100 text-blue-700 ring-blue-200",
    },
    unresolved: {
      label: "Unresolved",
      classes: "bg-amber-100 text-amber-800 ring-amber-300",
    },
    failed: {
      label: "Failed",
      classes: "bg-red-100 text-red-700 ring-red-200",
    },
    aborted: {
      label: "Aborted",
      classes: "bg-neutral-200 text-neutral-700 ring-neutral-300",
    },
    passed: {
      label: "Passed",
      classes: "bg-green-100 text-green-700 ring-green-200",
    },
    empty: {
      label: "Empty",
      classes: "bg-neutral-100 text-neutral-600 ring-neutral-200",
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
