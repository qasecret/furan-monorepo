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

// Same chip classes as the viewer's severity badges (RegionItem): severity
// isn't a run status, so each keeps its hue as an opaque pastel `-100` chip
// with `-800` text in both themes (Ruling R18) — AA on the chip itself
// (6.4–7.3:1) whatever surface sits behind it. Full literal strings only.
const PILL_STYLE: Record<
  Exclude<Severity, "none">,
  { className: string; emoji: string }
> = {
  breaking: {
    className: "border-red-300 bg-red-100 text-red-800",
    emoji: "🔴",
  },
  major: {
    className: "border-orange-300 bg-orange-100 text-orange-800",
    emoji: "🟠",
  },
  minor: {
    className: "border-yellow-300 bg-yellow-100 text-yellow-800",
    emoji: "🟡",
  },
  cosmetic: {
    className: "border-blue-300 border-dashed bg-blue-100 text-blue-800",
    emoji: "🔵",
  },
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
  const style = PILL_STYLE[result.severity as Exclude<Severity, "none">];
  return (
    <span
      data-testid={`aggregate-severity-pill-${result.severity}`}
      className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium tabular-nums ${style.className}`}
    >
      <span aria-hidden>{style.emoji}</span>
      {result.count} {result.severity}
    </span>
  );
}
