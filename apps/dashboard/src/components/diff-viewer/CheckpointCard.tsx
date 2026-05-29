"use client";

import type { RunStatus } from "@furan/shared-types";

import { RunStatusBadge } from "@/components/run-status-badge";

export interface CheckpointSummary {
  id: string;
  name: string;
  status: RunStatus;
  diffPercent: number | null;
  thumbnailUrl?: string;
}

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
      className={
        "flex w-full items-start gap-2 rounded-md border px-2 py-2 text-left transition " +
        (selected
          ? "border-zinc-300 bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900"
          : "border-transparent hover:bg-zinc-50 dark:hover:bg-zinc-900/40")
      }
      data-testid={`checkpoint-card-${item.id}`}
    >
      <div className="h-10 w-10 flex-none rounded bg-zinc-200 dark:bg-zinc-800">
        {item.thumbnailUrl ? (
          <img
            src={item.thumbnailUrl}
            alt=""
            className="h-full w-full rounded object-cover"
          />
        ) : null}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-zinc-900 dark:text-white">
          {item.name}
        </div>
        <div className="mt-1 flex items-center gap-2 text-xs text-zinc-500">
          <RunStatusBadge status={item.status} />
          {item.diffPercent !== null ? (
            <span>{item.diffPercent.toFixed(1)}%</span>
          ) : null}
        </div>
      </div>
    </button>
  );
}
