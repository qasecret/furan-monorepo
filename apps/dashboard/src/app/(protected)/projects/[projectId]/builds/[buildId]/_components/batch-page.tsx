"use client";

import type { RunStatus } from "@furan/shared-types";
import { notFound } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { BatchHeader, type BatchHeaderData } from "./batch-header";
import { TestCard, type TestCardData } from "./test-card";

import { SetBreadcrumbs } from "@/app/(protected)/_components/set-breadcrumbs";
import { Button } from "@/components/ui/button";
import { useProjectEvents } from "@/hooks/useProjectEvents";
import { buildDisplayName } from "@/lib/build-display-name";
import { plural } from "@/lib/format";
import { buildCrumbs } from "@/lib/project-crumbs";
import { trpc } from "@/lib/trpc";

type Chip = "needs-review" | "all" | "passed";
const CHIP_STATUS: Record<Chip, RunStatus[] | undefined> = {
  "needs-review": ["unresolved", "failed"],
  all: undefined,
  passed: ["passed"],
};

interface Props {
  projectId: string;
  buildId: string;
  projectName: string;
  canReview: boolean;
}

export function BatchPage({
  projectId,
  buildId,
  projectName,
  canReview,
}: Props) {
  useProjectEvents(projectId);
  const [chip, setChip] = useState<Chip>("needs-review");
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [accumulated, setAccumulated] = useState<TestCardData[]>([]);

  const buildQ = trpc.builds.getById.useQuery({ buildId });
  const list = trpc.runs.list.useQuery({
    projectId,
    buildId,
    status: CHIP_STATUS[chip],
    cursor,
  });

  const approve = trpc.runs.approve.useMutation({
    onError: (e) => toast.error(e.message),
  });
  const reject = trpc.runs.reject.useMutation({
    onError: (e) => toast.error(e.message),
  });
  const bulkApprove = trpc.runs.bulkApproveByBuild.useMutation({
    onError: (e) => toast.error(e.message),
  });

  const onApprove = (runId: string) =>
    approve.mutate({ runId }, { onSuccess: () => toast.success("Approved") });
  const onReject = (runId: string) =>
    reject.mutate({ runId }, { onSuccess: () => toast.success("Rejected") });
  const onApproveAll = () =>
    bulkApprove.mutate(
      { buildId },
      {
        onSuccess: (res: {
          approved: number;
          capped: boolean;
          cap: number;
        }) => {
          toast.success(
            `Approved ${res.approved} run${plural(res.approved)}` +
              (res.capped ? ` (capped at ${res.cap})` : ""),
          );
        },
      },
    );

  const build = buildQ.data as unknown as BatchHeaderData | undefined;

  // A genuine missing build is a 404. Any other build error with no data
  // (FORBIDDEN, network, 500, transient background-refetch) gets a real
  // error state instead of masquerading as a 404 or a headerless shell.
  if (buildQ.error?.data?.code === "NOT_FOUND") notFound();
  // `notFound()` above returns `never`, so reaching here means the error (if
  // any) is not NOT_FOUND — a FORBIDDEN / network / 500 / transient refetch
  // failure. Show a real error state rather than a headerless shell.
  if (buildQ.isError && !build) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <p className="text-sm text-red-600 dark:text-red-400">
          Couldn’t load this build: {buildQ.error?.message ?? "unknown error"}
        </p>
      </div>
    );
  }

  // Dedupe on id across `accumulated` and the current page — cursor
  // pagination on a non-strictly-monotonic createdAt could legitimately
  // return overlapping rows on a page boundary.
  const currentPage = (list.data?.items ?? []) as unknown as TestCardData[];
  const items: TestCardData[] = [];
  const seen = new Set<string>();
  for (const r of accumulated) {
    if (!seen.has(r.id)) {
      seen.add(r.id);
      items.push(r);
    }
  }
  for (const r of currentPage) {
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
    <div className="flex h-full flex-col">
      <SetBreadcrumbs
        items={buildCrumbs(
          projectId,
          projectName,
          build ? buildDisplayName(build) : "Build",
        )}
      />
      {build && (
        <BatchHeader
          build={build}
          canApproveAll={canApproveAll}
          onApproveAll={onApproveAll}
          isApproving={bulkApprove.isPending}
        />
      )}
      <div className="flex items-center gap-2 border-b border-zinc-200 px-4 py-2 dark:border-zinc-800">
        {(["needs-review", "all", "passed"] as Chip[]).map((c) => (
          <Button
            key={c}
            variant={chip === c ? "default" : "secondary"}
            className="h-7 px-3 text-xs"
            data-testid={`batch-chip-${c}`}
            onClick={() => {
              setChip(c);
              setCursor(undefined);
              setAccumulated([]);
            }}
          >
            {c === "needs-review"
              ? "Needs review"
              : c === "all"
                ? "All"
                : "Passed"}
          </Button>
        ))}
      </div>
      {list.isLoading ? (
        <CardSkeletonGrid />
      ) : list.isError ? (
        <p className="p-8 text-center text-sm text-red-600 dark:text-red-400">
          Error loading tests: {list.error?.message}
        </p>
      ) : items.length === 0 ? (
        <p className="p-8 text-center text-sm text-zinc-600 dark:text-zinc-400">
          No tests{" "}
          {chip === "needs-review"
            ? "need review"
            : `in ${chip === "passed" ? "Passed" : "All"}`}
          .
        </p>
      ) : (
        <div className="grid flex-1 grid-cols-[repeat(auto-fit,minmax(185px,1fr))] gap-3 overflow-y-auto p-4">
          {items.map((row) => (
            <TestCard
              key={row.id}
              projectId={projectId}
              row={row}
              onApprove={onApprove}
              onReject={onReject}
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
  );
}

function CardSkeletonGrid() {
  return (
    <div
      className="grid flex-1 grid-cols-[repeat(auto-fit,minmax(185px,1fr))] gap-3 p-4"
      aria-busy="true"
    >
      {Array.from({ length: 8 }).map((_, i) => (
        <div
          key={i}
          className="h-40 animate-pulse rounded-lg bg-zinc-100 dark:bg-zinc-900"
        />
      ))}
    </div>
  );
}
