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
import { serializeReviewContext, useReviewContext } from "@/lib/review-url";
import { FURAN_SDK_VERSION } from "@/lib/sdk-version";
import { trpc } from "@/lib/trpc";

interface Props {
  projectId: string;
}

/** The pages of the list loaded so far, and the filter they were loaded under. */
interface Paging {
  key: string;
  cursor: string | undefined;
  accumulated: BuildRowData[];
}

const firstPage = (key: string): Paging => ({
  key,
  cursor: undefined,
  accumulated: [],
});

/** Persistent context panel: filter + builds list. */
export function BuildsListPanel({ projectId }: Props) {
  useProjectEvents(projectId);
  const pathname = usePathname();
  const selectedId = pathname?.split("/builds/")[1]?.split("/")[0];

  // The properties filter lives in the URL (`?props=`), so it survives a
  // reload and Back, and the batch links below carry it.
  const [context, setContext] = useReviewContext();
  const properties = context.props ?? {};
  const hasActiveFilter = Object.keys(properties).length > 0;
  const propsKey = serializeReviewContext(context, ["props"]);

  const [filterOpen, setFilterOpen] = useState(false);
  // The pages loaded so far, for the filter they were loaded under: any change
  // of `props` (a chip, or Back / Forward) starts the pages over.
  const [paging, setPaging] = useState<Paging>(() => firstPage(propsKey));
  let page = paging;
  if (paging.key !== propsKey) {
    // Adjusting state while rendering: React re-renders at once, before paint.
    page = firstPage(propsKey);
    setPaging(page);
  }

  const { data, isLoading, error, refetch, isFetching, isPlaceholderData } =
    trpc.builds.list.useQuery(
      {
        projectId,
        cursor: page.cursor,
        limit: 25,
        properties: hasActiveFilter ? properties : undefined,
      },
      { placeholderData: keepPreviousData },
    );

  const showFilter = filterOpen || hasActiveFilter;

  const items: BuildRowData[] = [];
  const seen = new Set<string>();
  for (const b of page.accumulated) {
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
    // While the previous filter's page is still showing (`placeholderData`), its
    // cursor is not this filter's: appending it would page the new filter from
    // the old one's place.
    if (isPlaceholderData || !data?.nextCursor) return;
    setPaging({
      key: propsKey,
      cursor: data.nextCursor,
      accumulated: [...page.accumulated, ...data.items],
    });
  };

  // Writes the URL; the list follows it (and starts over) on the next render.
  const onPropertiesChange = (next: Record<string, string>) => {
    setContext({ props: Object.keys(next).length > 0 ? next : undefined });
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-edge bg-sunken px-3 py-2.5">
        <span className="text-2xs font-medium uppercase tracking-wide text-fg-muted">
          Recent batch runs
        </span>
        {items.length > 0 && (
          <span className="rounded-full bg-hover px-1.5 py-0.5 text-2xs font-medium tabular-nums text-fg-muted">
            {items.length}
          </span>
        )}
      </div>
      <div className="flex items-center gap-1 border-b border-edge px-2 py-1.5">
        <button
          type="button"
          onClick={() => void refetch?.()}
          aria-label="Refresh batch runs"
          data-testid="builds-refresh"
          className="rounded p-1.5 text-fg-muted transition-colors hover:bg-hover hover:text-fg focus-ring"
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
            "relative rounded p-1.5 transition-colors focus-ring",
            showFilter
              ? "bg-hover text-fg"
              : "text-fg-muted hover:bg-hover hover:text-fg",
          )}
        >
          <Filter className="h-4 w-4" aria-hidden />
          {hasActiveFilter ? (
            <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-brand" />
          ) : null}
        </button>
      </div>
      {showFilter ? (
        <div className="border-b border-edge p-2">
          <PropertiesFilter
            projectId={projectId}
            value={properties}
            onChange={onPropertiesChange}
          />
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto" data-testid="builds-list">
        {isLoading && !data ? (
          <p className="p-3 text-sm text-fg-muted">Loading…</p>
        ) : error ? (
          <p className="p-3 text-sm text-destructive">Error: {error.message}</p>
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
          <div className="divide-y divide-edge-subtle">
            {items.map((b) => (
              <BuildListItem
                key={b.id}
                build={b}
                projectId={projectId}
                selected={b.id === selectedId}
                context={context}
              />
            ))}
          </div>
        )}
      </div>
      {data?.nextCursor && items.length > 0 && (
        <div className="border-t border-edge p-2">
          <Button
            variant="secondary"
            onClick={onLoadMore}
            disabled={isPlaceholderData}
            className="h-8 w-full text-xs"
          >
            Load more
          </Button>
        </div>
      )}
    </div>
  );
}
