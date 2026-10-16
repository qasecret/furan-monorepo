"use client";

import { worstSeverity } from "@furan/shared-types";

import {
  asSeverity,
  type Severity,
} from "@/components/diff-viewer/layers/regionTypes";
import { cn } from "@/lib/cn";
import { SEVERITY_STYLE } from "@/lib/severity-style";

interface AggregateResult {
  severity: Severity;
  count: number;
}

/**
 * Computes the highest-severity region present + how many regions share that
 * severity. Returns null when there are no regions or when every region is
 * `severity: "none"` (i.e. nothing worth flagging at the run level).
 */
export function aggregateSeverity(
  regions: { severity: string }[],
): AggregateResult | null {
  const severities = regions.map((r) => asSeverity(r.severity));
  const max = worstSeverity(severities);
  if (max === null || max === "none") return null;

  return { severity: max, count: severities.filter((s) => s === max).length };
}

// Chip colours come from the shared severity map (lib/severity-style.ts), so
// the pill matches the viewer's region badges; only the emoji is local.
const PILL_EMOJI: Record<Exclude<Severity, "none">, string> = {
  breaking: "🔴",
  major: "🟠",
  minor: "🟡",
  cosmetic: "🔵",
};

interface Props {
  regions: { severity: string }[];
}

/**
 * Single chip summarizing the highest-severity diff region present on a run.
 * Uses the same severity hues as the overlay and the region badges, so all
 * three share one visual identity. Hidden when there are no actionable
 * regions.
 */
export function AggregateSeverityPill({ regions }: Props) {
  const result = aggregateSeverity(regions);
  if (!result) return null;
  const severity = result.severity as Exclude<Severity, "none">;
  return (
    <span
      data-testid={`aggregate-severity-pill-${severity}`}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium tabular-nums",
        SEVERITY_STYLE[severity],
      )}
    >
      <span aria-hidden>{PILL_EMOJI[severity]}</span>
      {result.count} {result.severity}
    </span>
  );
}
