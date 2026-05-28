"use client";

import { useState } from "react";

import { ActionsByDayChart } from "./actions-by-day-chart";
import { KpiCards } from "./kpi-cards";
import { TopReviewers } from "./top-reviewers";

import { trpc } from "@/lib/trpc";

const WINDOWS = [7, 14, 30] as const;
type Window = (typeof WINDOWS)[number];

export function AnalyticsPage() {
  const [days, setDays] = useState<Window>(7);

  const summary = trpc.analytics.summary.useQuery({ days });
  const byDay = trpc.analytics.actionsByDay.useQuery({ days });
  const top = trpc.analytics.topReviewers.useQuery({ days, limit: 5 });

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-zinc-200 px-4 py-4 dark:border-zinc-900">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-zinc-950 dark:text-white">
              Analytics
            </h1>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              Reviewer activity, sourced from dashboard telemetry events.
            </p>
          </div>
          <div className="flex items-center gap-1 rounded-md border border-zinc-200 bg-zinc-100 p-1 dark:border-zinc-800 dark:bg-zinc-900">
            {WINDOWS.map((w) => (
              <button
                key={w}
                onClick={() => setDays(w)}
                className={
                  w === days
                    ? "rounded px-2 py-1 text-xs font-medium bg-zinc-300 text-zinc-950 dark:bg-zinc-700 dark:text-white"
                    : "rounded px-2 py-1 text-xs font-medium text-zinc-600 hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-white"
                }
                data-testid={`analytics-window-${w}d`}
              >
                {w}d
              </button>
            ))}
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-6 space-y-6">
        <KpiCards summary={summary.data} isLoading={summary.isLoading} />

        <section>
          <h2 className="mb-3 text-sm font-medium text-zinc-700 dark:text-zinc-300">
            Actions per day
          </h2>
          <ActionsByDayChart
            items={byDay.data?.items ?? []}
            isLoading={byDay.isLoading}
          />
        </section>

        <section>
          <h2 className="mb-3 text-sm font-medium text-zinc-700 dark:text-zinc-300">
            Top reviewers
          </h2>
          <TopReviewers
            items={top.data?.items ?? []}
            isLoading={top.isLoading}
          />
        </section>
      </div>
    </div>
  );
}
