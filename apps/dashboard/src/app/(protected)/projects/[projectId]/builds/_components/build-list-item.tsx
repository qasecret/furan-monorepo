"use client";

import Link from "next/link";

import type { BuildRowData } from "./build-types";

import { buildDisplayName } from "@/lib/build-display-name";
import { buildStatusMeta } from "@/lib/build-status-meta";
import { cn } from "@/lib/cn";
import { formatBatchDateTime } from "@/lib/format";
import {
  batchHref,
  PANEL_LINK_KEYS,
  type ReviewContext,
} from "@/lib/review-url";

interface Props {
  build: BuildRowData;
  projectId: string;
  selected: boolean;
  /**
   * The review context in the URL. The link carries the status, facets and
   * `props` of it (`PANEL_LINK_KEYS`); branch and search belong to Batches.
   */
  context?: ReviewContext;
}

/** Full-bleed build entry in the history panel → opens the batch page. */
export function BuildListItem({ build, projectId, selected, context }: Props) {
  const meta = buildStatusMeta(build.aggregateStatus);
  return (
    <Link
      href={batchHref(projectId, build.id, context, undefined, PANEL_LINK_KEYS)}
      aria-current={selected ? "page" : undefined}
      data-testid={`build-list-item-${build.id}`}
      className={cn(
        // The ring is drawn inside: the panel scrolls, and would clip it.
        "group block border-l-2 px-3 py-2.5 transition-colors focus-ring focus-visible:-outline-offset-2",
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
      <div className="mt-0.5 flex items-baseline gap-2">
        <span className={cn("text-xs font-medium", meta.text)}>
          {meta.word}
        </span>
        {build.pendingCheckpoints > 0 && (
          <span
            className="text-2xs tabular-nums text-fg-muted"
            data-testid={`build-list-item-pending-${build.id}`}
          >
            {build.pendingCheckpoints} pending
          </span>
        )}
      </div>
    </Link>
  );
}
