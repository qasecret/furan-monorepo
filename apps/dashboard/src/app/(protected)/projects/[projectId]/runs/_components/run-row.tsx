"use client";

import type { RunStatus } from "@furan/shared-types";
import { GitBranch, History as HistoryIcon, Package } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { CheckpointStrip } from "./checkpoint-strip";

import { RunStatusBadge } from "@/components/run-status-badge";

interface RunRowData {
  id: string;
  branchName: string | null;
  status: RunStatus;
  diffPercent: number | null;
  pixelMisMatchCount: number | null;
  baselineSource: string | null;
  /**
   * ADR-038: test name for this run (populated by `runs.list`).
   */
  name?: string | null;
  /**
   * ADR-038: number of checkpoints in this run.
   */
  checkpointCount?: number | null;
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
 * viewer for the run. The viewer route is `runs/[runId]/checkpoints/_first`
 * (ADR-038) which redirects to the first checkpoint.
 *
 * Status renders through the shared `<RunStatusBadge>` so colour + tooltip
 * stay consistent across run-row, the runs-list filter, and ApprovalBar.
 */
export function RunRow({ projectId, run }: Props) {
  const [expanded, setExpanded] = useState(false);

  return (
    <>
      <tr
        className="hover:bg-zinc-100/60 transition-colors dark:hover:bg-zinc-900/30"
        data-testid={`queue-row-${run.id}`}
      >
        <td className="px-4 py-2.5">
          {/*
            Three sibling links live in the same cell: the branch link
            (primary — opens the diff viewer), a build chip, and a history
            chip. Without explicit aria-labels each link's accessible name
            was just its visible text — "main", "build", "History" — and a
            screen reader read the cell as the phrase "main build
            History". The labels below name each link in terms of what it
            does, leaving the cell's text content intact for visual users.
          */}
          <div className="flex items-center gap-1.5">
            {/* ADR-038: chevron to expand the per-checkpoint strip */}
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
              aria-label={
                expanded ? "Collapse checkpoints" : "Expand checkpoints"
              }
              className="flex-none text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300 transition-colors"
              data-testid={`expand-checkpoints-${run.id}`}
            >
              <span
                className={`inline-block transition-transform text-xs ${expanded ? "rotate-90" : ""}`}
              >
                ▶
              </span>
            </button>
            <span className="inline-flex items-center gap-1.5">
              <GitBranch
                className="h-3.5 w-3.5 text-zinc-500 dark:text-zinc-400"
                aria-hidden
              />
              <Link
                href={`/projects/${projectId}/runs/${run.id}/checkpoints/_first`}
                className="hover:underline"
                aria-label={`Open diff viewer for run on branch ${run.branchName ?? "(unknown)"}`}
              >
                {run.branchName ?? "—"}
              </Link>
              {run.name && (
                <>
                  <span className="text-zinc-500">·</span>
                  <span className="font-medium text-zinc-700 dark:text-zinc-300">
                    {run.name}
                  </span>
                </>
              )}
            </span>
            {run.buildId && (
              <Link
                href={`/projects/${projectId}/builds?expand=${run.buildId}`}
                className="ml-2 inline-flex items-center gap-1 rounded-md border border-zinc-200 bg-zinc-50 px-1.5 py-0.5 text-xs text-zinc-700 hover:bg-zinc-100 hover:text-zinc-900 transition-colors dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-900/70 dark:hover:text-white"
                data-testid={`run-build-chip-${run.id}`}
                aria-label={`Open build ${
                  run.buildName ??
                  (run.buildNumber !== null && run.buildNumber !== undefined
                    ? `#${run.buildNumber}`
                    : "for this run")
                }`}
              >
                <Package className="h-3 w-3" aria-hidden />
                {run.buildName ??
                  (run.buildNumber !== null && run.buildNumber !== undefined
                    ? `#${run.buildNumber}`
                    : "build")}
              </Link>
            )}
            {run.testVariationId && (
              <Link
                href={`/projects/${projectId}/variations/${run.testVariationId}`}
                className="ml-2 inline-flex items-center gap-1 rounded-md border border-zinc-200 bg-zinc-50 px-1.5 py-0.5 text-xs text-zinc-700 hover:bg-zinc-100 hover:text-zinc-900 transition-colors dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-900/70 dark:hover:text-white"
                data-testid={`run-history-chip-${run.id}`}
                aria-label="View baseline history for this test"
              >
                <HistoryIcon className="h-3 w-3" aria-hidden />
                History
              </Link>
            )}
          </div>
        </td>
        <td className="px-4 py-2.5">
          <RunStatusBadge status={run.status} />
        </td>
        {/* ADR-038: checkpoint count */}
        <td className="px-4 py-2.5 text-zinc-600 dark:text-zinc-400">
          {run.checkpointCount != null ? `${run.checkpointCount} chk` : "—"}
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
      {expanded ? (
        <tr data-testid={`checkpoint-strip-row-${run.id}`}>
          <td colSpan={6} className="px-4 pb-2 pt-0">
            <CheckpointStrip projectId={projectId} runId={run.id} />
          </td>
        </tr>
      ) : null}
    </>
  );
}
