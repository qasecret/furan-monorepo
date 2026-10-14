"use client";

import { Play, RefreshCw, Search } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useState } from "react";
import { toast } from "sonner";

import {
  NoBatchesMatch,
  NoBatchesYet,
  NothingNeedsReview,
} from "./empty-states";
import { StatusChips } from "./status-chips";
import { useUrlText } from "./use-url-text";

import { useCurrentProject } from "@/app/(protected)/_components/current-project-provider";
import { Button } from "@/components/ui/button";
import { DisabledAwareButton } from "@/components/ui/disabled-aware-button";
import { Input } from "@/components/ui/input";
import { PageContainer } from "@/components/ui/page-container";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { useProjectEvents } from "@/hooks/useProjectEvents";
import { buildDisplayName } from "@/lib/build-display-name";
import { buildStatusMeta } from "@/lib/build-status-meta";
import { cn } from "@/lib/cn";
import { diffViewerHref } from "@/lib/diff-viewer-href";
import { formatBatchDateTime } from "@/lib/format";
import {
  batchHref,
  DEFAULT_REVIEW_STATUS,
  toBuildsListFilter,
  useReviewContext,
  type ReviewContext,
} from "@/lib/review-url";
import { trpc, type RouterOutputs } from "@/lib/trpc";

type BuildRow = RouterOutputs["builds"]["list"]["items"][number];

interface Props {
  /**
   * The review context the server parsed from the request's search params
   * (spec §3.3). The URL is the source of truth: a chip, the branch field or
   * the search writes it (through `useReviewContext`), and the server hands
   * the new context back.
   */
  context: ReviewContext;
}

/** The pages of the list loaded so far, for the filters they were loaded under. */
interface Paging {
  key: string;
  cursor: string | null;
  accumulated: BuildRow[];
}

const firstPage = (key: string): Paging => ({
  key,
  cursor: null,
  accumulated: [],
});

/**
 * Batches: the start of the review loop (spec §5.1). A full-width table of the
 * project's test-result batches, opening on the ones that need review. The
 * chips, the branch and the search live in the URL; "Start reviewing" opens the
 * first pending step of the newest batch that needs it; every empty state
 * names a next action.
 */
