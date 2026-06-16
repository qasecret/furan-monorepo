"use client";

import type { BuildAggregateStatus } from "@furan/shared-types";

import { BuildStatusBadge } from "@/components/build-status-badge";
import { Badge } from "@/components/ui/badge";
import { buildDisplayName } from "@/lib/build-display-name";

export interface BuildRowData {
  id: string;
  ciBuildId: string | null;
  number: number | null;
  branchName: string | null;
  name: string | null;
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
  build: BuildRowData;
  expanded: boolean;
  onToggleExpand: () => void;
  onPropertyClick: (key: string, value: string) => void;
}

function relative(date: string | Date): string {
  const d = typeof date === "string" ? new Date(date) : date;
  const sec = Math.floor((Date.now() - d.getTime()) / 1000);
  if (sec < 60) return "just now";
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  if (sec < 86400 * 30) return `${Math.floor(sec / 86400)}d ago`;
  return d.toLocaleDateString();
}

export function BuildRow({
  build,
  expanded,
  onToggleExpand,
  onPropertyClick,
}: Props) {
  const propEntries = Object.entries(build.properties);
  const visibleProps = propEntries.slice(0, 5);
  const overflow = propEntries.length - visibleProps.length;
  const summary =
    [
      build.passedCount > 0 && `${build.passedCount} passed`,
      build.unresolvedCount > 0 && `${build.unresolvedCount} unresolved`,
      build.failedCount > 0 && `${build.failedCount} failed`,
      build.abortedCount > 0 && `${build.abortedCount} aborted`,
    ]
      .filter(Boolean)
      .join(" · ") || `${build.runCount} runs`;

  return (
    <div
      className="border-b border-zinc-200 last:border-0 px-4 py-3 hover:bg-zinc-100/60 transition-colors cursor-pointer dark:border-zinc-800 dark:hover:bg-zinc-900/30"
      onClick={onToggleExpand}
      data-testid={`build-row-${build.id}`}
    >
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex flex-col min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-medium">{buildDisplayName(build)}</span>
            <BuildStatusBadge status={build.aggregateStatus} />
            {build.branchName && (
              <span className="text-xs text-zinc-500 dark:text-zinc-500">
                {build.branchName}
              </span>
            )}
          </div>
          <div className="text-xs text-zinc-600 mt-0.5 dark:text-zinc-400">
            {summary}
          </div>
        </div>
        <div className="flex flex-wrap gap-1 max-w-md">
          {visibleProps.map(([k, v]) => (
            <Badge
              key={k}
              variant="outline"
              className="text-xs cursor-pointer"
              onClick={(e) => {
                e.stopPropagation();
                onPropertyClick(k, v);
              }}
              data-testid={`build-property-${k}`}
            >
              {k}={v}
            </Badge>
          ))}
          {overflow > 0 && (
            <Badge
              variant="outline"
              className="text-xs"
              title={propEntries.map(([k, v]) => `${k}=${v}`).join(", ")}
            >
              +{overflow} more
            </Badge>
          )}
        </div>
        <div className="text-xs text-zinc-500 whitespace-nowrap dark:text-zinc-500">
          {relative(build.createdAt)}
        </div>
        <span aria-hidden className="text-zinc-500 dark:text-zinc-500">
          {expanded ? "▾" : "▸"}
        </span>
      </div>
    </div>
  );
}
