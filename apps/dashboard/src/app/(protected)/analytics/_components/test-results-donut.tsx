"use client";

import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";

import { Skeleton } from "@/components/ui/skeleton";

interface Props {
  passed: number;
  failed: number;
  unresolved: number;
  passRate: number;
  isLoading: boolean;
}

const COLORS = [
  "var(--chart-passed)",
  "var(--chart-failed)",
  "var(--chart-unresolved)",
];

export function TestResultsDonut({
  passed,
  failed,
  unresolved,
  passRate,
  isLoading,
}: Props) {
  if (isLoading) {
    return <Skeleton className="mx-auto h-52 w-52 rounded-full" />;
  }

  const total = passed + failed + unresolved;
  if (total === 0) {
    return (
      <div className="flex h-52 items-center justify-center text-sm text-fg-muted">
        No test runs in this window.
      </div>
    );
  }

  const data = [
    { name: "Passed", value: passed },
    { name: "Failed", value: failed },
    { name: "Unresolved", value: unresolved },
  ].filter((d) => d.value > 0);

  return (
    <div className="relative mx-auto h-52 w-52">
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={data}
            cx="50%"
            cy="50%"
            innerRadius={65}
            outerRadius={90}
            paddingAngle={2}
            dataKey="value"
            strokeWidth={0}
          >
            {data.map((entry) => (
              <Cell
                key={entry.name}
                fill={
                  COLORS[
                    entry.name === "Passed"
                      ? 0
                      : entry.name === "Failed"
                        ? 1
                        : 2
                  ]
                }
              />
            ))}
          </Pie>
          <Tooltip
            contentStyle={{
              backgroundColor: "var(--chart-tooltip-bg)",
              border: "1px solid var(--chart-tooltip-border)",
              borderRadius: 6,
              fontSize: 12,
            }}
            labelStyle={{ color: "var(--chart-tooltip-label)" }}
          />
        </PieChart>
      </ResponsiveContainer>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-3xl font-bold tabular-nums text-fg">
          {Math.round(passRate * 100)}%
        </span>
        <span className="text-xs text-fg-muted">pass rate</span>
      </div>
    </div>
  );
}
