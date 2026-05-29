"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

interface Item {
  // null when the action's user row has been deleted (FK is set to
  // null on delete). The chart still surfaces these as "(deleted user)"
  // so the row count matches the summary card's totalActions.
  userId: string | null;
  email: string | null;
  actions: number;
}

interface Props {
  items: Item[];
  isLoading: boolean;
}

export function TopReviewers({ items, isLoading }: Props) {
  if (isLoading) {
    return (
      <div className="h-64 rounded-lg border border-zinc-200 bg-zinc-50 animate-pulse dark:border-zinc-800 dark:bg-zinc-900/30" />
    );
  }
  if (items.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center rounded-lg border border-zinc-200 bg-white text-sm text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900/30 dark:text-zinc-500">
        No reviewer activity in this window.
      </div>
    );
  }
  // Recharts horizontal bars: pass `layout="vertical"` and X = number, Y = category.
  return (
    <div className="h-64 rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900/30">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          layout="vertical"
          data={items.map((i) => ({
            email:
              i.email ??
              (i.userId == null ? "(deleted user)" : i.userId.slice(0, 8)),
            actions: i.actions,
          }))}
          margin={{ left: 60 }}
        >
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="var(--chart-grid)"
            horizontal={false}
          />
          <XAxis
            type="number"
            stroke="var(--chart-axis)"
            fontSize={11}
            allowDecimals={false}
          />
          <YAxis
            type="category"
            dataKey="email"
            stroke="var(--chart-axis)"
            fontSize={11}
            width={150}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: "var(--chart-tooltip-bg)",
              border: "1px solid var(--chart-tooltip-border)",
              borderRadius: 6,
              fontSize: 12,
            }}
          />
          <Bar
            dataKey="actions"
            fill="var(--chart-bar)"
            radius={[0, 4, 4, 0]}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
