"use client";

import {
  Activity,
  Clock,
  ShieldCheck,
  TrendingDown,
  TrendingUp,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { statusStyle } from "@/lib/status-style";

interface Summary {
  totalActions: number;
  approves: number;
  rejects: number;
  sessions: number;
  approveRate: number;
  keyboardRate: number;
  medianMsPerAction: number;
  medianTimeToFirstActionMs: number;
  prevTotalActions: number;
  prevApproveRate: number;
}

interface TestSummary {
  total: number;
  passed: number;
  failed: number;
  unresolved: number;
  passRate: number;
  prevTotal: number;
  prevPassRate: number;
}

interface Props {
  summary: Summary | undefined;
  testSummary: TestSummary | undefined;
  isLoading: boolean;
  days: number;
}

function fmtMs(ms: number | null | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return "—";
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${(seconds / 60).toFixed(0)}m ${Math.round(seconds % 60)}s`;
}

function delta(
  current: number | undefined,
  previous: number | undefined,
): string | null {
  if (current == null || previous == null) return null;
  if (previous === 0 && current === 0) return null;
  if (previous === 0) return "+100%";
  const pct = ((current - previous) / previous) * 100;
  if (!Number.isFinite(pct) || Math.abs(pct) < 0.1) return null;
  return `${pct > 0 ? "+" : ""}${pct.toFixed(0)}%`;
}

function deltaRate(
  current: number | undefined,
  previous: number | undefined,
): string | null {
  if (current == null || previous == null) return null;
  if (current === 0 && previous === 0) return null;
  const diff = (current - previous) * 100;
  if (!Number.isFinite(diff) || Math.abs(diff) < 0.1) return null;
  return `${diff > 0 ? "+" : ""}${diff.toFixed(1)}%`;
}

function Tile({
  icon: Icon,
  label,
  value,
  trend,
  up,
  isLoading,
}: {
  icon: LucideIcon;
  label: string;
  value: ReactNode;
  trend: string | null;
  up: boolean;
  isLoading: boolean;
}) {
  return (
    <div className="rounded-lg bg-raised p-5 shadow-raised">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-edge bg-hover">
          <Icon className="h-4 w-4 text-brand-text" />
        </div>
        {!isLoading && trend && (
          <div
            className={`flex items-center gap-1 text-xs font-medium tabular-nums ${
              up ? statusStyle("passed").text : statusStyle("failed").text
            }`}
          >
            {up ? (
              <TrendingUp className="h-3 w-3" />
            ) : (
              <TrendingDown className="h-3 w-3" />
            )}
            {trend}
          </div>
        )}
      </div>
      {isLoading ? (
        <Skeleton className="mb-1 h-8 w-20" />
      ) : (
        <div className="mb-1 text-2xl font-semibold tabular-nums text-fg">
          {value}
        </div>
      )}
      <div className="text-xs text-fg-muted">{label}</div>
    </div>
  );
}

export function KpiCards({ summary, testSummary, isLoading, days }: Props) {
  const runsDelta =
    testSummary && delta(testSummary.total, testSummary.prevTotal);
  const runsUp = testSummary
    ? testSummary.total >= testSummary.prevTotal
    : true;

  const passRateDelta =
    testSummary && deltaRate(testSummary.passRate, testSummary.prevPassRate);
  const passRateUp = testSummary
    ? testSummary.passRate >= testSummary.prevPassRate
    : true;

  const approveRateDelta =
    summary && deltaRate(summary.approveRate, summary.prevApproveRate);
  const approveRateUp = summary
    ? summary.approveRate >= summary.prevApproveRate
    : true;

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
      <Tile
        icon={Activity}
        label={`Test runs (${days}d)`}
        value={testSummary?.total.toLocaleString() ?? "—"}
        trend={runsDelta ?? null}
        up={runsUp}
        isLoading={isLoading}
      />
      <Tile
        icon={Clock}
        label="Avg time to review"
        value={fmtMs(summary?.medianMsPerAction)}
        trend={null}
        up={true}
        isLoading={isLoading}
      />
      <Tile
        icon={ShieldCheck}
        label="Pass rate"
        value={testSummary ? `${Math.round(testSummary.passRate * 100)}%` : "—"}
        trend={passRateDelta ?? null}
        up={passRateUp}
        isLoading={isLoading}
      />
      <Tile
        icon={TrendingUp}
        label="Approve rate"
        value={summary ? `${Math.round(summary.approveRate * 100)}%` : "—"}
        trend={approveRateDelta ?? null}
        up={approveRateUp}
        isLoading={isLoading}
      />
    </div>
  );
}
