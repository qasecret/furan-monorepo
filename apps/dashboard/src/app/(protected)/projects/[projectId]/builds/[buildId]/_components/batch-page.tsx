"use client";

import { keepPreviousData } from "@tanstack/react-query";
import Link from "next/link";
import { notFound, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { ApprovePendingDialog } from "./approve-pending-dialog";
import { BatchHeader } from "./batch-header";
import { ContextualToolbar, type ResultView } from "./contextual-toolbar";
import { FacetSelects } from "./facet-selects";
import { RESULT_GRID, RunResults } from "./run-results";

import { Button } from "@/components/ui/button";
import { PageContainer } from "@/components/ui/page-container";
import { Skeleton } from "@/components/ui/skeleton";
import { useProjectEvents } from "@/hooks/useProjectEvents";
import { cn } from "@/lib/cn";
import { diffViewerHref } from "@/lib/diff-viewer-href";
import {
  batchHref,
  DEFAULT_REVIEW_STATUS,
  parseReviewContext,
  serializeReviewContext,
  toRunsListFilter,
  useReviewContext,
  type ReviewContext,
} from "@/lib/review-url";
import { trpc, type RouterOutputs } from "@/lib/trpc";

type RunRow = RouterOutputs["runs"]["list"]["items"][number];
type NextBatch = NonNullable<RouterOutputs["review"]["next"]["nextBatch"]>;

/**
 * "Back to batch" loads pages until the run it names is in the list, but no
 * more than this many (the first included): a run that is not in the filter
 * at all (it was fully decided in the viewer, say) would otherwise pull in a
 * whole large batch looking for it.
 */
const MAX_ANCHOR_PAGES = 10;

/** The run id a `#run-<id>` hash names, or null for any other hash. */
function runIdFromHash(hash: string): string | null {
  if (!hash.startsWith("#run-") || hash.length === "#run-".length) return null;
  try {
    return decodeURIComponent(hash.slice("#run-".length));
  } catch {
    return null;
  }
}

interface Props {
  projectId: string;
  buildId: string;
  canReview: boolean;
  /**
   * The review context the server parsed from the request's search params
   * (spec §3.3). The URL is the source of truth: a chip or a facet writes it
   * (through `useReviewContext`) and the server hands the new context back.
   */
  context: ReviewContext;
}

/** The pages of the run list loaded so far, and the filter they were loaded under. */
interface Paging {
  key: string;
  cursor: string | undefined;
  /** Pages loaded, the first included. */
  pages: number;
  accumulated: RunRow[];
}

const firstPage = (key: string): Paging => ({
  key,
  cursor: undefined,
  pages: 1,
  accumulated: [],
});

export function BatchPage({ projectId, buildId, canReview, context }: Props) {
  useProjectEvents(projectId);
  const router = useRouter();
  const utils = trpc.useUtils();
  const [, setContext] = useReviewContext();

  // The part of the context that scopes the list and travels the loop (status
  // and facets), as one object for as long as it is the same: the rows and the
  // step cards are memoized on it, and a decision must not redraw them.
  const filterKey = serializeReviewContext(context, ["status", "facets"]);
  const ctx = useMemo(
    () => parseReviewContext(new URLSearchParams(filterKey)),
    [filterKey],
  );
  const hasFacets = Object.keys(ctx.facets).length > 0;

  const [view, setView] = useState<ResultView>("list");
  // The pages loaded so far, for the filter they were loaded under: any change
  // of it (a chip, a facet, Back / Forward) starts the pages over.
  const [paging, setPaging] = useState<Paging>(() => firstPage(filterKey));
  let pageState = paging;
  if (paging.key !== filterKey) {
    // Adjusting state while rendering: React re-renders at once, before paint.
    pageState = firstPage(filterKey);
    setPaging(pageState);
  }

  const buildQ = trpc.builds.getById.useQuery({ buildId });
  const list = trpc.runs.list.useQuery(
    {
      projectId,
      buildId,
      // The order the suite ran in, which is the order the review loop walks.
      order: "capture",
      ...toRunsListFilter(ctx),
      cursor: pageState.cursor,
    },
    // The previous filter's page stays in view until the new one answers.
    { placeholderData: keepPreviousData },
  );

  // Where the review loop starts in this batch, inside the facets. Its
  // `remaining.batch` is Start reviewing's count (the batch's pending steps
  // inside the filter), its `target` the first of them, and its `nextBatch`
  // what the empty state points at. Closed to readers who may not review.
  const nextInput = {
    projectId,
    at: { buildId },
    ...(hasFacets ? { facets: ctx.facets } : {}),
  };
  const next = trpc.review.next.useQuery(nextInput, { enabled: canReview });
  const loop = canReview ? next.data : undefined;

  // The question asked before every pending step of the build is approved.
  const [approveOpen, setApproveOpen] = useState(false);
  // The toolbar button that opens it, which the question hands focus back to.
  const approveButton = useRef<HTMLButtonElement>(null);

  // "Back to batch" lands here with `#run-<id>`: the run to bring into view.
  const [anchorRunId, setAnchorRunId] = useState<string | null>(null);
  useEffect(() => {
    const read = () => setAnchorRunId(runIdFromHash(window.location.hash));
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);
  // Said by the run's row once it has scrolled and taken focus. Once only: a
  // later filter change must not scroll again.
  const onRevealed = useCallback(() => setAnchorRunId(null), []);

  const build = buildQ.data;

  // Dedupe on id across `accumulated` and the current page — cursor
  // pagination on a non-strictly-monotonic createdAt could legitimately
  // return overlapping rows on a page boundary.
  const currentPage = list.data?.items;
  const items = useMemo(() => {
    const seen = new Set<string>();
    const out: RunRow[] = [];
    for (const r of [...pageState.accumulated, ...(currentPage ?? [])]) {
      if (!seen.has(r.id)) {
        seen.add(r.id);
        out.push(r);
      }
    }
    return out;
  }, [pageState.accumulated, currentPage]);

  // Load pages until the anchored run is in the list, up to the cap; then its
  // row reveals itself. Give up quietly when the batch ends, or the cap is
  // reached, without it. It waits for an answer that is this filter's own.
  const anchorLoaded =
    anchorRunId !== null && items.some((r) => r.id === anchorRunId);
  useEffect(() => {
    if (anchorRunId === null || anchorLoaded) return;
    if (list.isLoading || list.isError || list.isPlaceholderData) return;
    if (!list.data) return;
    if (!list.data.nextCursor || pageState.pages >= MAX_ANCHOR_PAGES) {
      setAnchorRunId(null);
      return;
    }
    setPaging({
      key: filterKey,
      cursor: list.data.nextCursor,
      pages: pageState.pages + 1,
      accumulated: items,
    });
  }, [
    anchorRunId,
    anchorLoaded,
    list.isLoading,
    list.isError,
    list.isPlaceholderData,
    list.data,
    pageState.pages,
    filterKey,
    items,
  ]);

  const [starting, setStarting] = useState(false);
  const startReviewing = async () => {
    if (starting) return;
    setStarting(true);
    try {
      // Asked for afresh: the count on the button may be old by now.
      const found = await utils.review.next.fetch(nextInput);
      if (found.scope === "batch" && found.target) {
        router.push(
          diffViewerHref(
            projectId,
            found.target.runId,
            found.target.checkpointId,
            ctx,
          ),
        );
        // Left on: the page is about to be left, and a second press must not
        // open the viewer twice.
        return;
      }
      // Someone decided the last step meanwhile.
      toast.info("Nothing to review in this batch.");
      void utils.review.next.invalidate();
    } catch {
      toast.error("Couldn't open the next step. Try again.");
    }
    setStarting(false);
  };

  // A genuine missing build is a 404. Any other build error with no data
  // (FORBIDDEN, network, 500, transient background-refetch) gets a real
  // error state instead of masquerading as a 404 or a headerless shell.
  if (buildQ.error?.data?.code === "NOT_FOUND") notFound();
  if (buildQ.isError && !build) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <p className="text-sm text-destructive">
          Couldn’t load this build: {buildQ.error?.message ?? "unknown error"}
        </p>
      </div>
    );
  }

  const onLoadMore = () => {
    // While the previous filter's page is still showing, its cursor is not
    // this filter's: appending it would page the new filter from the old one's
    // place.
    if (list.isPlaceholderData || !list.data?.nextCursor) return;
    setPaging({
      key: filterKey,
      cursor: list.data.nextCursor,
      pages: pageState.pages + 1,
      accumulated: items,
    });
  };

  // Back to the page's default view (Needs review, no facets); if nothing is
  // pending that shows its own empty state.
  const clearFilters = () =>
    setContext({ status: DEFAULT_REVIEW_STATUS, facets: {} });

  const startCount = loop?.remaining.batch;
  // The queue could not be read (and there is no earlier answer to show):
  // Start reviewing says so and a press asks again.
  const queueFailed = canReview && next.isError && next.data === undefined;

  return (
    <PageContainer fullBleed>
      {build && <BatchHeader build={build} />}
      <ContextualToolbar
        chip={ctx.status}
        onChipChange={(status) => setContext({ status })}
        view={view}
        onViewChange={setView}
        onRefresh={() => {
          // Re-page from the top so the refreshed list reflects the current
          // filter cleanly (not stale accumulated rows), then refetch both.
          setPaging(firstPage(filterKey));
          void list.refetch();
          void buildQ.refetch();
          void utils.review.next.invalidate();
          void utils.runs.facets.invalidate({ buildId });
        }}
        isRefreshing={list.isFetching || buildQ.isFetching}
        canApprovePending={canReview}
        pendingCount={build?.pendingCheckpoints ?? 0}
        onApprovePending={() => setApproveOpen(true)}
        approveRef={approveButton}
        environment={
          <FacetSelects
            buildId={buildId}
            facets={ctx.facets}
            onChange={(facets) => setContext({ facets })}
          />
        }
        start={
          canReview
            ? {
                count: startCount,
                failed: queueFailed,
                reason: queueFailed
                  ? "Couldn't load the review queue"
                  : startCount === 0
                    ? "Nothing to review in this batch"
                    : starting
                      ? "Opening the first step…"
                      : null,
                onClick: queueFailed
                  ? () => void next.refetch()
                  : () => void startReviewing(),
              }
            : undefined
        }
      />
      <div className="flex-1 overflow-y-auto">
        <ResultsColumnHeader />
        {list.isLoading ? (
          <RowSkeletons />
        ) : list.isError ? (
          <p className="p-8 text-center text-sm text-destructive">
            Error loading tests: {list.error?.message}
          </p>
        ) : items.length === 0 ? (
          ctx.status === "needs-review" && !hasFacets ? (
            <NothingToReview
              projectId={projectId}
              ctx={ctx}
              nextBatch={loop?.nextBatch ?? null}
              onShowAll={() => setContext({ status: "all" })}
            />
          ) : ctx.status === "all" && !hasFacets ? (
            <p className="p-10 text-center text-sm text-fg-secondary">
              No tests in this batch.
            </p>
          ) : (
            <NoTestsMatch onClear={clearFilters} />
          )
        ) : (
          <div data-testid="batch-results" aria-busy={list.isPlaceholderData}>
            {items.map((row) => (
              <RunResults
                key={row.id}
                projectId={projectId}
                runId={row.id}
                testName={row.name}
                branchName={build?.branchName ?? null}
                fallbackStatus={row.status}
                statusOverride={row.statusOverride}
                ctx={ctx}
                pendingCount={row.pendingCount}
                stepCount={row.stepCount}
                view={view}
                canReview={canReview}
                reveal={row.id === anchorRunId}
                onRevealed={onRevealed}
              />
            ))}
          </div>
        )}
        {list.data?.nextCursor && (
          <div className="flex justify-center p-3">
            <Button
              variant="secondary"
              onClick={onLoadMore}
              disabled={list.isFetching || list.isPlaceholderData}
            >
              Load more
            </Button>
          </div>
        )}
      </div>
      <ApprovePendingDialog
        buildId={buildId}
        open={approveOpen}
        onOpenChange={setApproveOpen}
        // "Approve pending" is build-wide: say so when the page is filtered.
        filtersActive={hasFacets}
        returnFocusTo={approveButton}
        onApproved={() => {
          // Re-page from the top so approved runs drop out of "Needs review"
          // instead of lingering in the pages already loaded. (The refetch of
          // the lists and the build's counts is the review hook's.)
          setPaging(firstPage(filterKey));
        }}
      />
    </PageContainer>
  );
}

