"use client";

import type { BuildAggregateStatus } from "@furan/shared-types";

import { BuildStatusBadge } from "@/components/build-status-badge";
import { buildDisplayName } from "@/lib/build-display-name";
import { formatRelativeTime } from "@/lib/format";

export interface BatchHeaderData {
  id: string;
  ciBuildId: string | null;
  number: number | null;
  name: string | null;
  branchName: string | null;
  properties: Record<string, string>;
  runCount: number;
  unresolvedCount: number;
  failedCount: number;
  passedCount: number;
  abortedCount: number;
  aggregateStatus: BuildAggregateStatus;
  createdAt: string | Date;
}

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
  return (
    <header
      id="batch-header"
      className="border-b border-zinc-200 px-4 py-4 dark:border-zinc-800"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-semibold">{buildDisplayName(build)}</h1>
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
