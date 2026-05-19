"use client";

import type { RunStatus } from "@furan/shared-types";
import Link from "next/link";

import { RunStatusBadge } from "@/components/run-status-badge";
import { Button } from "@/components/ui/button";

export interface HistoryItem {
  id: string;
  status: RunStatus;
  branchName: string | null;
  diffPercent: number | null;
  pixelMisMatchCount: number | null;
  merge: boolean;
  baselineSource: string | null;
  buildId: string | null;
  buildNumber: number | null;
  createdAt: string | Date;
}

interface Props {
  projectId: string;
  items: ReadonlyArray<HistoryItem>;
  nextCursor: string | null;
  onLoadMore: () => void;
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

export function HistoryTable({
  projectId,
  items,
  nextCursor,
  onLoadMore,
}: Props) {
  return (
    <div className="space-y-3">
      <table
        className="w-full text-sm border-collapse"
        data-testid="history-table"
      >
        <thead className="text-left text-muted-foreground border-b">
          <tr>
            <th className="py-2 pr-2">When</th>
            <th className="py-2 pr-2">Status</th>
            <th className="py-2 pr-2">Branch</th>
            <th className="py-2 pr-2">Diff %</th>
            <th className="py-2 pr-2">Mismatched px</th>
            <th className="py-2 pr-2">Promotion</th>
            <th className="py-2 pr-2">Build</th>
            <th className="py-2 pr-2">Actions</th>
          </tr>
        </thead>
        <tbody>
          {items.length === 0 ? (
            <tr>
              <td
                colSpan={8}
                className="py-6 text-center text-muted-foreground"
              >
                Loading runs…
              </td>
            </tr>
          ) : (
            items.map((r) => (
              <tr
                key={r.id}
                className="border-b last:border-0"
                data-testid={`history-row-${r.id}`}
              >
                <td className="py-2 pr-2 text-muted-foreground">
                  {relative(r.createdAt)}
                </td>
                <td className="py-2 pr-2">
                  <RunStatusBadge status={r.status} />
                </td>
                <td className="py-2 pr-2">{r.branchName ?? "—"}</td>
                <td className="py-2 pr-2">
                  {r.diffPercent !== null
                    ? `${r.diffPercent.toFixed(2)}%`
                    : "—"}
                </td>
                <td className="py-2 pr-2">
                  {r.pixelMisMatchCount !== null
                    ? r.pixelMisMatchCount.toLocaleString()
                    : "—"}
                </td>
                <td className="py-2 pr-2">
                  {r.merge && r.baselineSource !== null ? (
                    <span
                      className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium bg-emerald-100 text-emerald-800 border-emerald-300"
                      title={`Baseline from ${r.baselineSource}`}
                      data-testid={`history-row-promotion-${r.id}`}
                    >
                      ⭐ promoted
                    </span>
                  ) : null}
                </td>
                <td className="py-2 pr-2">
                  {r.buildId && r.buildNumber !== null ? (
                    <Link
                      href={`/projects/${projectId}/builds?expand=${r.buildId}`}
                      className="text-blue-700 hover:underline"
                      data-testid={`history-row-build-${r.id}`}
                    >
                      #{r.buildNumber}
                    </Link>
                  ) : null}
                </td>
                <td className="py-2 pr-2">
                  <Link
                    href={`/projects/${projectId}/runs/${r.id}/diffs/${r.id}`}
                    className="text-blue-700 hover:underline"
                    data-testid={`history-row-view-diff-${r.id}`}
                  >
                    View diff →
                  </Link>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
      {nextCursor && (
        <div className="flex justify-center">
          <Button
            variant="secondary"
            onClick={onLoadMore}
            data-testid="history-load-more"
          >
            Load more
          </Button>
        </div>
      )}
    </div>
  );
}
