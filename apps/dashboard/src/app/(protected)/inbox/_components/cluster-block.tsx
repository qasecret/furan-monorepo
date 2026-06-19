"use client";

import type { InboxRunRow } from "@furan/shared-types";

import type { ClusterGroup } from "./cluster-grouping";

import { QueueRow } from "@/components/triage/queue-row";
import { Button } from "@/components/ui/button";
import { plural } from "@/lib/format";

interface Props {
  cluster: ClusterGroup;
  /** Flat index of cluster.rows[0] within the page's items (for keyboard selection). */
  baseIndex: number;
  selectedIndex: number;
  onApprove: (row: InboxRunRow) => void;
  onReject: (row: InboxRunRow) => void;
  onRejectAll: (cluster: ClusterGroup) => void;
  /** Select a member row by its flat index. Optional — cluster works without it. */
  onSelect?: (flatIndex: number) => void;
}

export function ClusterBlock({
  cluster,
  baseIndex,
  selectedIndex,
  onApprove,
  onReject,
  onRejectAll,
  onSelect,
}: Props) {
  return (
    <li className="list-none">
      <div
        data-testid={`cluster-header-${cluster.signature}`}
        className="flex items-center gap-2 border-b border-sky-200 bg-sky-50 px-4 py-1.5 text-xs text-sky-800 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-300"
      >
        <span className="flex-1">
          Same change · {cluster.runCount} run{plural(cluster.runCount)} across{" "}
          {cluster.buildCount} build{plural(cluster.buildCount)}
        </span>
        <Button
          variant="secondary"
          className="h-6 px-2 text-xs"
          data-testid={`cluster-reject-all-${cluster.signature}`}
          onClick={() => onRejectAll(cluster)}
        >
          Reject all
        </Button>
      </div>
      <ul role="list">
        {cluster.rows.map((row, i) => (
          <QueueRow
            key={row.runId}
            row={row}
            selected={baseIndex + i === selectedIndex}
            onApprove={() => onApprove(row)}
            onReject={() => onReject(row)}
            onSelect={onSelect ? () => onSelect(baseIndex + i) : undefined}
          />
        ))}
      </ul>
    </li>
  );
}
