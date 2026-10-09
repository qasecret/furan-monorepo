"use client";

import { useState } from "react";

import { ActionsByDayChart } from "./actions-by-day-chart";
import { KpiCards } from "./kpi-cards";
import { RunsByDayChart } from "./runs-by-day-chart";
import { TopFragileTests } from "./top-fragile-tests";
import { TopReviewers } from "./top-reviewers";

import { useCurrentProject } from "@/app/(protected)/_components/current-project-provider";
import { PageContainer } from "@/components/ui/page-container";
import { trpc } from "@/lib/trpc";

const WINDOWS = [7, 14, 30] as const;
type Window = (typeof WINDOWS)[number];

const CARD = "rounded-lg bg-raised shadow-raised";

function ChartCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`${CARD} overflow-hidden p-5`}>
      <div className="mb-4">
        <h3 className="text-sm font-medium text-fg">{title}</h3>
        <p className="mt-0.5 text-xs text-fg-muted">{subtitle}</p>
      </div>
      {children}
    </div>
  );
}

export function AnalyticsPage() {
  const [days, setDays] = useState<Window>(7);
  const { currentProjectId } = useCurrentProject();

  const summary = trpc.analytics.summary.useQuery({ days });
  const byDay = trpc.analytics.actionsByDay.useQuery({ days });
  const top = trpc.analytics.topReviewers.useQuery({ days, limit: 5 });

  const testSummary = trpc.analytics.testResultsSummary.useQuery(
    { days, projectId: currentProjectId! },
    { enabled: !!currentProjectId },
  );
  const runsByDay = trpc.analytics.runsByDay.useQuery(
    { days, projectId: currentProjectId! },
    { enabled: !!currentProjectId },
  );
  const fragile = trpc.analytics.topFragileTests.useQuery(
    { days, projectId: currentProjectId!, limit: 6 },
    { enabled: !!currentProjectId },
  );

  return (
    <PageContainer fullBleed>
      <header className="border-b border-edge px-6 py-5">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-fg">Insights</h1>
            <p className="mt-1 text-sm text-fg-muted">
              Analytics across your test suite and visual quality trends.
            </p>
          </div>
          <div className="flex items-center gap-1 rounded-lg border border-edge bg-sunken p-1">
            {WINDOWS.map((w) => (
              <button
                key={w}
                onClick={() => setDays(w)}
                className={
                  w === days
                    ? "rounded-md px-3 py-1.5 text-xs font-medium tabular-nums bg-raised text-fg shadow-raised focus-ring"
                    : "rounded-md px-3 py-1.5 text-xs font-medium tabular-nums text-fg-muted hover:text-fg focus-ring"
                }
                data-testid={`analytics-window-${w}d`}
              >
                {w}d
              </button>
            ))}
          </div>
        </div>
      </header>

      <div className="flex-1 space-y-6 overflow-y-auto p-6">
        {/* ── KPI tiles ── */}
        <KpiCards
          summary={summary.data}
          testSummary={testSummary.data}
          isLoading={
            summary.isLoading || (testSummary.isLoading && !!currentProjectId)
          }
          days={days}
        />

        {/* ── 3-column chart grid ── */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <ChartCard
            title="Review actions over time"
            subtitle={`Approves & rejects per day (${days}d)`}
          >
            <ActionsByDayChart
              items={byDay.data?.items ?? []}
              isLoading={byDay.isLoading}
            />
          </ChartCard>

          <ChartCard
            title="Pass / Fail trend"
            subtitle={`Test run outcomes (${days}d)`}
          >
            <RunsByDayChart
              items={runsByDay.data?.items ?? []}
              isLoading={runsByDay.isLoading && !!currentProjectId}
            />
          </ChartCard>

          <ChartCard title="Top reviewers" subtitle={`Most active (${days}d)`}>
            <TopReviewers
              items={top.data?.items ?? []}
              isLoading={top.isLoading}
            />
          </ChartCard>
        </div>

        {/* ── Full-width fragile tests table ── */}
        {currentProjectId && (
          <div className={`${CARD} overflow-hidden`}>
            <div className="border-b border-edge px-6 py-4">
              <h2 className="text-base font-medium text-fg">
                Top fragile tests
              </h2>
              <p className="mt-1 text-xs text-fg-muted">
                Tests with the lowest pass rate in the last {days} days
              </p>
            </div>
            <TopFragileTests
              items={fragile.data?.items ?? []}
              isLoading={fragile.isLoading}
            />
          </div>
        )}
      </div>
    </PageContainer>
  );
}
