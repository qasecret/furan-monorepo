"use client";

import type { RunStatus } from "@furan/shared-types";
import Link from "next/link";

import { RunStatusBadge } from "@/components/run-status-badge";

interface RunRowData {
  id: string;
  branchName: string | null;
  status: RunStatus;
  diffPercent: number | null;
  pixelMisMatchCount: number | null;
  baselineSource: string | null;
  /**
   * Optional build context — decorative chip only. Not yet populated by
   * `runs.list`; the conditional render below gracefully no-ops until a
   * future PR widens the response shape (spec §3.5 / §3.8).
   */
  buildId?: string | null;
  buildName?: string | null;
  buildNumber?: number | null;
  createdAt: string | Date;
}

interface Props {
  projectId: string;
  run: RunRowData;
}

function relative(date: string | Date): string {
  const d = typeof date === "string" ? new Date(date) : date;
  const diffMs = Date.now() - d.getTime();
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return d.toLocaleDateString();
}

/**
 * Single row in the runs index table. Links the branch cell to the diff
 * viewer for the run. The viewer route is `runs/[runId]/diffs/[diffId]` —
 * v0.4 doesn't expose per-diff IDs from `runs.list`, so we reuse the runId
 * for both segments and rely on the viewer to load the first diff.
 *
 * Status renders through the shared `<RunStatusBadge>` so colour + tooltip
 * stay consistent across run-row, the runs-list filter, and ApprovalBar.
 */
export function RunRow({ projectId, run }: Props) {
  return (
    <tr
      className="border-b last:border-0 hover:bg-accent/40"
      data-testid={`run-row-${run.id}`}
    >
      <td className="py-2 pr-2">
        <Link
          href={`/projects/${projectId}/runs/${run.id}/diffs/${run.id}`}
          className="hover:underline"
        >
          {run.branchName ?? "—"}
        </Link>
        {run.buildId && (
          <Link
            href={`/projects/${projectId}/builds?expand=${run.buildId}`}
            className="ml-2 inline-flex items-center rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-600 hover:bg-neutral-200"
            data-testid={`run-build-chip-${run.id}`}
          >
            {run.buildName ??
              (run.buildNumber !== null && run.buildNumber !== undefined
                ? `#${run.buildNumber}`
                : "build")}
          </Link>
        )}
      </td>
      <td className="py-2 pr-2">
        <RunStatusBadge status={run.status} />
      </td>
      <td className="py-2 pr-2">
        {run.diffPercent !== null ? `${run.diffPercent.toFixed(2)}%` : "—"}
      </td>
      <td className="py-2 pr-2">
        {run.pixelMisMatchCount !== null
          ? run.pixelMisMatchCount.toLocaleString()
          : "—"}
      </td>
      <td className="py-2 pr-2 text-muted-foreground">
        {relative(run.createdAt)}
      </td>
    </tr>
  );
}
