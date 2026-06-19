"use client";

import type { InboxRunRow } from "@furan/shared-types";
import Link from "next/link";

import { StatusPill } from "@/components/triage/status-pill";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/cn";
import { diffViewerHref } from "@/lib/diff-viewer-href";

interface Props {
  run: InboxRunRow | undefined;
  onApprove: () => void;
  onReject: () => void;
  isActing: boolean;
}

/**
 * Right-hand preview for the inbox list-detail. Intentionally lean and
 * fetch-free: the header + candidate image come straight from the selected row
 * (thumbnailUrl is already a signed URL). Diff %/region detail and the full
 * overlay live one click away in the diff viewer.
 *
 * The preview deliberately does NOT call runs.getById. The inbox page already
 * holds one long-lived SSE connection per project (InboxRealtime); on an org
 * with more than a handful of projects those streams saturate the browser's
 * per-origin connection limit, so a per-selection getById would queue behind
 * them indefinitely. Keeping the preview fetch-free makes it instant and
 * immune to that starvation.
 */
export function InboxPreviewPane({
  run,
  onApprove,
  onReject,
  isActing,
}: Props) {
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

  const diffHref = diffViewerHref(run.projectId, run.runId);

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

      <div className="mt-6 flex items-center gap-2">
        <Button onClick={onApprove} disabled={isActing}>
          Approve
        </Button>
        <Button variant="secondary" onClick={onReject} disabled={isActing}>
          Reject
        </Button>
        <Button variant="secondary" asChild className="ml-auto">
          <Link href={diffHref}>Open full diff</Link>
        </Button>
      </div>
    </div>
  );
}
