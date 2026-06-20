"use client";

import type { ReactNode } from "react";

import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

interface Summary {
  totalActions: number;
  approves: number;
  rejects: number;
  sessions: number;
  approveRate: number;
  keyboardRate: number;
  medianMsPerAction: number;
  medianTimeToFirstActionMs: number;
}

interface Props {
  summary: Summary | undefined;
  isLoading: boolean;
}

function fmtPercent(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

function fmtMs(ms: number | null | undefined): string {
  // Guard NaN / Infinity / null / undefined / non-positive — all collapse
  // to the "no data" em-dash.
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return "—";
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${(seconds / 60).toFixed(1)}m`;
}

/** Recessed metric tile: adopts the Card primitive's border/radius. */
function MetricCard({
  label,
  value,
  sub,
  accessory,
  isLoading,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  accessory?: ReactNode;
  isLoading: boolean;
}) {
  return (
    <Card className="bg-zinc-50 p-4 dark:bg-zinc-900/50">
      <div className="text-xs text-zinc-600 dark:text-zinc-400">{label}</div>
      {isLoading ? (
        <Skeleton data-testid="kpi-skeleton" className="mt-2 h-7 w-16" />
      ) : (
        <div className="mt-2 text-2xl font-semibold tabular-nums text-zinc-950 dark:text-white">
          {value}
        </div>
      )}
      {!isLoading && accessory}
      {sub ? <div className="mt-1 text-xs text-zinc-500">{sub}</div> : null}
    </Card>
  );
}

/** Approve/reject proportion bar, sized by raw counts (exact, no rate math). */
function SplitBar({
  approves,
  rejects,
}: {
  approves: number;
  rejects: number;
}) {
  return (
    <div className="mt-2 flex h-1 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
      <div
        className="bg-[var(--chart-approves)]"
        style={{ flexGrow: approves }}
      />
      <div
        className="bg-[var(--chart-rejects)]"
        style={{ flexGrow: rejects }}
      />
    </div>
  );
}

export function KpiCards({ summary, isLoading }: Props) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
      <MetricCard
        label="Actions"
        isLoading={isLoading}
        value={summary ? summary.totalActions.toLocaleString() : "—"}
        sub="approve + reject"
      />
      <MetricCard
        label="Approve rate"
        isLoading={isLoading}
        value={summary ? fmtPercent(summary.approveRate) : "—"}
        accessory={
          summary ? (
            <SplitBar approves={summary.approves} rejects={summary.rejects} />
          ) : undefined
        }
        sub={
          summary
            ? `${summary.approves.toLocaleString()} approve · ${summary.rejects.toLocaleString()} reject`
            : "of total actions"
        }
      />
      <MetricCard
        label="Keyboard"
        isLoading={isLoading}
        value={summary ? fmtPercent(summary.keyboardRate) : "—"}
        sub="a/r keys vs mouse"
      />
      <MetricCard
        label="Sessions"
        isLoading={isLoading}
        value={summary ? summary.sessions.toLocaleString() : "—"}
        sub="review sittings"
      />
      <MetricCard
        label="Median time / action"
        isLoading={isLoading}
        value={summary ? fmtMs(summary.medianMsPerAction) : "—"}
        sub="per approve · reject"
      />
      <MetricCard
        label="Time to first action"
        isLoading={isLoading}
        value={summary ? fmtMs(summary.medianTimeToFirstActionMs) : "—"}
        sub="median per session"
      />
    </div>
  );
}
