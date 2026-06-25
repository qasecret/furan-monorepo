"use client";

import { keepPreviousData } from "@tanstack/react-query";
import { Filter, RefreshCw } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

import { BuildListItem } from "./build-list-item";
import type { BuildRowData } from "./build-types";
import { PropertiesFilter } from "./properties-filter";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { useProjectEvents } from "@/hooks/useProjectEvents";
import { cn } from "@/lib/cn";
import { browserEnv } from "@/lib/env";
import { FURAN_SDK_VERSION } from "@/lib/sdk-version";
import { trpc } from "@/lib/trpc";

interface Props {
  projectId: string;
}

/** Persistent context panel: filter + builds list. */
export function BuildsListPanel({ projectId }: Props) {
  useProjectEvents(projectId);
  const pathname = usePathname();
  const selectedId = pathname?.split("/builds/")[1]?.split("/")[0];

  const [properties, setProperties] = useState<Record<string, string>>({});
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [accumulated, setAccumulated] = useState<BuildRowData[]>([]);
  const [filterOpen, setFilterOpen] = useState(false);

  const { data, isLoading, error, refetch, isFetching } =
    trpc.builds.list.useQuery(
      {
        projectId,
        cursor,
        limit: 25,
        properties: Object.keys(properties).length > 0 ? properties : undefined,
      },
      { placeholderData: keepPreviousData },
    );

  const hasActiveFilter = Object.keys(properties).length > 0;
  const showFilter = filterOpen || hasActiveFilter;

  const items: BuildRowData[] = [];
  const seen = new Set<string>();
  for (const b of accumulated) {
    if (!seen.has(b.id)) {
      seen.add(b.id);
      items.push(b);
    }
  }
  for (const b of data?.items ?? []) {
    if (!seen.has(b.id)) {
      seen.add(b.id);
      items.push(b);
    }
  }

  const onLoadMore = () => {
    if (!data?.nextCursor) return;
    setAccumulated((prev) => [...prev, ...data.items]);
    setCursor(data.nextCursor);
  };

  const onPropertiesChange = (next: Record<string, string>) => {
    setProperties(next);
    setAccumulated([]);
    setCursor(undefined);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-zinc-200 px-3 py-2.5 dark:border-zinc-800">
        <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">
          Recent batch runs
        </span>
        {items.length > 0 && (
          <span className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
            {items.length}
          </span>
        )}
      </div>
      <div className="flex items-center gap-1 border-b border-zinc-200 px-2 py-1.5 dark:border-zinc-800">
        <button
          type="button"
          onClick={() => void refetch?.()}
          aria-label="Refresh batch runs"
          data-testid="builds-refresh"
          className="rounded p-1.5 text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-white"
        >
          <RefreshCw
            className={cn("h-4 w-4", isFetching && "animate-spin")}
            aria-hidden
          />
        </button>
        <button
          type="button"
          onClick={() => setFilterOpen((v) => !v)}
          aria-label="Filter batch runs"
          aria-pressed={showFilter}
          data-testid="builds-filter-toggle"
          className={cn(
            "relative rounded p-1.5 transition-colors",
            showFilter
              ? "bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-white"
              : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-white",
          )}
        >
          <Filter className="h-4 w-4" aria-hidden />
          {hasActiveFilter ? (
            <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-brand" />
          ) : null}
        </button>
      </div>
      {showFilter ? (
        <div className="border-b border-zinc-200 p-2 dark:border-zinc-800">
          <PropertiesFilter
            projectId={projectId}
            value={properties}
            onChange={onPropertiesChange}
          />
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto" data-testid="builds-list">
        {isLoading && !data ? (
          <p className="p-3 text-sm text-zinc-500">Loading…</p>
        ) : error ? (
          <p className="p-3 text-sm text-red-600 dark:text-red-400">
            Error: {error.message}
          </p>
        ) : items.length === 0 ? (
          <div className="p-3">
            <EmptyState
              title="No builds yet"
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
                  className="text-brand-text hover:underline"
                  data-testid="empty-builds-cta-token-link"
                >
                  Create a personal access token →
                </Link>
              }
            />
          </div>
        ) : (
          <div className="divide-y divide-zinc-100 dark:divide-zinc-900">
            {items.map((b) => (
              <BuildListItem
                key={b.id}
                build={b}
                projectId={projectId}
                selected={b.id === selectedId}
              />
            ))}
          </div>
        )}
      </div>
      {data?.nextCursor && items.length > 0 && (
        <div className="border-t border-zinc-200 p-2 dark:border-zinc-800">
          <Button
            variant="secondary"
            onClick={onLoadMore}
            className="h-8 w-full text-xs"
          >
            Load more
          </Button>
        </div>
      )}
    </div>
  );
}
