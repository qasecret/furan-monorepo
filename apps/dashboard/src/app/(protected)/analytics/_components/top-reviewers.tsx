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
  userId: string;
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
      <div className="h-64 rounded-lg border border-zinc-800 bg-zinc-900/30 animate-pulse" />
    );
  }
  if (items.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900/30 text-sm text-zinc-500">
        No reviewer activity in this window.
      </div>
    );
  }
  // Recharts horizontal bars: pass `layout="vertical"` and X = number, Y = category.
  return (
    <div className="h-64 rounded-lg border border-zinc-800 bg-zinc-900/30 p-3">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          layout="vertical"
          data={items.map((i) => ({
            email: i.email ?? i.userId.slice(0, 8),
            actions: i.actions,
          }))}
          margin={{ left: 60 }}
        >
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="#27272a"
            horizontal={false}
          />
          <XAxis
            type="number"
            stroke="#71717a"
            fontSize={11}
            allowDecimals={false}
          />
          <YAxis
            type="category"
            dataKey="email"
            stroke="#71717a"
            fontSize={11}
            width={150}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: "#09090b",
              border: "1px solid #27272a",
              borderRadius: 6,
              fontSize: 12,
            }}
          />
          <Bar dataKey="actions" fill="#a8ff53" radius={[0, 4, 4, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