export function InboxPage({ context }: Props) {
  const { currentProjectId } = useCurrentProject();
  const router = useRouter();
  const utils = trpc.useUtils();
  const [, setContext] = useReviewContext();
  const branchListId = useId();
  const [starting, setStarting] = useState(false);

  // Search is client-side over the loaded rows; the branch is the API's exact
  // match. Both are typed into at once and written to the URL after a pause.
  const search = useUrlText(context.q, (q) => setContext({ q }));
  const branch = useUrlText(context.branch, (b) => setContext({ branch: b }));

  // What the list is loaded under: a change starts the pages over.
  const filterKey = `${context.status}|${context.branch ?? ""}`;
  const [paging, setPaging] = useState<Paging>(() => firstPage(filterKey));
  let page = paging;
  if (paging.key !== filterKey) {
    // Adjusting state while rendering: React re-renders at once, before paint.
    page = firstPage(filterKey);
    setPaging(page);
  }

  // Auto-refresh on build/run events for this project (ref-counted pool).
  useProjectEvents(currentProjectId ?? "");

  const list = trpc.builds.list.useQuery(
    {
      projectId: currentProjectId ?? "",
      ...toBuildsListFilter(context),
      cursor: page.cursor ?? undefined,
    },
    { enabled: !!currentProjectId },
  );
  // How many batches need review, project-wide: the badge's number.
  const pending = trpc.builds.pendingCount.useQuery(
    { projectId: currentProjectId ?? "" },
    { enabled: !!currentProjectId },
  );

  // Merge loaded pages (dedupe by id) — cursor pagination can overlap on a
  // page boundary when createdAt isn't strictly monotonic.
  const currentPage = list.data?.items;
  const items = useMemo(() => {
    const seen = new Set<string>();
    const out: BuildRow[] = [];
    for (const b of [...page.accumulated, ...(currentPage ?? [])]) {
      if (!seen.has(b.id)) {
        seen.add(b.id);
        out.push(b);
      }
    }
    return out;
  }, [page.accumulated, currentPage]);

  // The branches seen so far, to suggest in the branch field (it takes any).
  const [seenBranches, setSeenBranches] = useState<string[]>([]);
  useEffect(() => {
    setSeenBranches((prev) => {
      const next = new Set(prev);
      for (const b of items) if (b.branchName) next.add(b.branchName);
      if (context.branch) next.add(context.branch);
      return next.size === prev.length ? prev : [...next].sort();
    });
  }, [items, context.branch]);

  // Client-side search over the loaded rows (batch name / branch).
  const rows = useMemo(() => {
    const q = search.text.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (b) =>
        buildDisplayName(b).toLowerCase().includes(q) ||
        (b.branchName ?? "").toLowerCase().includes(q),
    );
  }, [items, search.text]);

  // The list came back with nothing at all, whatever the search says.
  const serverEmpty = !!list.data && !list.isError && items.length === 0;
  // The newest batch in the project, filters aside: it tells "no batches at
  // all" from "none match", and is what an empty Needs review points at.
  const latest = trpc.builds.list.useQuery(
    { projectId: currentProjectId ?? "", limit: 1 },
    { enabled: !!currentProjectId && serverEmpty },
  );

  const loadMore = () => {
    if (!list.data?.nextCursor) return;
    setPaging({
      key: filterKey,
      cursor: list.data.nextCursor,
      accumulated: items,
    });
  };

  const clearFilters = () => {
    search.reset();
    branch.reset();
    // Back to the page's default view (the Needs review chip, no branch, no
    // search); if nothing is pending that shows its own empty state.
    setContext({
      status: DEFAULT_REVIEW_STATUS,
      branch: undefined,
      q: undefined,
    });
  };

  const startReviewing = async () => {
    if (!currentProjectId || starting) return;
    setStarting(true);
    try {
      // No `at`: the first pending step of the newest batch needing review.
      const next = await utils.review.next.fetch({
        projectId: currentProjectId,
      });
      if (next.target) {
        router.push(
          diffViewerHref(
            currentProjectId,
            next.target.runId,
            next.target.checkpointId,
            // The Batches page has no facets: only the status travels.
            { status: context.status },
          ),
        );
      } else {
        // The count was stale: someone decided the last step meanwhile.
        toast.info("Nothing needs review.");
        void utils.builds.pendingCount.invalidate();
        void utils.builds.list.invalidate();
      }
    } catch {
      toast.error("Couldn't open the next step. Try again.");
    } finally {
      setStarting(false);
    }
  };

  if (!currentProjectId) {
    return (
      <div
        className="flex flex-1 items-center justify-center p-10 text-center text-sm text-fg-muted"
        data-testid="inbox-no-project"
      >
        No project assigned. Ask an admin to add you to a project.
      </div>
    );
  }

  const total = pending.data?.total;
  const startReason =
    total === 0
      ? "Nothing needs review"
      : starting
        ? "Opening the first step…"
        : null;

  // What the body shows when there is no row to show.
  const showTable = list.isLoading || rows.length > 0;
  const emptyBody = (() => {
    if (list.isError) {
      return (
        <div
          className="flex flex-col items-center gap-3 px-5 py-16 text-center"
          data-testid="inbox-error"
        >
          <p className="text-base font-medium text-fg">
            Couldn&apos;t load batches.
          </p>
          <Button variant="secondary" onClick={() => void list.refetch()}>
            Try again
          </Button>
        </div>
      );
    }
    if (serverEmpty) {
      if (latest.isLoading) return <LoadingRows />;
      if (latest.data && latest.data.items.length === 0) {
        return <NoBatchesYet />;
      }
      if (context.status === "needs-review" && !context.branch) {
        return (
          <NothingNeedsReview
            projectId={currentProjectId}
            latest={latest.data?.items[0]}
            onShowAll={() => setContext({ status: "all" })}
          />
        );
      }
    }
    return <NoBatchesMatch onClear={clearFilters} />;
  })();

  return (
    <PageContainer fullBleed>
      <div className="flex min-h-0 flex-1 flex-col gap-5 px-6 py-6">
        <PageHeader
          title="Batches"
          description="Test result batches across your project, starting with what needs review."
          actions={
            <>
              <Button
                variant="secondary"
                className="h-9 gap-2"
                onClick={() => {
                  void list.refetch();
                  void pending.refetch();
                }}
                disabled={list.isFetching}
                title="Refresh"
              >
                <RefreshCw
                  className={cn("h-4 w-4", list.isFetching && "animate-spin")}
                  aria-hidden
                />
                Refresh
              </Button>
              <DisabledAwareButton
                variant="default"
                testId="inbox-start-reviewing"
                className="h-9 gap-2"
                disabled={pending.isLoading || total === 0 || starting}
                reason={startReason}
                onClick={() => void startReviewing()}
              >
                <Play className="h-4 w-4" aria-hidden />
                {total === undefined
                  ? "Start reviewing"
                  : `Start reviewing (${total})`}
              </DisabledAwareButton>
            </>
          }
        />

        <div className="flex flex-wrap items-center justify-between gap-3">
          <StatusChips
            value={context.status}
            onChange={(status) => setContext({ status })}
          />
          <div className="flex flex-wrap items-center gap-2">
            <div>
              <Input
                type="text"
                list={branchListId}
                value={branch.text}
                onChange={(e) => branch.setText(e.target.value)}
                onBlur={branch.flush}
                onKeyDown={(e) => {
                  if (e.key === "Enter") branch.flush();
                }}
                maxLength={200}
                placeholder="Branch…"
                aria-label="Filter by branch"
                className="h-9 w-48 font-mono text-xs"
                data-testid="inbox-branch-input"
              />
              <datalist id={branchListId}>
                {seenBranches.map((b) => (
                  <option key={b} value={b} />
                ))}
              </datalist>
            </div>
            <div className="relative">
              <Search
                className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-muted"
                aria-hidden
              />
              <Input
                type="search"
                value={search.text}
                onChange={(e) => search.setText(e.target.value)}
                onBlur={search.flush}
                onKeyDown={(e) => {
                  if (e.key === "Enter") search.flush();
                }}
                maxLength={200}
                placeholder="Search batches…"
                aria-label="Search batches"
                className="h-9 w-56 pl-8"
                data-testid="inbox-search-input"
              />
            </div>
          </div>
        </div>

        <div
          id="inbox-batches-table"
          className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg bg-raised shadow-raised"
        >
          <div className="min-h-0 flex-1 overflow-auto">
            {showTable ? (
              <table className="w-full text-left text-sm">
                <thead className="sticky top-0 z-10 border-b border-edge bg-sunken text-2xs uppercase tracking-wide text-fg-muted">
                  <tr>
                    <th className="px-5 py-3 font-medium">Status</th>
                    <th className="px-5 py-3 font-medium">Batch</th>
                    <th className="px-5 py-3 font-medium">Branch</th>
                    <th className="px-5 py-3 font-medium">Tests</th>
                    <th className="px-5 py-3 font-medium">Started</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-edge-subtle">
                  {list.isLoading
                    ? Array.from({ length: 8 }).map((_, i) => (
                        <tr key={i}>
                          <td className="px-5 py-3.5" colSpan={5}>
                            <Skeleton className="h-5 w-full" />
                          </td>
                        </tr>
                      ))
                    : rows.map((b) => {
                        // Only the status travels: the Batches page has no facets
                        // (the same as Start reviewing).
                        const href = batchHref(b.projectId, b.id, {
                          status: context.status,
                        });
                        const meta = buildStatusMeta(b.aggregateStatus);
                        return (
                          <tr
                            key={b.id}
                            onClick={() => router.push(href)}
                            className="group cursor-pointer transition-colors hover:bg-hover"
                            data-testid={`inbox-batch-row-${b.id}`}
                          >
                            <td className="px-5 py-3.5 align-middle">
                              <span
                                className={cn(
                                  "inline-flex items-center rounded-md border px-2 py-1 text-xs font-medium",
                                  meta.pill,
                                )}
                              >
                                {meta.word}
                              </span>
                            </td>
                            <td className="px-5 py-3.5 align-middle">
                              <Link
                                href={href}
                                onClick={(e) => e.stopPropagation()}
                                className="font-medium text-fg transition-colors focus-ring group-hover:text-brand-text"
                              >
                                {buildDisplayName(b)}
                              </Link>
                            </td>
                            <td className="px-5 py-3.5 align-middle font-mono text-xs text-fg-muted">
                              {b.branchName ?? "—"}
                            </td>
                            <td className="px-5 py-3.5 align-middle tabular-nums text-fg-secondary">
                              {b.runCount}
                              {b.pendingCheckpoints > 0 && (
                                <span className="font-medium text-fg">
                                  {" · "}
                                  {b.pendingCheckpoints} pending
                                </span>
                              )}
                            </td>
                            <td className="px-5 py-3.5 align-middle whitespace-nowrap tabular-nums text-fg-muted">
                              {formatBatchDateTime(b.createdAt)}
                            </td>
                          </tr>
                        );
                      })}
                </tbody>
              </table>
            ) : (
              emptyBody
            )}
            {list.data?.nextCursor && !search.text.trim() && (
              <div className="flex justify-center border-t border-edge p-3">
                <Button
                  variant="secondary"
                  onClick={loadMore}
                  disabled={list.isFetching}
                >
                  Load more
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>
    </PageContainer>
  );
}

function LoadingRows() {
  return (
    <div className="flex flex-col gap-3 p-5" aria-hidden>
      {Array.from({ length: 4 }).map((_, i) => (
        <Skeleton key={i} className="h-5 w-full" />
      ))}
    </div>
  );
}
