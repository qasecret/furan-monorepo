"use client";

import type { BuildAggregateStatus } from "@furan/shared-types";
import { RefreshCw, Search } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";

import { useCurrentProject } from "@/app/(protected)/_components/current-project-provider";
import { BuildStatusBadge } from "@/components/build-status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageContainer } from "@/components/ui/page-container";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableEmpty,
  TableHead,
  TableHeader,
  TableLink,
  TableRow,
} from "@/components/ui/table";
import { useProjectEvents } from "@/hooks/useProjectEvents";
import { buildDisplayName } from "@/lib/build-display-name";
import { cn } from "@/lib/cn";
import { formatRelativeTime } from "@/lib/format";
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
    setAccumulated(items);
    setCursor(list.data.nextCursor);
  };

  if (!currentProjectId) {
    return (
      <div
        className="flex flex-1 items-center justify-center p-10 text-center text-sm text-zinc-500"
        data-testid="inbox-no-project"
      >
        No project assigned. Ask an admin to add you to a project.
      </div>
    );
  }

  return (
    <PageContainer>
      <div className="space-y-6">
        <PageHeader
          title="Batches"
          description="All test result batches across your project."
          actions={
            <>
              <div className="relative">
                <Search
                  className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400"
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
          <span className="mr-1 text-xs font-medium uppercase tracking-wide text-zinc-500">
            Status
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
                    ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                    : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-900",
                )}
              >
                {f.label}
              </button>
            );
          })}
        </div>

        <div id="inbox-batches-table">
          <Table>
            <TableHeader>
              <tr>
                <TableHead className="w-32">Status</TableHead>
                <TableHead>Batch</TableHead>
                <TableHead>Branch</TableHead>
                <TableHead className="w-24">Tests</TableHead>
                <TableHead className="w-44">Started</TableHead>
              </tr>
            </TableHeader>
            <TableBody>
              {list.isLoading ? (
                Array.from({ length: 6 }).map((_, i) => (
                  <tr key={i}>
                    <TableCell colSpan={5}>
                      <Skeleton className="h-5 w-full" />
                    </TableCell>
                  </tr>
                ))
              ) : rows.length === 0 ? (
                <TableEmpty colSpan={5}>
                  {search
                    ? `No batches match "${search}".`
                    : "No batches yet. Run a test through the SDK to populate this list."}
                </TableEmpty>
              ) : (
                rows.map((b) => {
                  const href = `/projects/${b.projectId}/builds/${b.id}`;
                  return (
                    <TableRow
                      key={b.id}
                      onClick={() => router.push(href)}
                      className="cursor-pointer"
                      data-testid={`inbox-batch-row-${b.id}`}
                    >
                      <TableCell>
                        <BuildStatusBadge status={b.aggregateStatus} />
                      </TableCell>
                      <TableCell>
                        <TableLink
                          href={href}
                          onClick={(e) => e.stopPropagation()}
                        >
                          {buildDisplayName(b)}
                        </TableLink>
                      </TableCell>
                      <TableCell className="font-mono text-xs text-zinc-500 dark:text-zinc-400">
                        {b.branchName ?? "—"}
                      </TableCell>
                      <TableCell className="tabular-nums text-zinc-600 dark:text-zinc-400">
                        {b.runCount}
                        {b.unresolvedCount > 0 && (
                          <span className="font-medium text-red-500">
                            {" "}
                            ({b.unresolvedCount})
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-zinc-500 dark:text-zinc-400">
                        {formatRelativeTime(b.createdAt)}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>

        {list.data?.nextCursor && !search && (
          <div className="flex justify-center">
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
    </PageContainer>
  );
}
