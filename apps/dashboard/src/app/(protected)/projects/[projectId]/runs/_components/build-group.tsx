"use client";

import type { RunStatus } from "@furan/shared-types";
import { Check, GitBranch, Package } from "lucide-react";
import { useState } from "react";

import { RunRow, type RunRowData } from "./run-row";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { buildDisplayName } from "@/lib/build-display-name";
import { cn } from "@/lib/cn";
import { formatRelativeTime } from "@/lib/format";

export interface BuildGroupData {
  buildId: string | null;
  buildName: string | null;
  buildNumber: number | null;
  buildCiBuildId: string | null;
  buildBranchName: string | null;
  buildCreatedAt: string | Date | null;
  runs: RunRowData[];
}

interface Props {
  projectId: string;
  group: BuildGroupData;
  canReview?: boolean;
  onApprove?: (runId: string) => void;
  onReject?: (runId: string) => void;
  onApproveBuild?: (buildId: string) => void;
}

// Reviewer-attention order; status enum values double as the display words.
const SUMMARY_ORDER: readonly RunStatus[] = [
  "unresolved",
  "failed",
  "aborted",
  "running",
  "new",
  "passed",
  "empty",
];

function summarize(runs: RunRowData[]): string {
  const counts = new Map<RunStatus, number>();
  for (const r of runs) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
  const parts = SUMMARY_ORDER.filter((s) => (counts.get(s) ?? 0) > 0).map(
    (s) => `${counts.get(s)} ${s}`,
  );
  return (
    parts.join(" · ") || `${runs.length} run${runs.length === 1 ? "" : "s"}`
  );
}

/**
 * One build's runs, rendered as a collapsible `<tbody>` (the Applitools batch
 * model). The header summarises the build and, when the viewer can review and
 * the build has runs awaiting review, offers an "Approve all" action that
 * approves the WHOLE build server-side (not just the loaded page).
 */
export function BuildGroup({
  projectId,
  group,
  canReview,
  onApprove,
  onReject,
  onApproveBuild,
}: Props) {
  const [expanded, setExpanded] = useState(true);
  const branch = group.buildBranchName ?? group.runs[0]?.branchName ?? null;
  const time = formatRelativeTime(
    group.buildCreatedAt ?? group.runs[0]?.createdAt ?? null,
  );
  const key = group.buildId ?? "none";
  const hasReviewable = group.runs.some(
    (r) => r.status === "unresolved" || r.status === "failed",
  );

  return (
    <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
      <tr className="bg-zinc-100/70 dark:bg-zinc-900/40">
        <td colSpan={3} className="px-3 py-2">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
              data-testid={`build-group-${key}`}
              className="flex min-w-0 flex-1 items-center gap-2 text-left"
            >
              <span
                className={cn(
                  "inline-block flex-none text-xs text-zinc-400 transition-transform",
                  expanded && "rotate-90",
                )}
                aria-hidden
              >
                ▶
              </span>
              <Package
                className="h-3.5 w-3.5 flex-none text-zinc-500 dark:text-zinc-400"
                aria-hidden
              />
              <span className="font-medium text-zinc-900 dark:text-zinc-100">
                {buildDisplayName({
                  name: group.buildName,
                  number: group.buildNumber,
                  ciBuildId: group.buildCiBuildId,
                  id: group.buildId,
                })}
              </span>
              {branch ? (
                <span className="inline-flex items-center gap-1 text-xs text-zinc-500 dark:text-zinc-500">
                  <GitBranch className="h-3 w-3" aria-hidden />
                  {branch}
                </span>
              ) : null}
              <span className="truncate text-xs text-zinc-500 dark:text-zinc-400">
                {summarize(group.runs)}
              </span>
            </button>
            {time ? (
              <span className="flex-none whitespace-nowrap text-xs text-zinc-500">
                {time}
              </span>
            ) : null}
            {canReview && hasReviewable && group.buildId && onApproveBuild ? (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <button
                    type="button"
                    data-testid={`approve-build-${key}`}
                    className="inline-flex flex-none items-center gap-1 rounded-md border border-green-500/30 px-2 py-1 text-xs font-medium text-green-700 transition-colors hover:bg-green-500/10 dark:text-green-400"
                  >
                    <Check className="h-3.5 w-3.5" aria-hidden />
                    Approve all
                  </button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      Approve all runs awaiting review in this build?
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      This approves every unresolved/failed run in the build —
                      including any not yet loaded on this page — promoting each
                      run&apos;s current screenshots as the new baseline for its
                      branch. You can&apos;t undo this from here.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      data-testid={`approve-build-confirm-${key}`}
                      onClick={() => onApproveBuild(group.buildId!)}
                    >
                      Approve all
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            ) : null}
          </div>
        </td>
      </tr>
      {expanded
        ? group.runs.map((r) => (
            <RunRow
              key={r.id}
              projectId={projectId}
              run={r}
              canReview={canReview}
              onApprove={onApprove}
              onReject={onReject}
            />
          ))
        : null}
    </tbody>
  );
}
