"use client";

import Link from "next/link";

import type { BuildRowData } from "./build-types";

import { buildDisplayName } from "@/lib/build-display-name";
import { buildStatusMeta } from "@/lib/build-status-meta";
import { cn } from "@/lib/cn";
import { formatBatchDateTime } from "@/lib/format";

interface Props {
  build: BuildRowData;
  projectId: string;
  selected: boolean;
}

/** Full-bleed build entry in the history panel → opens the batch page. */
export function BuildListItem({ build, projectId, selected }: Props) {
  const meta = buildStatusMeta(build.aggregateStatus);
  return (
    <Link
      href={`/projects/${projectId}/builds/${build.id}`}
      aria-current={selected ? "page" : undefined}
      data-testid={`build-list-item-${build.id}`}
      className={cn(
        "group block border-l-2 px-3 py-2.5 transition-colors",
        meta.border,
        selected ? "bg-hover" : "hover:bg-hover/50",
      )}
    >
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-sm font-medium text-fg transition-colors",
            selected ? "text-brand-text" : "group-hover:text-brand-text",
          )}
        >
          {buildDisplayName(build)}
        </span>
        {build.branchName && (
          <span className="shrink-0 truncate font-mono text-2xs text-fg-muted">
            {build.branchName}
          </span>
        )}
      </div>
      <div className="mt-1 text-xs tabular-nums text-fg-muted">
        {formatBatchDateTime(build.createdAt)}
      </div>
      <div className={cn("mt-0.5 text-xs font-medium", meta.text)}>
        {meta.word}
      </div>
    </Link>
  );
}
