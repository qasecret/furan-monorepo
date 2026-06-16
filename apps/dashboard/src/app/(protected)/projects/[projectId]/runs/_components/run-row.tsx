"use client";

import type { RunStatus } from "@furan/shared-types";
import { Check, GitBranch, History as HistoryIcon, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { CheckpointStrip } from "./checkpoint-strip";

import {
  STATUS_ACCENT,
  STATUS_CONFIG,
  STATUS_STRIPE,
} from "@/components/run-status-badge";
import { cn } from "@/lib/cn";
import { formatRelativeTime } from "@/lib/format";

export interface RunRowData {
  id: string;
  branchName: string | null;
  status: RunStatus;
  diffPercent: number | null;
  pixelMisMatchCount: number | null;
  baselineSource: string | null;
  /** ADR-038: test name for this run (populated by `runs.list`). */
  name?: string | null;
  /** ADR-038: number of checkpoints in this run. */
  checkpointCount?: number | null;
  /** Representative screenshot for the run, when the worker recorded one. */
  thumbnailUrl?: string | null;
  buildId?: string | null;
  buildName?: string | null;
  buildNumber?: number | null;
  testVariationId?: string | null;
  createdAt: string | Date;
}

interface Props {
  projectId: string;
  run: RunRowData;
  /** Whether the viewer can approve/reject (editor or admin). */
  canReview?: boolean;
  onApprove?: (runId: string) => void;
  onReject?: (runId: string) => void;
}

/** Statuses a reviewer acts on from the list. */
function isReviewable(status: RunStatus): boolean {
  return status === "unresolved" || status === "failed";
}

/**
 * Single row in the runs index. Three columns — Test · Change · When — with
 * status carried by a left colour stripe plus a text label in the meta line.
 * When the run needs review and the viewer can act, Approve/Reject buttons
 * reveal on row hover (mirrors the inbox triage row). The row links to the
 * diff viewer; the caret expands an inline checkpoint strip.
 */
export function RunRow({
  projectId,
  run,
  canReview,
  onApprove,
  onReject,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const router = useRouter();

  const diffUrl = `/projects/${projectId}/runs/${run.id}/checkpoints/_first`;
  const INTERACTIVE = "a, button, input, select, textarea, [role='button']";
  const showActions =
    canReview && isReviewable(run.status) && !!onApprove && !!onReject;

  const handleRowClick = (e: React.MouseEvent<HTMLTableRowElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest(INTERACTIVE)) return;
    if (e.metaKey || e.ctrlKey || e.button === 1) {
      window.open(diffUrl, "_blank", "noopener");
      return;
    }
    router.push(diffUrl);
  };

  const checkpointLabel =
    run.checkpointCount != null
      ? `${run.checkpointCount} checkpoint${run.checkpointCount === 1 ? "" : "s"}`
      : "—";

  return (
    <>
      <tr
        className="group cursor-pointer transition-colors hover:bg-zinc-100/60 dark:hover:bg-zinc-900/30"
        data-testid={`queue-row-${run.id}`}
        onClick={handleRowClick}
        aria-label={`Open run ${run.name ?? run.branchName ?? run.id}`}
        tabIndex={0}
        onKeyDown={(e) => {
          if ((e.target as HTMLElement).closest(INTERACTIVE)) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            router.push(diffUrl);
          }
        }}
      >
        <td
          className={cn(
            "border-l-2 py-2.5 pl-3 pr-4",
            STATUS_STRIPE[run.status],
          )}
        >
          <div className="flex min-w-0 items-center gap-1.5">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setExpanded((v) => !v);
              }}
              aria-expanded={expanded}
              aria-label={
                expanded ? "Collapse checkpoints" : "Expand checkpoints"
              }
              className="flex-none text-zinc-400 transition-colors hover:text-zinc-700 dark:hover:text-zinc-300"
              data-testid={`expand-checkpoints-${run.id}`}
            >
              <span
                className={cn(
                  "inline-block text-xs transition-transform",
                  expanded && "rotate-90",
                )}
              >
                ▶
              </span>
            </button>
            {run.thumbnailUrl ? (
              <img
                src={run.thumbnailUrl}
                alt=""
                loading="lazy"
                className="h-7 w-11 flex-none rounded border border-zinc-200 object-cover dark:border-zinc-800"
                data-testid={`run-thumb-${run.id}`}
              />
            ) : null}
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <GitBranch
                className="h-3.5 w-3.5 flex-none text-zinc-500 dark:text-zinc-400"
                aria-hidden
              />
              <Link
                href={diffUrl}
                className="truncate hover:underline"
                aria-label={`Open diff viewer for run on branch ${run.branchName ?? "(unknown)"}`}
              >
                {run.branchName ?? "—"}
              </Link>
              {run.name ? (
                <>
                  <span className="text-zinc-400">·</span>
                  <span className="truncate font-medium text-zinc-700 dark:text-zinc-300">
                    {run.name}
                  </span>
                </>
              ) : null}
            </span>
            {run.testVariationId ? (
              <Link
                href={`/projects/${projectId}/variations/${run.testVariationId}`}
                className="ml-1 inline-flex flex-none items-center gap-1 rounded-md border border-zinc-200 bg-zinc-50 px-1.5 py-0.5 text-xs text-zinc-700 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-900/70 dark:hover:text-white"
                data-testid={`run-history-chip-${run.id}`}
                aria-label="View baseline history for this test"
              >
                <HistoryIcon className="h-3 w-3" aria-hidden />
                History
              </Link>
            ) : null}
          </div>
          <div className="mt-1 flex items-center gap-1.5 pl-[1.375rem] text-xs text-zinc-500 dark:text-zinc-500">
            <span className="tabular-nums">{checkpointLabel}</span>
            <span aria-hidden>·</span>
            <span data-testid={`run-status-label-${run.status}`}>
              {STATUS_CONFIG[run.status].label}
            </span>
          </div>
        </td>
        <td className="px-4 py-2.5 text-right align-middle">
          {run.diffPercent !== null ? (
            <div>
              <div
                className={cn(
                  "font-medium tabular-nums",
                  STATUS_ACCENT[run.status],
                )}
              >
                {run.diffPercent.toFixed(2)}%
              </div>
              {run.pixelMisMatchCount !== null ? (
                <div className="text-xs tabular-nums text-zinc-500">
                  {run.pixelMisMatchCount.toLocaleString()} px
                </div>
              ) : null}
            </div>
          ) : run.status === "passed" ? (
            <span className="text-zinc-500">no change</span>
          ) : (
            <span className="text-zinc-400 dark:text-zinc-600">—</span>
          )}
        </td>
        <td className="whitespace-nowrap px-4 py-2.5 align-middle text-zinc-500">
          <div className="flex items-center justify-end gap-1">
            {showActions ? (
              <span className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onApprove?.(run.id);
                  }}
                  title="Approve"
                  aria-label={`Approve run ${run.name ?? run.id}`}
                  data-testid={`approve-run-${run.id}`}
                  className="rounded p-1 text-green-600 transition-colors hover:bg-green-500/10 dark:text-green-400"
                >
                  <Check className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onReject?.(run.id);
                  }}
                  title="Reject"
                  aria-label={`Reject run ${run.name ?? run.id}`}
                  data-testid={`reject-run-${run.id}`}
                  className="rounded p-1 text-red-600 transition-colors hover:bg-red-500/10 dark:text-red-400"
                >
                  <X className="h-4 w-4" />
                </button>
              </span>
            ) : null}
            <span>{formatRelativeTime(run.createdAt)}</span>
          </div>
        </td>
      </tr>
      {expanded ? (
        <tr data-testid={`checkpoint-strip-row-${run.id}`}>
          <td colSpan={3} className="px-4 pb-2 pt-0">
            <CheckpointStrip projectId={projectId} runId={run.id} />
          </td>
        </tr>
      ) : null}
    </>
  );
}