/**
 * "Nothing to review in this batch." (spec §5.5): the way on is the next batch
 * that needs review, if the loop knows one, or the whole batch.
 */
function NothingToReview({
  projectId,
  ctx,
  nextBatch,
  onShowAll,
}: {
  projectId: string;
  ctx: ReviewContext;
  nextBatch: NextBatch | null;
  onShowAll: () => void;
}) {
  const name = nextBatch
    ? nextBatch.number !== null
      ? `#${nextBatch.number}`
      : nextBatch.name
    : null;
  return (
    <div
      className="flex flex-col items-center gap-3 px-5 py-16 text-center"
      data-testid="batch-empty-nothing-to-review"
    >
      <p className="text-base font-medium text-fg">
        Nothing to review in this batch.
      </p>
      {nextBatch && (
        <Link
          href={batchHref(projectId, nextBatch.buildId, ctx)}
          data-testid="batch-next-batch-link"
          className="rounded-md px-2 py-1 text-sm text-brand-text transition-colors hover:bg-hover focus-ring"
        >
          Next batch needing review: <span className="font-medium">{name}</span>
          {` · ${nextBatch.pending} pending →`}
        </Link>
      )}
      <Button
        variant="secondary"
        onClick={onShowAll}
        data-testid="batch-show-all"
      >
        Show all tests
      </Button>
    </div>
  );
}

