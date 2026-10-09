"use client";

import type { BuildAggregateStatus } from "@furan/shared-types";
import { Filter, RefreshCw, Search } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { useCurrentProject } from "@/app/(protected)/_components/current-project-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageContainer } from "@/components/ui/page-container";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { useProjectEvents } from "@/hooks/useProjectEvents";
import { buildDisplayName } from "@/lib/build-display-name";
import { buildStatusMeta } from "@/lib/build-status-meta";
import { cn } from "@/lib/cn";
import { formatBatchDateTime } from "@/lib/format";
import { statusStyle } from "@/lib/status-style";
import { trpc, type RouterOutputs } from "@/lib/trpc";

type BuildRow = RouterOutputs["builds"]["list"]["items"][number];

/** Status filter pills — `all` clears the filter. */
const FILTERS: { value: BuildAggregateStatus | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "unresolved", label: "Unresolved" },
  { value: "failed", label: "Failed" },
  { value: "running", label: "Running" },
  { value: "passed", label: "Passed" },
];

interface Props {
  initialStatus: BuildAggregateStatus | "all";
}

/**
 * Inbox — a full-width table of test-result batches (builds) for the current
 * project, modeled on the reference Batches page. Each row links to that
 * build's Review page; status filter + search + refresh sit in the header.
 * No per-row triage actions — review happens on the batch page.
 */
export function InboxPage({ initialStatus }: Props) {
  const { currentProjectId } = useCurrentProject();
  const router = useRouter();
  const params = useSearchParams();
  const [search, setSearch] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [accumulated, setAccumulated] = useState<BuildRow[]>([]);
  const prevStatus = useRef(initialStatus);
  useEffect(() => {
    if (prevStatus.current !== initialStatus) {
      prevStatus.current = initialStatus;
      setCursor(null);
      setAccumulated([]);
    }
  }, [initialStatus]);

  // Auto-refresh on build/run events for this project (ref-counted pool).
  useProjectEvents(currentProjectId ?? "");

  const list = trpc.builds.list.useQuery(
    {
      projectId: currentProjectId ?? "",
      status: initialStatus === "all" ? undefined : initialStatus,
      cursor: cursor ?? undefined,
    },
    { enabled: !!currentProjectId },
  );

  // Merge loaded pages (dedupe by id) — cursor pagination can overlap on a
  // page boundary when createdAt isn't strictly monotonic.
  const currentPage = list.data?.items ?? [];
  const items = useMemo(() => {
    const seen = new Set<string>();
    const out: BuildRow[] = [];
    for (const b of [...accumulated, ...currentPage]) {
      if (!seen.has(b.id)) {
        seen.add(b.id);
        out.push(b);
      }
    }
    return out;
  }, [accumulated, currentPage]);

  // Client-side search over the loaded rows (batch name / branch).
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (b) =>
        buildDisplayName(b).toLowerCase().includes(q) ||
        (b.branchName ?? "").toLowerCase().includes(q),
    );
  }, [items, search]);

  const setStatus = (value: BuildAggregateStatus | "all") => {
    const next = new URLSearchParams(params.toString());
    if (value === "all") next.delete("status");
    else next.set("status", value);
    router.replace(`?${next.toString()}`, { scroll: false });
    setCursor(null);
    setAccumulated([]);
  };

  const loadMore = () => {
    if (!list.data?.nextCursor) return;
    setAccumulated((prev) => {
      const seen = new Set(prev.map((b) => b.id));
      const merged = [...prev];
      for (const b of currentPage) {
        if (!seen.has(b.id)) merged.push(b);
      }
      return merged;
    });
    setCursor(list.data.nextCursor);
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

  return (
    <PageContainer fullBleed>
      <div className="flex min-h-0 flex-1 flex-col gap-5 px-6 py-6">
        <PageHeader
          title="Batches"
          description="All test result batches across your project."
          actions={
            <>
              <div className="relative">
                <Search
                  className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-muted"
                  aria-hidden
                />
                <Input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search batches…"
                  className="h-9 w-56 pl-8"
                  data-testid="inbox-search-input"
                />
              </div>
              <Button
                variant="secondary"
                className="h-9 gap-2"
                onClick={() => void list.refetch()}
                disabled={list.isFetching}
                title="Refresh"
              >
                <RefreshCw
                  className={cn("h-4 w-4", list.isFetching && "animate-spin")}
                  aria-hidden
                />
                Refresh
              </Button>
            </>
          }
        />

        <div
          id="inbox-status-filter"
          className="flex flex-wrap items-center gap-2 text-sm"
        >
          <Filter className="h-4 w-4 text-fg-muted" aria-hidden />
          <span className="mr-1 text-xs font-medium uppercase tracking-wide text-fg-muted">
            Status:
          </span>
          {FILTERS.map((f) => {
            const active = f.value === initialStatus;
            return (
              <button
                key={f.value}
                type="button"
                onClick={() => setStatus(f.value)}
                aria-pressed={active}
                className={cn(
                  "rounded-full px-3 py-1 font-medium transition-colors",
                  active
                    ? "bg-fg text-canvas"
                    : "text-fg-secondary hover:bg-hover",
                )}
              >
                {f.label}
              </button>
            );
          })}
        </div>

        <div
          id="inbox-batches-table"
          className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg bg-raised shadow-raised"
        >
          <div className="min-h-0 flex-1 overflow-auto">
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
                {list.isLoading ? (
                  Array.from({ length: 8 }).map((_, i) => (
                    <tr key={i}>
                      <td className="px-5 py-3.5" colSpan={5}>
                        <Skeleton className="h-5 w-full" />
                      </td>
                    </tr>
                  ))
                ) : rows.length === 0 ? (
                  <tr>
                    <td
                      colSpan={5}
                      className="px-5 py-16 text-center text-sm text-fg-muted"
                    >
                      {search
                        ? `No batches match "${search}".`
                        : "No batches yet. Run a test through the SDK to populate this list."}
                    </td>
                  </tr>
                ) : (
                  rows.map((b) => {
                    const href = `/projects/${b.projectId}/builds/${b.id}`;
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
                            className="font-medium text-fg transition-colors group-hover:text-brand-text"
                          >
                            {buildDisplayName(b)}
                          </Link>
                        </td>
                        <td className="px-5 py-3.5 align-middle font-mono text-xs text-fg-muted">
                          {b.branchName ?? "—"}
                        </td>
                        <td className="px-5 py-3.5 align-middle tabular-nums text-fg-secondary">
                          {b.runCount}
                          {b.unresolvedCount > 0 && (
                            <span
                              className={cn(
                                "font-medium",
                                statusStyle("unresolved").text,
                              )}
                            >
                              {" "}
                              ({b.unresolvedCount})
                            </span>
                          )}
                        </td>
                        <td className="px-5 py-3.5 align-middle whitespace-nowrap tabular-nums text-fg-muted">
                          {formatBatchDateTime(b.createdAt)}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
            {list.data?.nextCursor && !search && (
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
