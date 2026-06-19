"use client";

import { keepPreviousData } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

import { BuildListItem } from "./build-list-item";
import type { BuildRowData } from "./build-types";
import { ProjectSwitcher, type ProjectListItem } from "./project-switcher";
import { PropertiesFilter } from "./properties-filter";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { useProjectEvents } from "@/hooks/useProjectEvents";
import { browserEnv } from "@/lib/env";
import { FURAN_SDK_VERSION } from "@/lib/sdk-version";
import { trpc } from "@/lib/trpc";

interface Props {
  projectId: string;
  projects: ProjectListItem[];
}

/** Persistent context panel: project switcher + filter + builds list. */
export function BuildsListPanel({ projectId, projects }: Props) {
  useProjectEvents(projectId);
  const pathname = usePathname();
  const selectedId = pathname?.split("/builds/")[1]?.split("/")[0];

  const [properties, setProperties] = useState<Record<string, string>>({});
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [accumulated, setAccumulated] = useState<BuildRowData[]>([]);

  const { data, isLoading, error } = trpc.builds.list.useQuery(
    {
      projectId,
      cursor,
      limit: 25,
      properties: Object.keys(properties).length > 0 ? properties : undefined,
    },
    { placeholderData: keepPreviousData },
  );

  const items: BuildRowData[] = [];
  const seen = new Set<string>();
  for (const b of accumulated) {
    if (!seen.has(b.id)) {
      seen.add(b.id);
      items.push(b);
    }
  }
  for (const b of (data?.items as unknown as BuildRowData[] | undefined) ??
    []) {
    if (!seen.has(b.id)) {
      seen.add(b.id);
      items.push(b);
    }
  }

  const onLoadMore = () => {
    if (!data?.nextCursor) return;
    setAccumulated((prev) => [
      ...prev,
      ...((data.items as unknown as BuildRowData[]) ?? []),
    ]);
    setCursor(data.nextCursor);
  };

  const onPropertiesChange = (next: Record<string, string>) => {
    setProperties(next);
    setAccumulated([]);
    setCursor(undefined);
  };

  return (
    <div className="flex h-full flex-col gap-3 p-3">
      <ProjectSwitcher projectId={projectId} projects={projects} />
      <PropertiesFilter
        projectId={projectId}
        value={properties}
        onChange={onPropertiesChange}
      />
      <div className="min-h-0 flex-1 overflow-y-auto" data-testid="builds-list">
        {isLoading && !data ? (
          <p className="px-1 text-sm text-zinc-500">Loading…</p>
        ) : error ? (
          <p className="px-1 text-sm text-red-600 dark:text-red-400">
            Error: {error.message}
          </p>
        ) : items.length === 0 ? (
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
        ) : (
          <div className="space-y-1">
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
        <Button variant="secondary" onClick={onLoadMore} className="w-full">
          Load more
        </Button>
      )}
    </div>
  );
}
