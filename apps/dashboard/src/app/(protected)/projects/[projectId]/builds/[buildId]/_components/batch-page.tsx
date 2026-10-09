"use client";

import type { RunStatus } from "@furan/shared-types";
import { notFound } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { BatchHeader } from "./batch-header";
import {
  ContextualToolbar,
  type Chip,
  type ResultView,
} from "./contextual-toolbar";
import { RESULT_GRID, RunResults } from "./run-results";

import { Button } from "@/components/ui/button";
import { PageContainer } from "@/components/ui/page-container";
import { Skeleton } from "@/components/ui/skeleton";
import { useProjectEvents } from "@/hooks/useProjectEvents";
import { cn } from "@/lib/cn";
import { plural } from "@/lib/format";
import { trpc, type RouterOutputs } from "@/lib/trpc";

type RunRow = RouterOutputs["runs"]["list"]["items"][number];

const CHIP_STATUS: Record<Chip, RunStatus[] | undefined> = {
  "needs-review": ["unresolved", "failed"],
  all: undefined,
  passed: ["passed"],
};

interface Props {
  projectId: string;
  buildId: string;
  canReview: boolean;
}

export function BatchPage({ projectId, buildId, canReview }: Props) {
  useProjectEvents(projectId);
  const [chip, setChip] = useState<Chip>("all");
  const [view, setView] = useState<ResultView>("list");
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [accumulated, setAccumulated] = useState<RunRow[]>([]);

  const buildQ = trpc.builds.getById.useQuery({ buildId });
  const list = trpc.runs.list.useQuery({
    projectId,
    buildId,
    status: CHIP_STATUS[chip],
    cursor,
  });

  const utils = trpc.useUtils();
  const bulkApprove = trpc.runs.bulkApproveByBuild.useMutation({
    onError: (e) => toast.error(e.message),
  });

  const onApproveAll = () =>
    bulkApprove.mutate(
      { buildId },
      {
        onSuccess: (res: {
          approved: number;
          capped: boolean;
          cap: number;
        }) => {
          // Refetch the rows + build aggregate so the just-approved runs flip
          // out of "Unresolved" immediately — the row badge is derived from
          // runs.listCheckpoints, not the toast. (Mirrors ApprovalBar's
          // post-approve invalidate; we can't rely on the SSE alone.)
          void utils.runs.list.invalidate();
          void utils.runs.listCheckpoints.invalidate();
          void utils.builds.getById.invalidate({ buildId });
          // Re-page from the top so approved runs drop out of "Needs review"
          // instead of lingering in the accumulated set.
          setAccumulated([]);
          setCursor(undefined);
          toast.success(
            `Approved ${res.approved} run${plural(res.approved)}` +
              (res.capped ? ` (capped at ${res.cap})` : ""),
          );
        },
      },
    );

  const build = buildQ.data;

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

  // Dedupe on id across `accumulated` and the current page — cursor
  // pagination on a non-strictly-monotonic createdAt could legitimately
  // return overlapping rows on a page boundary.
  const currentPage = list.data?.items ?? [];
  const items: RunRow[] = [];
  const seen = new Set<string>();
  for (const r of [...accumulated, ...currentPage]) {
    if (!seen.has(r.id)) {
      seen.add(r.id);
      items.push(r);
    }
  }

  const onLoadMore = () => {
    if (!list.data?.nextCursor) return;
    setAccumulated((prev) => [...prev, ...currentPage]);
    setCursor(list.data.nextCursor);
  };

  const canApproveAll =
    canReview &&
    !!build &&
    (build.unresolvedCount > 0 || build.failedCount > 0);

  return (
    <PageContainer fullBleed>
      {build && <BatchHeader build={build} />}
      <ContextualToolbar
        chip={chip}
        onChipChange={(c) => {
          setChip(c);
          setCursor(undefined);
          setAccumulated([]);
        }}
        view={view}
        onViewChange={setView}
        onRefresh={() => {
          // Re-page from the top so the refreshed list reflects the current
          // filter cleanly (not stale accumulated rows), then refetch both.
          setAccumulated([]);
          setCursor(undefined);
          void list.refetch();
          void buildQ.refetch();
        }}
        isRefreshing={list.isFetching || buildQ.isFetching}
        canApproveAll={canApproveAll}
        onApproveAll={onApproveAll}
        isApproving={bulkApprove.isPending}
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
          <p className="p-10 text-center text-sm text-fg-secondary">
            No tests{" "}
            {chip === "needs-review"
              ? "need review"
              : `in ${chip === "passed" ? "Passed" : "All"}`}
            .
          </p>
        ) : (
          <div data-testid="batch-results">
            {items.map((row) => (
              <RunResults
                key={row.id}
                projectId={projectId}
                runId={row.id}
                testName={row.name}
                branchName={build?.branchName ?? null}
                fallbackStatus={row.status}
                view={view}
                canReview={canReview}
              />
            ))}
          </div>
        )}
        {list.data?.nextCursor && (
          <div className="flex justify-center p-3">
            <Button
              variant="secondary"
              onClick={onLoadMore}
              disabled={list.isFetching}
            >
              Load more
            </Button>
          </div>
        )}
      </div>
    </PageContainer>
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
