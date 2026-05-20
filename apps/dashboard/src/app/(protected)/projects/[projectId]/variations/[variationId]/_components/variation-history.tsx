"use client";

import Link from "next/link";
import { useState } from "react";

import { HistoryTable, type HistoryItem } from "./history-table";

import { DiffPercentSparkline } from "@/components/diff-percent-sparkline";
import { Card } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";

interface Props {
  projectId: string;
  variationId: string;
}

export function VariationHistory({ projectId, variationId }: Props) {
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
    return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  }
  if (variation.error?.data?.code === "NOT_FOUND") {
    return (
      <Card>
        <h1 className="text-xl font-bold">404 — variation not found</h1>
        <p className="text-sm text-neutral-600">
          The variation may have been deleted, or the id is invalid.{" "}
          <Link
            href={`/projects/${projectId}/runs`}
            className="text-blue-700 hover:underline"
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
        <h1 className="text-xl font-bold">403 — not a project member</h1>
        <p className="text-sm text-neutral-600">
          You need to be added to this project to view its variation history.
        </p>
      </Card>
    );
  }
  if (variation.error || !variation.data) {
    return (
      <div className="p-6 text-sm text-destructive">
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
    <div className="space-y-4 p-6">
      <header className="flex items-center gap-3 text-sm flex-wrap">
        <Link
          href={`/projects/${projectId}/runs`}
          className="text-blue-700 hover:underline"
        >
          ← Runs
        </Link>
        <span className="font-mono font-medium" data-testid="variation-name">
          {variation.data.name}
        </span>
        <span className="text-neutral-400">·</span>
        <span className="text-neutral-600">
          {variation.data.browser ?? "—"}
        </span>
        <span className="text-neutral-400">·</span>
        <span className="text-neutral-600">
          {variation.data.viewport ?? "—"}
        </span>
        <span className="text-neutral-400">·</span>
        <span className="text-neutral-600">
          {variation.data.totalRuns} runs
        </span>
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
