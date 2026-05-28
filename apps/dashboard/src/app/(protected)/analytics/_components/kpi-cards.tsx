"use client";

interface Summary {
  totalActions: number;
  approveRate: number;
  keyboardRate: number;
  medianMsPerAction: number;
}

interface Props {
  summary: Summary | undefined;
  isLoading: boolean;
}

function fmtPercent(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

function fmtMs(ms: number): string {
  if (ms <= 0) return "—";
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${(seconds / 60).toFixed(1)}m`;
}

export function KpiCards({ summary, isLoading }: Props) {
  const cards = [
    {
      label: "Actions",
      value: summary?.totalActions ?? 0,
      sub: "approve + reject",
    },
    {
      label: "Approve %",
      value: summary ? fmtPercent(summary.approveRate) : "—",
      sub: "of total actions",
    },
    {
      label: "Keyboard %",
      value: summary ? fmtPercent(summary.keyboardRate) : "—",
      sub: "a/r vs mouse click",
    },
    {
      label: "Median pace",
      value: summary ? fmtMs(summary.medianMsPerAction) : "—",
      sub: "per action",
    },
  ];

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {cards.map((c) => (
        <div
          key={c.label}
          className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4"
        >
          <div className="text-xs text-zinc-400">{c.label}</div>
          <div className="mt-2 text-2xl font-semibold text-white tabular-nums">
            {isLoading ? "…" : c.value}
          </div>
          <div className="mt-1 text-xs text-zinc-500">{c.sub}</div>
        </div>
      ))}
    </div>
  );
}
