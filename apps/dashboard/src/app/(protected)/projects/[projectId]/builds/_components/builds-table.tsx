"use client";

import Link from "next/link";
import { useState } from "react";

import { BuildRow, type BuildRowData } from "./build-row";
import { BuildRunsDrawer } from "./build-runs-drawer";
import { PropertiesFilter } from "./properties-filter";

import { Button } from "@/components/ui/button";
import { useProjectEvents } from "@/hooks/useProjectEvents";
import { browserEnv } from "@/lib/env";
import { FURAN_SDK_VERSION } from "@/lib/sdk-version";
import { trpc } from "@/lib/trpc";

interface Props {
  projectId: string;
}

/**
 * Client island that owns the cursor-pagination + expand-row state for the
 * Builds tab. Mirrors the manual-cursor pattern from RunsTable rather than
 * `useInfiniteQuery` so filter-change resets are explicit.
 */
export function BuildsTable({ projectId }: Props) {
  // Subscribe to the project SSE channel: build/run create/update/delete
  // events invalidate the builds + runs list caches so this table refetches
  // automatically when a CI run lands or a reviewer approves.
  useProjectEvents(projectId);

  const [properties, setProperties] = useState<Record<string, string>>({});
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [accumulated, setAccumulated] = useState<BuildRowData[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);

  const { data, isLoading, error } = trpc.builds.list.useQuery({
    projectId,
    cursor,
    limit: 25,
    properties: Object.keys(properties).length > 0 ? properties : undefined,
  });

  // Dedupe on id across `accumulated` and the current page — cursor
  // pagination on a non-strictly-monotonic createdAt could legitimately
  // return overlapping rows on a page boundary; React would warn about
  // duplicate keys.
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
    setExpanded(null);
  };

  return (
    <div className="space-y-3">
      <PropertiesFilter
        projectId={projectId}
        value={properties}
        onChange={onPropertiesChange}
      />
      {isLoading && !data ? (
        <div className="text-sm text-zinc-600 dark:text-zinc-400">Loading…</div>
      ) : error ? (
        <div className="text-sm text-red-600 dark:text-red-400">
          Error: {error.message}
        </div>
      ) : items.length === 0 ? (
        <EmptyBuildsState projectId={projectId} />
      ) : (
        <div
          className="rounded-xl border border-zinc-200 bg-white overflow-hidden dark:border-zinc-800 dark:bg-zinc-950"
          data-testid="builds-table"
        >
          {items.map((b) => (
            <div key={b.id}>
              <BuildRow
                build={b}
                expanded={expanded === b.id}
                onToggleExpand={() =>
                  setExpanded((cur) => (cur === b.id ? null : b.id))
                }
                onPropertyClick={(k, v) =>
                  onPropertiesChange({ ...properties, [k]: v })
                }
              />
              {expanded === b.id && (
                <BuildRunsDrawer projectId={projectId} buildId={b.id} />
              )}
            </div>
          ))}
        </div>
      )}
      {data?.nextCursor && items.length > 0 && (
        <div className="flex justify-center">
          <Button variant="secondary" onClick={onLoadMore}>
            Load more
          </Button>
        </div>
      )}
    </div>
  );
}

function EmptyBuildsState({ projectId }: { projectId: string }) {
  return (
    <div className="rounded-xl border border-dashed border-zinc-300 bg-zinc-50 p-6 text-sm text-zinc-700 dark:border-zinc-800 dark:bg-zinc-950/50 dark:text-zinc-300">
      <p className="font-medium text-zinc-950 dark:text-white">
        No builds yet for this project.
      </p>
      <p className="mt-1 text-zinc-600 dark:text-zinc-400">
        Connect the SDK to start sending runs. Project id:{" "}
        <code className="font-mono text-xs text-zinc-700 dark:text-zinc-300">
          {projectId}
        </code>
      </p>
      <pre className="mt-3 overflow-x-auto rounded-md border border-zinc-200 bg-zinc-100 text-zinc-900 p-3 text-xs dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100">
        {`# Gradle dependency
implementation("io.github.qasecret:furan-selenium:${FURAN_SDK_VERSION}")

# Env vars for CI
FURAN_API_URL=${browserEnv.NEXT_PUBLIC_API_URL}
FURAN_API_TOKEN=furan_pat_…           # create one at /account/tokens
FURAN_PROJECT_ID=${projectId}
FURAN_BUILD_ID=\${GITHUB_RUN_ID:-local}

# Optional labels (example values — customize for your CI):
FURAN_BUILD_NAME="nightly main"
FURAN_BUILD_PROPERTIES=region=us-east-1,shard=\${SHARD:-1}`}
      </pre>
      <Link
        href="/account/tokens"
        className="mt-3 inline-block text-brand-text hover:underline"
        data-testid="empty-builds-cta-token-link"
      >
        Create a personal access token →
      </Link>
    </div>
  );
}
