"use client";

import type { RunStatus } from "@furan/shared-types";

import { statusStyle } from "@/lib/status-style";

interface SparklineRun {
  id: string;
  status: RunStatus;
  diffPercent: number | null;
}

interface Props {
  runs: ReadonlyArray<SparklineRun>;
}

const VIEW_W = 480;
const VIEW_H = 80;
const PAD = 16;
const PLOT_W = VIEW_W - PAD * 2;
const PLOT_H = VIEW_H - PAD * 2;
const CLIP_MAX_PCT = 10;

function normalize(p: number | null): number {
  if (p === null) return 0;
  return Math.min(p, CLIP_MAX_PCT) / CLIP_MAX_PCT;
}

function xOf(i: number, total: number): number {
  if (total <= 1) return PAD + PLOT_W / 2;
  return PAD + (i / (total - 1)) * PLOT_W;
}

function yOf(p: number | null): number {
  return PAD + (1 - normalize(p)) * PLOT_H;
}

function summaryLabel(runs: ReadonlyArray<SparklineRun>): string {
  if (runs.length === 0) return "";
  const counts: Partial<Record<RunStatus, number>> = {};
  for (const r of runs) counts[r.status] = (counts[r.status] ?? 0) + 1;
  const parts: string[] = [`${runs.length} runs`];
  for (const status of [
    "passed",
    "unresolved",
    "failed",
    "aborted",
    "empty",
    "new",
    "running",
  ] as const) {
    const c = counts[status];
    if (c) parts.push(`${c} ${status}`);
  }
  const latest = runs[runs.length - 1]!.diffPercent;
  if (latest !== null && latest !== undefined) {
    parts.push(`latest diff ${latest.toFixed(2)}%`);
  }
  return `Sparkline of ${parts.join(", ")}`;
}

/**
 * Inline SVG of diff-percent over time with status-colored dots.
 *
 * Input order = chronological (oldest → newest). Plots:
 *  - polyline connecting (xOf(i, N), yOf(diffPercent_i)) when N >= 2
 *  - one <circle> per run, fill from RunStatus enum
 *  - diff% values are clipped at 10% so an outlier doesn't flatten the rest
 *  - null diff% sits on the bottom baseline (no baseline computed yet)
 *  - returns null for an empty input (graceful degrade)
 */
export function DiffPercentSparkline({ runs }: Props) {
  if (runs.length === 0) return null;
  const total = runs.length;
  const points = runs.map((r, i) => ({
    cx: xOf(i, total),
    cy: yOf(r.diffPercent),
    fill: statusStyle(r.status).fill,
    run: r,
  }));
  const polylinePoints = points
    .map((p) => `${p.cx.toFixed(1)},${p.cy.toFixed(1)}`)
    .join(" ");

  return (
    <svg
      role="img"
      aria-label={summaryLabel(runs)}
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      className="w-full h-20"
      data-testid="diff-percent-sparkline"
    >
      {total >= 2 && (
        <polyline
          points={polylinePoints}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className="text-edge-strong"
        />
      )}
      {points.map((p) => (
        <circle key={p.run.id} cx={p.cx} cy={p.cy} r={4} className={p.fill}>
          <title>
            {p.run.status}
            {p.run.diffPercent !== null
              ? ` · ${p.run.diffPercent.toFixed(2)}%`
              : ""}
          </title>
        </circle>
      ))}
    </svg>
  );
}
