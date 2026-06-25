"use client";

import Link from "next/link";

import type { BuildRowData } from "./build-types";

import { BuildStatusBadge } from "@/components/build-status-badge";
import { buildDisplayName } from "@/lib/build-display-name";
import { cn } from "@/lib/cn";
import { formatRelativeTime } from "@/lib/format";

interface Props {
  build: BuildRowData;
  projectId: string;
  selected: boolean;
}

/** Compact build entry in the context list panel → opens the batch page. */
export function BuildListItem({ build, projectId, selected }: Props) {
  return (
    <Link
      href={`/projects/${projectId}/builds/${build.id}`}
      aria-current={selected ? "page" : undefined}
      data-testid={`build-list-item-${build.id}`}
      className={cn(
        "group block rounded-md border px-3 py-2 transition-colors",
        selected
          ? "border-brand/30 bg-brand/5 shadow-[inset_3px_0_0_0_var(--color-brand)]"
          : "border-transparent hover:bg-zinc-100/60 dark:hover:bg-zinc-900/40",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span
          className={cn(
            "truncate text-sm text-zinc-900 transition-colors dark:text-zinc-100",
            selected ? "text-brand-text" : "group-hover:text-brand-text",
          )}
        >
          {buildDisplayName(build)}
        </span>
        <BuildStatusBadge status={build.aggregateStatus} />
      </div>
      <div className="mt-1 flex items-center justify-between gap-2 text-xs text-zinc-500">
        {build.branchName ? (
          <span className="truncate font-mono">{build.branchName}</span>
        ) : (
          <span />
        )}
        <span className="whitespace-nowrap">
          {formatRelativeTime(build.createdAt)}
        </span>
      </div>
    </Link>
  );
}
