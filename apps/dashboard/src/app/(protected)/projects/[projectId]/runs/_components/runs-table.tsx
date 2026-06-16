"use client";

import type { RunStatus } from "@furan/shared-types";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { BuildGroup, type BuildGroupData } from "./build-group";
import { EmptyRunsCta } from "./empty-runs-cta";
import { FiltersBar, type DeviceFilters } from "./filters-bar";
import { RunRow } from "./run-row";

import { Button } from "@/components/ui/button";
import { useProjectEvents } from "@/hooks/useProjectEvents";
import { trpc } from "@/lib/trpc";

interface Props {
  projectId: string;
  initialBranch?: string;
  initialStatus?: RunStatus[];
  initialDevice?: DeviceFilters;
  /** Editor/admin can approve/reject inline; guests get a read-only table. */
  canReview?: boolean;
}

interface RunItem {
  id: string;
  projectId: string;
  branchName: string | null;
  status: RunStatus;
  diffPercent: number | null;
  pixelMisMatchCount: number | null;
  baselineSource: string | null;
  testVariationId: string | null;
  name: string | null;
  checkpointCount: number | null;
  thumbnailUrl: string | null;
  createdAt: string | Date;
  buildId: string | null;
  buildName: string | null;
  buildNumber: number | null;
  buildCiBuildId: string | null;
  buildBranchName: string | null;
  buildCreatedAt: string | Date | null;
}

/**
 * Runs index table for /projects/[projectId]/runs.
 *
 * Runs are grouped under their build (the Applitools batch model) as
 * collapsible `<BuildGroup>` sections; empty-status runs bucket behind a
 * global toggle. "Approve all" approves the whole build server-side, so it's
 * not limited to the currently-loaded page. Pagination is manual cursor state.
 */
