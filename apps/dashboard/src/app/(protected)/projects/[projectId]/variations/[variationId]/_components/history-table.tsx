"use client";

import type { RunStatus } from "@furan/shared-types";
import Link from "next/link";

import { RunStatusBadge } from "@/components/run-status-badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

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
      <Table data-testid="history-table">
        <TableHeader>
          <tr>
            <TableHead>When</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Branch</TableHead>
            <TableHead>Diff %</TableHead>
            <TableHead>Mismatched px</TableHead>
            <TableHead>Promotion</TableHead>
            <TableHead>Build</TableHead>
            <TableHead>Actions</TableHead>
          </tr>
        </TableHeader>
        <TableBody>
          {items.length === 0 ? (
            <tr>
              <td colSpan={8} className="px-4 py-8 text-center text-fg-muted">
                Loading runs…
              </td>
            </tr>
          ) : (
            items.map((r) => (
              <TableRow key={r.id} data-testid={`history-row-${r.id}`}>
                <TableCell className="tabular-nums text-fg-muted">
                  {relative(r.createdAt)}
                </TableCell>
                <TableCell>
                  <RunStatusBadge status={r.status} />
                </TableCell>
                <TableCell>{r.branchName ?? "—"}</TableCell>
                <TableCell className="font-mono tabular-nums">
                  {r.diffPercent !== null
                    ? `${r.diffPercent.toFixed(2)}%`
                    : "—"}
                </TableCell>
                <TableCell className="font-mono tabular-nums">
                  {r.pixelMisMatchCount !== null
                    ? r.pixelMisMatchCount.toLocaleString()
                    : "—"}
                </TableCell>
                <TableCell>
                  {r.merge && r.baselineSource !== null ? (
                    <span
                      className="inline-flex items-center rounded-full border border-emerald-300 bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800"
                      title={`Baseline from ${r.baselineSource}`}
                      data-testid={`history-row-promotion-${r.id}`}
                    >
                      ⭐ promoted
                    </span>
                  ) : null}
                </TableCell>
                <TableCell>
                  {r.buildId && r.buildNumber !== null ? (
                    <Link
                      href={`/projects/${projectId}/builds?expand=${r.buildId}`}
                      className="tabular-nums text-brand-text hover:underline focus-ring"
                      data-testid={`history-row-build-${r.id}`}
                    >
                      #{r.buildNumber}
                    </Link>
                  ) : null}
                </TableCell>
                <TableCell>
                  <Link
                    href={`/projects/${projectId}/runs/${r.id}/diffs/${r.id}`}
                    className="text-brand-text hover:underline focus-ring"
                    data-testid={`history-row-view-diff-${r.id}`}
                  >
                    View diff →
                  </Link>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
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
