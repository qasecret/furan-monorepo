"use client";

type Severity = "breaking" | "major" | "minor" | "cosmetic" | "none";

const SEVERITY_RANK: Record<Severity, number> = {
  breaking: 4,
  major: 3,
  minor: 2,
  cosmetic: 1,
  none: 0,
};

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
  if (regions.length === 0) return null;

  let max: Severity = "none";
  for (const r of regions) {
    const s: Severity = isSeverity(r.severity) ? r.severity : "none";
    if (SEVERITY_RANK[s] > SEVERITY_RANK[max]) max = s;
  }
  if (max === "none") return null;

  let count = 0;
  for (const r of regions) if (r.severity === max) count++;
  return { severity: max, count };
}

function isSeverity(s: string): s is Severity {
  return (
    s === "breaking" ||
    s === "major" ||
    s === "minor" ||
    s === "cosmetic" ||
    s === "none"
  );
}

const PILL_STYLE: Record<
  Exclude<Severity, "none">,
  { className: string; emoji: string }
> = {
  breaking: {
    className: "bg-red-500/10 text-red-400 border-red-500/20",
    emoji: "🔴",
  },
  major: {
    className: "bg-orange-500/10 text-orange-400 border-orange-500/20",
    emoji: "🟠",
  },
  minor: {
    className: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
    emoji: "🟡",
  },
  cosmetic: {
    className: "bg-blue-500/10 text-blue-400 border-blue-500/20",
    emoji: "🔵",
  },
};

interface Props {
  regions: { severity: string }[];
}

/**
 * Single chip summarizing the highest-severity diff region present on a run.
 * Reuses the SEVERITY_COLORS palette from DiffOverlayLayer.ts so overlay,
 * region badge, and this pill share one visual identity. Hidden when there
 * are no actionable regions.
 */
export function AggregateSeverityPill({ regions }: Props) {
  const result = aggregateSeverity(regions);
  if (!result) return null;
  const style = PILL_STYLE[result.severity as Exclude<Severity, "none">];
  return (
    <span
      data-testid={`aggregate-severity-pill-${result.severity}`}
      className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium ${style.className}`}
    >
      <span aria-hidden>{style.emoji}</span>
      {result.count} {result.severity}
    </span>
  );
}