export function RunsTable({
  projectId,
  initialBranch,
  initialStatus,
  initialDevice,
  canReview,
}: Props) {
  const [filters, setFilters] = useState<
    {
      branch?: string;
      status?: RunStatus[];
    } & DeviceFilters
  >({
    branch: initialBranch,
    status:
      initialStatus && initialStatus.length > 0 ? initialStatus : undefined,
    browser: initialDevice?.browser,
    viewport: initialDevice?.viewport,
    os: initialDevice?.os,
    device: initialDevice?.device,
    customTags: initialDevice?.customTags,
  });
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [accumulated, setAccumulated] = useState<RunItem[]>([]);
  const [showEmpties, setShowEmpties] = useState(false);

  useProjectEvents(projectId);

  const { data, isLoading, error } = trpc.runs.list.useQuery({
    projectId,
    limit: 25,
    cursor,
    branch: filters.branch,
    status: filters.status,
    browser: filters.browser,
    viewport: filters.viewport,
    os: filters.os,
    device: filters.device,
    customTags: filters.customTags,
  });

  const statusCountsQuery = trpc.runs.statusCounts.useQuery({
    projectId,
    branch: filters.branch,
    customTags: filters.customTags,
  });

  // The project SSE channel (useProjectEvents) invalidates the runs queries on
  // the testRun_updated / build_updated frames these mutations broadcast, so we
  // don't refetch manually — that would double every approve's query volume.
  const approveMut = trpc.runs.approve.useMutation({
    onError: (e) => toast.error(e.message),
  });
  const rejectMut = trpc.runs.reject.useMutation({
    onError: (e) => toast.error(e.message),
  });
  const bulkApproveBuildMut = trpc.runs.bulkApproveByBuild.useMutation({
    onError: (e) => toast.error(e.message),
  });
  const onApprove = (runId: string) =>
    approveMut.mutate(
      { runId },
      { onSuccess: () => toast.success("Approved") },
    );
  const onReject = (runId: string) =>
    rejectMut.mutate({ runId }, { onSuccess: () => toast.success("Rejected") });
  const onApproveBuild = (buildId: string) =>
    bulkApproveBuildMut.mutate(
      { buildId },
      {
        onSuccess: (res) =>
          toast.success(
            `Approved ${res.approved} run${res.approved === 1 ? "" : "s"}` +
              (res.capped ? ` (capped at ${res.cap})` : ""),
          ),
      },
    );

  // Dedupe + partition + group only when the data actually changes (not on
  // every toast / SSE frame / filter keystroke render).
  const { groups, emptyRuns, emptyForced } = useMemo(() => {
    const items: RunItem[] = [];
    const seen = new Set<string>();
    for (const r of accumulated) {
      if (!seen.has(r.id)) {
        seen.add(r.id);
        items.push(r);
      }
    }
    for (const r of (data?.items as unknown as RunItem[] | undefined) ?? []) {
      if (!seen.has(r.id)) {
        seen.add(r.id);
        items.push(r);
      }
    }

    // Empty-status runs are noise; bucket them globally and group only runs
    // with results, so all-empty builds don't clutter the list.
    const forced = filters.status?.includes("empty") ?? false;
    const empties = items.filter((r) => r.status === "empty");
    const nonEmpty = items.filter((r) => r.status !== "empty");

    const grouped: BuildGroupData[] = [];
    const byBuild = new Map<string, BuildGroupData>();
    for (const r of nonEmpty) {
      const key = r.buildId ?? "__none__";
      let g = byBuild.get(key);
      if (!g) {
        g = {
          buildId: r.buildId,
          buildName: r.buildName,
          buildNumber: r.buildNumber,
          buildCiBuildId: r.buildCiBuildId,
          buildBranchName: r.buildBranchName,
          buildCreatedAt: r.buildCreatedAt,
          runs: [],
        };
        byBuild.set(key, g);
        grouped.push(g);
      }
      g.runs.push(r);
    }
    return { groups: grouped, emptyRuns: empties, emptyForced: forced };
  }, [data, accumulated, filters.status]);

  const isEmpty = groups.length === 0 && emptyRuns.length === 0;

  const onLoadMore = () => {
    if (!data?.nextCursor) return;
    setAccumulated((prev) => [
      ...prev,
      ...((data.items as unknown as RunItem[]) ?? []),
    ]);
    setCursor(data.nextCursor);
  };

  const onFiltersChange = (
    f: {
      branch?: string;
      status?: RunStatus[];
    } & DeviceFilters,
  ) => {
    setFilters({
      branch: f.branch,
      status: f.status && f.status.length > 0 ? f.status : undefined,
      browser: f.browser,
      viewport: f.viewport,
      os: f.os,
      device: f.device,
      customTags: f.customTags,
    });
    setAccumulated([]);
    setCursor(undefined);
    setShowEmpties(false);
  };

  const hasNoFilters =
    filters.branch === undefined &&
    (!filters.status || filters.status.length === 0) &&
    !filters.browser &&
    !filters.viewport &&
    !filters.os &&
    !filters.device &&
    !filters.customTags;

  return (
    <div className="space-y-4">
      <div id="runs-filters">
        <FiltersBar
          initialBranch={initialBranch}
          initialStatus={initialStatus}
          initialDevice={initialDevice}
          statusCounts={statusCountsQuery.data}
          onChange={onFiltersChange}
        />
      </div>
      {isLoading && !data ? (
        <div className="text-sm text-zinc-600 dark:text-zinc-400">Loading…</div>
      ) : error ? (
        <div className="text-sm text-red-600 dark:text-red-400">
          Error: {error.message}
        </div>
      ) : isEmpty ? (
        hasNoFilters ? (
          <EmptyRunsCta projectId={projectId} />
        ) : (
          <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
            <table className="w-full text-sm" data-testid="runs-table">
              <RunsTableHead />
              <tbody>
                <tr>
                  <td
                    colSpan={3}
                    className="px-4 py-8 text-center text-zinc-500"
                  >
                    No runs match.
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )
      ) : (
        <>
          <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
            <table className="w-full text-sm" data-testid="runs-table">
              <RunsTableHead />
              {groups.map((g) => (
                <BuildGroup
                  key={g.buildId ?? "none"}
                  projectId={projectId}
                  group={g}
                  canReview={canReview}
                  onApprove={onApprove}
                  onReject={onReject}
                  onApproveBuild={onApproveBuild}
                />
              ))}
              {emptyRuns.length > 0 ? (
                <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
                  {emptyForced ? null : (
                    <tr>
                      <td colSpan={3} className="px-3 py-2">
                        <button
                          type="button"
                          onClick={() => setShowEmpties((v) => !v)}
                          aria-expanded={showEmpties}
                          data-testid="toggle-empty-runs"
                          className="text-xs text-zinc-500 transition-colors hover:text-zinc-800 dark:hover:text-zinc-200"
                        >
                          {showEmpties ? "Hide" : "Show"} {emptyRuns.length}{" "}
                          empty run{emptyRuns.length === 1 ? "" : "s"}
                        </button>
                      </td>
                    </tr>
                  )}
                  {showEmpties || emptyForced
                    ? emptyRuns.map((r) => (
                        <RunRow key={r.id} projectId={projectId} run={r} />
                      ))
                    : null}
                </tbody>
              ) : null}
            </table>
          </div>
          {data?.nextCursor && (
            <div className="flex justify-center">
              <Button
                variant="secondary"
                onClick={onLoadMore}
                data-testid="load-more-button"
              >
                Load more
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** Shared 3-column header: Test · Change · When (status is a row stripe). */
function RunsTableHead() {
  return (
    <thead className="border-b border-zinc-200 bg-zinc-100/70 text-left text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900/50 dark:text-zinc-400">
      <tr>
        <th className="px-4 py-2.5 font-medium">Test</th>
        <th className="px-4 py-2.5 text-right font-medium">Change</th>
        <th className="px-4 py-2.5 text-right font-medium">When</th>
      </tr>
    </thead>
  );
}
