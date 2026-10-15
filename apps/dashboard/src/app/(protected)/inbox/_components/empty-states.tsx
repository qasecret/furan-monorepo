"use client";

import Link from "next/link";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { buildDisplayName } from "@/lib/build-display-name";
import { buildStatusMeta } from "@/lib/build-status-meta";
import { cn } from "@/lib/cn";
import { browserEnv } from "@/lib/env";
import { formatRelativeTime } from "@/lib/format";
import { batchHref } from "@/lib/review-url";
import { FURAN_SDK_VERSION } from "@/lib/sdk-version";
import type { RouterOutputs } from "@/lib/trpc";

type BuildRow = RouterOutputs["builds"]["list"]["items"][number];

/**
 * The Batches empty states (spec §5.5). Every one names a next action: show
 * everything, clear the filters, or connect the SDK.
 */

/** "Nothing needs review.": the latest batch, if any, and a way to see the rest. */
export function NothingNeedsReview({
  projectId,
  latest,
  onShowAll,
}: {
  projectId: string;
  latest: BuildRow | undefined;
  onShowAll: () => void;
}) {
  const name =
    latest?.number != null
      ? `#${latest.number}`
      : latest && buildDisplayName(latest);
  const meta = latest ? buildStatusMeta(latest.aggregateStatus) : null;
  return (
    <div
      className="flex flex-col items-center gap-3 px-5 py-16 text-center"
      data-testid="inbox-empty-needs-review"
    >
      <p className="text-base font-medium text-fg">Nothing needs review.</p>
      {latest && meta ? (
        <Link
          // Everything, not Needs review: this batch has nothing to review.
          href={batchHref(projectId, latest.id, { status: "all" })}
          data-testid="inbox-latest-batch-link"
          className="flex items-center gap-2 rounded-md px-2 py-1 text-sm text-fg-secondary transition-colors hover:bg-hover hover:text-fg focus-ring"
        >
          <span className="text-fg-muted">Latest batch</span>
          <span className="font-medium text-fg">{name}</span>
          <span
            className={cn(
              "inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium",
              meta.pill,
            )}
          >
            {meta.word}
          </span>
          <span className="tabular-nums text-fg-muted">
            {formatRelativeTime(latest.createdAt)}
          </span>
        </Link>
      ) : null}
      <Button
        variant="secondary"
        onClick={onShowAll}
        data-testid="inbox-show-all"
      >
        Show all batches
      </Button>
    </div>
  );
}

/** A filter (or a search) that matches nothing. */
export function NoBatchesMatch({ onClear }: { onClear: () => void }) {
  return (
    <div
      className="flex flex-col items-center gap-3 px-5 py-16 text-center"
      data-testid="inbox-empty-filtered"
    >
      <p className="text-base font-medium text-fg">
        No batches match these filters.
      </p>
      <Button
        variant="secondary"
        onClick={onClear}
        data-testid="inbox-clear-filters"
      >
        Clear filters
      </Button>
    </div>
  );
}

/** No batch in the project at all: the SDK quick start and the token link. */
export function NoBatchesYet() {
  return (
    <div className="p-6" data-testid="inbox-empty-none">
      <EmptyState
        title="No batches yet"
        description={
          <>
            Connect the SDK to start sending runs.{" "}
            <code className="font-mono text-xs">
              io.github.qasecret:furan-selenium:{FURAN_SDK_VERSION}
            </code>{" "}
            · API: {browserEnv.NEXT_PUBLIC_API_URL}
          </>
        }
        action={
          <Link
            href="/account/tokens"
            className="text-brand-text hover:underline focus-ring"
            data-testid="inbox-empty-token-link"
          >
            Create a personal access token →
          </Link>
        }
      />
    </div>
  );
}
