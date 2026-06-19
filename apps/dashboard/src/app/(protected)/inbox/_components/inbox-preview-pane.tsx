"use client";

import type { InboxRunRow } from "@furan/shared-types";
import Link from "next/link";

import { StatusPill } from "@/components/triage/status-pill";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { plural } from "@/lib/format";
import { trpc } from "@/lib/trpc";

interface Props {
  run: InboxRunRow | undefined;
  onApprove: () => void;
  onReject: () => void;
  isActing: boolean;
}

/**
 * Right-hand preview for the inbox list-detail. The header + image come from the
 * selected row (instant, no fetch — thumbnailUrl is the only directly-renderable
 * image; the diff overlay is a storage key behind auth, so it stays in the full
 * viewer). runs.getById supplies only the stat chips.
 */
export function InboxPreviewPane({
  run,
  onApprove,
  onReject,
  isActing,
}: Props) {
  const detail = trpc.runs.getById.useQuery(
    { runId: run?.runId ?? "" },
    { enabled: !!run },
  );

  if (!run) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <EmptyState
          title="Select a run to preview"
          description="Pick a run from the queue to see its change here — click a row or use J/K."
        />
      </div>
    );
  }

  const diffHref = `/projects/${run.projectId}/runs/${run.runId}/diffs/${run.runId}`;

  return (
    <div
      data-testid="inbox-preview-detail"
      className="flex flex-1 flex-col overflow-y-auto p-6"
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h2 className="truncate text-lg font-semibold text-zinc-950 dark:text-white">
            {run.variationName}
          </h2>
          <StatusPill status={run.status} />
        </div>
        <p className="mt-0.5 truncate text-sm text-zinc-600 dark:text-zinc-400">
          {run.projectName} ·{" "}
          {run.buildNumber !== null ? `Build #${run.buildNumber}` : "Build"} ·{" "}
          {run.branch ?? "—"}
        </p>
      </div>

      <div className="mt-4">
        {run.thumbnailUrl !== null ? (
          <img
            src={run.thumbnailUrl}
            alt=""
            loading="lazy"
            className="max-h-[420px] w-full rounded-lg border border-zinc-200 object-contain dark:border-zinc-800"
          />
        ) : (
          <div
            className={cn(
              "flex h-64 w-full items-center justify-center rounded-lg border text-sm text-zinc-500",
              "border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950",
            )}
            aria-hidden
          >
            No preview image
          </div>
        )}
      </div>

      <div className="mt-4 min-h-[2rem]">
        {detail.isLoading ? (
          <div className="flex gap-3">
            <Skeleton className="h-7 w-28" />
            <Skeleton className="h-7 w-24" />
          </div>
        ) : detail.isError ? (
          <p className="text-sm text-red-600 dark:text-red-400">
            Couldn&apos;t load run details.
          </p>
        ) : detail.data ? (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            {detail.data.diffPercent !== null &&
              detail.data.diffPercent !== undefined && (
                <span className="rounded-md bg-zinc-100 px-2 py-1 font-medium text-zinc-800 dark:bg-zinc-900 dark:text-zinc-200">
                  {detail.data.diffPercent.toFixed(2)}% changed
                </span>
              )}
            <span className="rounded-md bg-zinc-100 px-2 py-1 font-medium text-zinc-800 dark:bg-zinc-900 dark:text-zinc-200">
              {detail.data.diffRegions.length} region
              {plural(detail.data.diffRegions.length)}
            </span>
          </div>
        ) : null}
      </div>

      <div className="mt-6 flex items-center gap-2">
        <Button onClick={onApprove} disabled={isActing}>
          Approve
        </Button>
        <Button variant="secondary" onClick={onReject} disabled={isActing}>
          Reject
        </Button>
        <Link
          href={diffHref}
          className="ml-auto rounded-md border border-zinc-200 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-900"
        >
          Open full diff
        </Link>
      </div>
    </div>
  );
}
