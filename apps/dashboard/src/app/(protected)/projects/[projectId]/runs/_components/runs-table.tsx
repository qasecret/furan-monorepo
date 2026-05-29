"use client";

import type { RunStatus } from "@furan/shared-types";
import { useState } from "react";

import { EmptyRunsCta } from "./empty-runs-cta";
import { FiltersBar, type DeviceFilters } from "./filters-bar";
import { RunRow } from "./run-row";

import { Button } from "@/components/ui/button";
import { useProjectEvents } from "@/hooks/useProjectEvents";
import { trpc } from "@/lib/trpc";

interface Props {
  projectId: string;
  initialBranch?: string;
  /**
   * Per spec §3.5 the status filter is multi-select; an undefined or empty
   * array both mean "no filter, show all statuses".
   */
  initialStatus?: RunStatus[];
  /**
   * Device/environment filter pre-fill from the URL (legacy parity:
   * browser / viewport / os / device / customTags). Each field is
   * optional; omitting one means "no filter on this column".
   */
  initialDevice?: DeviceFilters;
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
  createdAt: string | Date;
}

/**
 * Runs index table for /projects/[projectId]/runs.
 *
 * Pagination model: manual cursor state rather than `useInfiniteQuery`.
 * The tRPC `runs.list` procedure is shaped correctly for infinite-query
 * (cursor in, nextCursor out), but the manual approach is more explicit
 * about filter-change resets and avoids a tRPC-react-query version
 * spelunk to confirm `useInfiniteQuery` is wired in this monorepo.
 * Either pattern is acceptable for v0.4.
 *
 * `cursor` is the cursor for the CURRENTLY-LOADED page; on "Load more"
 * we copy the current page into `accumulated`, then advance the cursor
 * so the next useQuery call fetches the following page. Filter changes
 * reset both pieces of state.
 */
export function RunsTable({
  projectId,
  initialBranch,
  initialStatus,
  initialDevice,
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

  // Subscribe to the project SSE channel so the table refetches when a
  // run completes or a reviewer mutation lands. The hook ref-counts a
  // single EventSource across all mounts on the same projectId.
  useProjectEvents(projectId);

  const { data, isLoading, error } = trpc.runs.list.useQuery({
    projectId,
    limit: 25,
    cursor,
    branch: filters.branch,
    // Send `undefined` (omitted) instead of `[]` for the all-statuses case
    // so the wire shape matches the spec semantics and the API's
    // `input.status.length > 0` guard sees consistent inputs.
    status: filters.status,
    browser: filters.browser,
    viewport: filters.viewport,
    os: filters.os,
    device: filters.device,
    customTags: filters.customTags,
  });

  // Dedupe on id: cursor pagination on a non-strictly-monotonic
  // `created_at` could legitimately return overlapping rows on the
  // boundary between pages, and React would warn about duplicate keys.
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
  };

  return (
    <div className="space-y-4">
      <div id="runs-filters">
        <FiltersBar
          initialBranch={initialBranch}
          initialStatus={initialStatus}
          initialDevice={initialDevice}
          onChange={onFiltersChange}
        />
      </div>
      {isLoading && !data ? (
        <div className="text-sm text-zinc-600 dark:text-zinc-400">Loading…</div>
      ) : error ? (
        <div className="text-sm text-red-600 dark:text-red-400">
          Error: {error.message}
        </div>
      ) : items.length === 0 ? (
        filters.branch === undefined &&
        (!filters.status || filters.status.length === 0) ? (
          <EmptyRunsCta projectId={projectId} />
        ) : (
          <div className="rounded-xl border border-zinc-200 bg-white overflow-x-auto dark:border-zinc-800 dark:bg-zinc-950">
            <table
              className="w-full min-w-[640px] text-sm"
              data-testid="runs-table"
            >
              <thead className="bg-zinc-100/70 border-b border-zinc-200 text-zinc-600 text-left dark:bg-zinc-900/50 dark:border-zinc-800 dark:text-zinc-400">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Branch / Test</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="px-4 py-2.5 font-medium">Checkpoints</th>
                  <th className="px-4 py-2.5 font-medium">Diff %</th>
                  <th className="px-4 py-2.5 font-medium">Mismatched px</th>
                  <th className="px-4 py-2.5 font-medium">When</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
                <tr>
                  <td
                    colSpan={6}
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
          <div className="rounded-xl border border-zinc-200 bg-white overflow-x-auto dark:border-zinc-800 dark:bg-zinc-950">
            <table
              className="w-full min-w-[640px] text-sm"
              data-testid="runs-table"
            >
              <thead className="bg-zinc-100/70 border-b border-zinc-200 text-zinc-600 text-left dark:bg-zinc-900/50 dark:border-zinc-800 dark:text-zinc-400">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Branch / Test</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="px-4 py-2.5 font-medium">Checkpoints</th>
                  <th className="px-4 py-2.5 font-medium">Diff %</th>
                  <th className="px-4 py-2.5 font-medium">Mismatched px</th>
                  <th className="px-4 py-2.5 font-medium">When</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
                {items.map((r) => (
                  <RunRow key={r.id} projectId={projectId} run={r} />
                ))}
              </tbody>
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
