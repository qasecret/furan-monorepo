"use client";

import Link from "next/link";
import { useState } from "react";

import { HistoryTable, type HistoryItem } from "./history-table";

import { DiffPercentSparkline } from "@/components/diff-percent-sparkline";
import { Card } from "@/components/ui/card";
import { useProjectEvents } from "@/hooks/useProjectEvents";
import { trpc } from "@/lib/trpc";

interface Props {
  projectId: string;
  variationId: string;
}

export function VariationHistory({ projectId, variationId }: Props) {
  // testRun_* events on the project SSE channel refresh this variation's
  // history when a new run lands or a reviewer flips a status.
  useProjectEvents(projectId);

  const variation = trpc.variations.get.useQuery({ projectId, variationId });
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [accumulated, setAccumulated] = useState<HistoryItem[]>([]);
  const history = trpc.variations.history.useQuery({
    projectId,
    variationId,
    limit: 25,
    cursor,
  });

  if (variation.isLoading) {
    return <div className="text-sm text-zinc-400">Loading…</div>;
  }
  if (variation.error?.data?.code === "NOT_FOUND") {
    return (
      <Card>
        <h1 className="text-xl font-semibold text-white">
          404 — variation not found
        </h1>
        <p className="text-sm text-zinc-400">
          The variation may have been deleted, or the id is invalid.{" "}
          <Link
            href={`/projects/${projectId}/runs`}
            className="text-brand hover:underline"
          >
            Back to runs
          </Link>
        </p>
      </Card>
    );
  }
  if (variation.error?.data?.code === "FORBIDDEN") {
    return (
      <Card>
        <h1 className="text-xl font-semibold text-white">
          403 — not a project member
        </h1>
        <p className="text-sm text-zinc-400">
          You need to be added to this project to view its variation history.
        </p>
      </Card>
    );
  }
  if (variation.error || !variation.data) {
    return (
      <div className="text-sm text-red-400">
        Error: {variation.error?.message ?? "unknown"}
      </div>
    );
  }

  // Dedupe on id (same shape as runs-table.tsx). Cursor pagination on
  // non-strictly-monotonic createdAt can return overlapping boundary rows.
  const items: HistoryItem[] = [];
  const seen = new Set<string>();
  for (const r of accumulated) {
    if (!seen.has(r.id)) {
      seen.add(r.id);
      items.push(r);
    }
  }
  for (const r of (history.data?.items as unknown as
    | HistoryItem[]
    | undefined) ?? []) {
    if (!seen.has(r.id)) {
      seen.add(r.id);
      items.push(r);
    }
  }
  // Sparkline reads oldest→newest; the table renders newest-first, so we
  // reverse a copy of the items for the chart.
  const sparklineRuns = items
    .slice()
    .reverse()
    .map((r) => ({
      id: r.id,
      status: r.status,
      diffPercent: r.diffPercent,
    }));

  const onLoadMore = () => {
    if (!history.data?.nextCursor) return;
    setAccumulated((prev) => [
      ...prev,
      ...((history.data?.items as unknown as HistoryItem[]) ?? []),
    ]);
    setCursor(history.data.nextCursor);
  };

  return (
    <div className="space-y-4">
      <header className="flex items-center gap-3 text-sm flex-wrap">
        <Link
          href={`/projects/${projectId}/runs`}
          className="text-brand hover:underline"
        >
          ← Runs
        </Link>
        <span
          className="font-mono font-medium text-white"
          data-testid="variation-name"
        >
          {variation.data.name}
        </span>
        <span className="text-zinc-600">·</span>
        <span className="text-zinc-400">{variation.data.browser ?? "—"}</span>
        <span className="text-zinc-600">·</span>
        <span className="text-zinc-400">{variation.data.viewport ?? "—"}</span>
        <span className="text-zinc-600">·</span>
        <span className="text-zinc-400">{variation.data.totalRuns} runs</span>
      </header>
      <DiffPercentSparkline runs={sparklineRuns} />
      <HistoryTable
        projectId={projectId}
        items={items}
        nextCursor={history.data?.nextCursor ?? null}
        onLoadMore={onLoadMore}
      />
    </div>
  );
}
