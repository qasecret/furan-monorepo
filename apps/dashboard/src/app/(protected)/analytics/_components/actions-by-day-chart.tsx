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
      <div className="h-64 rounded-lg border border-zinc-800 bg-zinc-900/30 animate-pulse" />
    );
  }
  if (items.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900/30 text-sm text-zinc-500">
        No actions in this window.
      </div>
    );
  }
  return (
    <div className="h-64 rounded-lg border border-zinc-800 bg-zinc-900/30 p-3">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={items}>
          <defs>
            <linearGradient id="approves-grad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#a8ff53" stopOpacity={0.6} />
              <stop offset="100%" stopColor="#a8ff53" stopOpacity={0.05} />
            </linearGradient>
            <linearGradient id="rejects-grad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#f87171" stopOpacity={0.5} />
              <stop offset="100%" stopColor="#f87171" stopOpacity={0.05} />
            </linearGradient>
          </defs>
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="#27272a"
            vertical={false}
          />
          <XAxis dataKey="day" stroke="#71717a" fontSize={11} />
          <YAxis stroke="#71717a" fontSize={11} allowDecimals={false} />
          <Tooltip
            contentStyle={{
              backgroundColor: "#09090b",
              border: "1px solid #27272a",
              borderRadius: 6,
              fontSize: 12,
            }}
            labelStyle={{ color: "#a1a1aa" }}
          />
          <Area
            type="monotone"
            dataKey="approves"
            stroke="#a8ff53"
            strokeWidth={2}
            fill="url(#approves-grad)"
            name="Approves"
          />
          <Area
            type="monotone"
            dataKey="rejects"
            stroke="#f87171"
            strokeWidth={2}
            fill="url(#rejects-grad)"
            name="Rejects"
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