/** A filter (a chip or a facet) that matches no test. */
function NoTestsMatch({ onClear }: { onClear: () => void }) {
  return (
    <div
      className="flex flex-col items-center gap-3 px-5 py-16 text-center"
      data-testid="batch-empty-filtered"
    >
      <p className="text-base font-medium text-fg">
        No tests match these filters.
      </p>
      <Button
        variant="secondary"
        onClick={onClear}
        data-testid="batch-clear-filters"
      >
        Clear filters
      </Button>
    </div>
  );
}

/** Sticky column header that aligns to every result row's grid. */
function ResultsColumnHeader() {
  return (
    <div
      className={cn(
        RESULT_GRID,
        "sticky top-0 z-10 border-b border-edge bg-sunken/80 px-4 py-2 text-2xs font-medium uppercase tracking-wide text-fg-muted backdrop-blur",
      )}
    >
      <span>Status</span>
      <span>Execution Cloud</span>
      <span>Test</span>
      <span>Branch</span>
      <span>OS</span>
      <span>Browser</span>
      <span>Viewport</span>
    </div>
  );
}

function RowSkeletons() {
  return (
    <div aria-busy="true">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="border-b border-edge-subtle px-4 py-3.5">
          <Skeleton className="h-5 w-full rounded" />
        </div>
      ))}
    </div>
  );
}
