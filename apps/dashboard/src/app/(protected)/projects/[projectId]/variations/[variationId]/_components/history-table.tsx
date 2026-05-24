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
      <div className="rounded-xl border border-zinc-800 bg-zinc-950 overflow-hidden">
        <table className="w-full text-sm" data-testid="history-table">
          <thead className="bg-zinc-900/50 border-b border-zinc-800 text-zinc-400 text-left">
            <tr>
              <th className="px-4 py-2.5 font-medium">When</th>
              <th className="px-4 py-2.5 font-medium">Status</th>
              <th className="px-4 py-2.5 font-medium">Branch</th>
              <th className="px-4 py-2.5 font-medium">Diff %</th>
              <th className="px-4 py-2.5 font-medium">Mismatched px</th>
              <th className="px-4 py-2.5 font-medium">Promotion</th>
              <th className="px-4 py-2.5 font-medium">Build</th>
              <th className="px-4 py-2.5 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800">
            {items.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-zinc-500">
                  Loading runs…
                </td>
              </tr>
            ) : (
              items.map((r) => (
                <tr
                  key={r.id}
                  className="hover:bg-zinc-900/30 transition-colors"
                  data-testid={`history-row-${r.id}`}
                >
                  <td className="px-4 py-2.5 text-zinc-500">
                    {relative(r.createdAt)}
                  </td>
                  <td className="px-4 py-2.5">
                    <RunStatusBadge status={r.status} />
                  </td>
                  <td className="px-4 py-2.5">{r.branchName ?? "—"}</td>
                  <td className="px-4 py-2.5">
                    {r.diffPercent !== null
                      ? `${r.diffPercent.toFixed(2)}%`
                      : "—"}
                  </td>
                  <td className="px-4 py-2.5">
                    {r.pixelMisMatchCount !== null
                      ? r.pixelMisMatchCount.toLocaleString()
                      : "—"}
                  </td>
                  <td className="px-4 py-2.5">
                    {r.merge && r.baselineSource !== null ? (
                      <span
                        className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                        title={`Baseline from ${r.baselineSource}`}
                        data-testid={`history-row-promotion-${r.id}`}
                      >
                        ⭐ promoted
                      </span>
                    ) : null}
                  </td>
                  <td className="px-4 py-2.5">
                    {r.buildId && r.buildNumber !== null ? (
                      <Link
                        href={`/projects/${projectId}/builds?expand=${r.buildId}`}
                        className="text-brand hover:underline"
                        data-testid={`history-row-build-${r.id}`}
                      >
                        #{r.buildNumber}
                      </Link>
                    ) : null}
                  </td>
                  <td className="px-4 py-2.5">
                    <Link
                      href={`/projects/${projectId}/runs/${r.id}/diffs/${r.id}`}
                      className="text-brand hover:underline"
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
      </div>
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
