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

import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";

interface Item {
  day: string;
  passed: number;
  failed: number;
  unresolved: number;
}

interface Props {
  items: Item[];
  isLoading: boolean;
}

export function RunsByDayChart({ items, isLoading }: Props) {
  if (isLoading) {
    return <Skeleton className="h-64 w-full rounded-xl" />;
  }
  if (items.length === 0) {
    return (
      <EmptyState
        title="No test runs in this window."
        className="h-64 justify-center"
      />
    );
  }
  return (
    <div className="h-64">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={items}>
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
          <Bar
            dataKey="passed"
            stackId="status"
            fill="var(--chart-passed)"
            name="Passed"
            radius={[0, 0, 0, 0]}
          />
          <Bar
            dataKey="failed"
            stackId="status"
            fill="var(--chart-failed)"
            name="Failed"
            radius={[0, 0, 0, 0]}
          />
          <Bar
            dataKey="unresolved"
            stackId="status"
            fill="var(--chart-unresolved)"
            name="Unresolved"
            radius={[2, 2, 0, 0]}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
