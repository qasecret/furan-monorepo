"use client";

import Link from "next/link";

import type { BuildRowData } from "./build-types";

import { buildDisplayName } from "@/lib/build-display-name";
import { cn } from "@/lib/cn";
import { formatBatchDateTime } from "@/lib/format";

interface Props {
  build: BuildRowData;
  projectId: string;
  selected: boolean;
}

/**
 * Per-status presentation for the history row — the left accent border colour
 * and the status word + its colour. Mirrors the reference's batch-history list.
 */
const STATUS_META: Record<
  string,
  { word: string; text: string; border: string }
> = {
  passed: {
    word: "Passed",
    text: "text-emerald-600 dark:text-emerald-400",
    border: "border-l-emerald-500",
  },
  unresolved: {
    word: "Unresolved",
    text: "text-amber-600 dark:text-amber-400",
    border: "border-l-amber-500",
  },
  failed: {
    word: "Failed",
    text: "text-red-600 dark:text-red-400",
    border: "border-l-red-500",
  },
  running: {
    word: "Running",
    text: "text-blue-600 dark:text-blue-400",
    border: "border-l-blue-500",
  },
  aborted: {
    word: "Aborted",
    text: "text-zinc-500 dark:text-zinc-400",
    border: "border-l-zinc-400 dark:border-l-zinc-600",
  },
  empty: {
    word: "Empty",
    text: "text-zinc-500 dark:text-zinc-400",
    border: "border-l-zinc-300 dark:border-l-zinc-700",
  },
};

/** Full-bleed build entry in the history panel → opens the batch page. */
export function BuildListItem({ build, projectId, selected }: Props) {
  const meta = STATUS_META[build.aggregateStatus] ?? STATUS_META.empty!;
  return (
    <Link
      href={`/projects/${projectId}/builds/${build.id}`}
      aria-current={selected ? "page" : undefined}
      data-testid={`build-list-item-${build.id}`}
      className={cn(
        "group block border-l-2 px-3 py-2.5 transition-colors",
        meta.border,
        selected
          ? "bg-zinc-100 dark:bg-zinc-800/60"
          : "hover:bg-zinc-50 dark:hover:bg-zinc-900/40",
      )}
    >
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-sm font-medium text-zinc-900 transition-colors dark:text-zinc-100",
            selected ? "text-brand-text" : "group-hover:text-brand-text",
          )}
        >
          {buildDisplayName(build)}
        </span>
        {build.branchName && (
          <span className="shrink-0 truncate font-mono text-[11px] text-zinc-400 dark:text-zinc-500">
            {build.branchName}
          </span>
        )}
      </div>
      <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-500">
        {formatBatchDateTime(build.createdAt)}
      </div>
      <div className={cn("mt-0.5 text-xs font-medium", meta.text)}>
        {meta.word}
      </div>
    </Link>
  );
}
