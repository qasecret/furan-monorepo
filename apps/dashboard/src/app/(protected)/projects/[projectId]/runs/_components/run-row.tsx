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
  testVariationId?: string | null;
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
      className="hover:bg-zinc-900/30 transition-colors"
      data-testid={`run-row-${run.id}`}
    >
      <td className="px-4 py-2.5">
        <Link
          href={`/projects/${projectId}/runs/${run.id}/diffs/${run.id}`}
          className="hover:underline"
        >
          {run.branchName ?? "—"}
        </Link>
        {run.buildId && (
          <Link
            href={`/projects/${projectId}/builds?expand=${run.buildId}`}
            className="ml-2 inline-flex items-center rounded-md border border-zinc-800 bg-zinc-900 px-1.5 py-0.5 text-xs text-zinc-300 hover:bg-zinc-900/70 hover:text-white transition-colors"
            data-testid={`run-build-chip-${run.id}`}
          >
            {run.buildName ??
              (run.buildNumber !== null && run.buildNumber !== undefined
                ? `#${run.buildNumber}`
                : "build")}
          </Link>
        )}
        {run.testVariationId && (
          <Link
            href={`/projects/${projectId}/variations/${run.testVariationId}`}
            className="ml-2 inline-flex items-center rounded-md border border-zinc-800 bg-zinc-900 px-1.5 py-0.5 text-xs text-zinc-300 hover:bg-zinc-900/70 hover:text-white transition-colors"
            data-testid={`run-history-chip-${run.id}`}
          >
            History
          </Link>
        )}
      </td>
      <td className="px-4 py-2.5">
        <RunStatusBadge status={run.status} />
      </td>
      <td className="px-4 py-2.5">
        {run.diffPercent !== null ? `${run.diffPercent.toFixed(2)}%` : "—"}
      </td>
      <td className="px-4 py-2.5">
        {run.pixelMisMatchCount !== null
          ? run.pixelMisMatchCount.toLocaleString()
          : "—"}
      </td>
      <td className="px-4 py-2.5 text-zinc-500">{relative(run.createdAt)}</td>
    </tr>
  );
}
