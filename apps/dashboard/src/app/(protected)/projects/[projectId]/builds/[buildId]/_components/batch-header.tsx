"use client";

import { BuildStatusBadge } from "@/components/build-status-badge";
import { buildDisplayName } from "@/lib/build-display-name";
import { cn } from "@/lib/cn";
import { formatRelativeTime } from "@/lib/format";
import type { RouterOutputs } from "@/lib/trpc";

export type BatchHeaderData = RouterOutputs["builds"]["getById"];

interface Props {
  build: BatchHeaderData;
}

export function BatchHeader({ build }: Props) {
  const summary = [
    `${build.runCount} test${build.runCount === 1 ? "" : "s"}`,
    build.unresolvedCount > 0 && `${build.unresolvedCount} unresolved`,
    build.failedCount > 0 && `${build.failedCount} failed`,
    build.passedCount > 0 && `${build.passedCount} passed`,
    build.abortedCount > 0 && `${build.abortedCount} aborted`,
  ]
    .filter(Boolean)
    .join(" · ");
  const props = Object.entries(build.properties);
  // Status-colored accent bar (reference batch-detail header), derived from
  // the real run counts rather than a separate status mapping.
  const accent =
    build.failedCount > 0
      ? "bg-red-500"
      : build.unresolvedCount > 0
        ? "bg-amber-500"
        : build.passedCount > 0
          ? "bg-emerald-500"
          : "bg-zinc-400 dark:bg-zinc-600";
  return (
    <header
      id="batch-header"
      className="border-b border-zinc-200 px-4 py-4 dark:border-zinc-800"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span
          aria-hidden
          className={cn("h-6 w-1 shrink-0 rounded-full", accent)}
        />
        <h1 className="text-xl font-semibold tracking-tight text-zinc-950 dark:text-white">
          {buildDisplayName(build)}
        </h1>
        {build.branchName && (
          <span className="text-sm text-zinc-600 dark:text-zinc-400">
            {build.branchName}
          </span>
        )}
        <BuildStatusBadge status={build.aggregateStatus} />
      </div>
      <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
        {summary} · {formatRelativeTime(build.createdAt)}
        {props.length > 0 &&
          " · " + props.map(([k, v]) => `${k}=${v}`).join(" · ")}
      </p>
    </header>
  );
}
