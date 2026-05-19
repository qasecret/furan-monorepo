"use client";

import type { BuildAggregateStatus } from "@furan/shared-types";

import { BuildStatusBadge } from "@/components/build-status-badge";
import { Badge } from "@/components/ui/badge";

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

/**
 * Display priority for a build's title: explicit `name` (set via SDK) →
 * `#<number>` (the per-project monotonic counter) → first 12 chars of the
 * `ciBuildId` → `(unnamed)`. Matches spec §3.8 acceptance.
 */
function displayName(b: BuildRowData): string {
  if (b.name) return b.name;
  if (b.number !== null) return `#${b.number}`;
  if (b.ciBuildId) return b.ciBuildId.slice(0, 12);
  return "(unnamed)";
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
      className="border-b last:border-0 px-4 py-3 hover:bg-accent/40 cursor-pointer"
      onClick={onToggleExpand}
      data-testid={`build-row-${build.id}`}
    >
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex flex-col min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-medium">{displayName(build)}</span>
            <BuildStatusBadge status={build.aggregateStatus} />
            {build.branchName && (
              <span className="text-xs text-neutral-500">
                {build.branchName}
              </span>
            )}
          </div>
          <div className="text-xs text-neutral-600 mt-0.5">{summary}</div>
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
        <div className="text-xs text-neutral-500 whitespace-nowrap">
          {relative(build.createdAt)}
        </div>
        <span aria-hidden className="text-neutral-400">
          {expanded ? "▾" : "▸"}
        </span>
      </div>
    </div>
  );
}
