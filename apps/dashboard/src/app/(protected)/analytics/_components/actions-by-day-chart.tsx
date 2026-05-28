"use client";

import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

interface Item {
  day: string;
  approves: number;
  rejects: number;
}

interface Props {
  items: Item[];
  isLoading: boolean;
}

export function ActionsByDayChart({ items, isLoading }: Props) {
  if (isLoading) {
    return (
      <div className="h-64 rounded-lg border border-zinc-200 bg-zinc-50 animate-pulse dark:border-zinc-800 dark:bg-zinc-900/30" />
    );
  }
  if (items.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center rounded-lg border border-zinc-200 bg-white text-sm text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900/30 dark:text-zinc-500">
        No actions in this window.
      </div>
    );
  }
  return (
    <div className="h-64 rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900/30">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={items}>
          <defs>
            <linearGradient id="approves-grad" x1="0" y1="0" x2="0" y2="1">
              <stop
                offset="0%"
                stopColor="var(--chart-approves-fill)"
                stopOpacity={0.6}
              />
              <stop
                offset="100%"
                stopColor="var(--chart-approves-fill)"
                stopOpacity={0.05}
              />
            </linearGradient>
            <linearGradient id="rejects-grad" x1="0" y1="0" x2="0" y2="1">
              <stop
                offset="0%"
                stopColor="var(--chart-rejects-fill)"
                stopOpacity={0.5}
              />
              <stop
                offset="100%"
                stopColor="var(--chart-rejects-fill)"
                stopOpacity={0.05}
              />
            </linearGradient>
          </defs>
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="var(--chart-grid)"
            vertical={false}
          />
          <XAxis dataKey="day" stroke="var(--chart-axis)" fontSize={11} />
          <YAxis
            stroke="var(--chart-axis)"
            fontSize={11}
            allowDecimals={false}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: "var(--chart-tooltip-bg)",
              border: "1px solid var(--chart-tooltip-border)",
              borderRadius: 6,
              fontSize: 12,
            }}
            labelStyle={{ color: "var(--chart-tooltip-label)" }}
          />
          <Area
            type="monotone"
            dataKey="approves"
            stroke="var(--chart-approves)"
            strokeWidth={2}
            fill="url(#approves-grad)"
            name="Approves"
          />
          <Area
            type="monotone"
            dataKey="rejects"
            stroke="var(--chart-rejects)"
            strokeWidth={2}
            fill="url(#rejects-grad)"
            name="Rejects"
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
