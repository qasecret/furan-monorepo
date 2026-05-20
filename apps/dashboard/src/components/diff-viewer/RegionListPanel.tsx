"use client";

import { useMemo, useState } from "react";

import type { BBox, DiffRegion, Severity } from "./layers/regionTypes";
import { RegionItem } from "./RegionItem";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const SEV_RANK: Record<Severity, number> = {
  breaking: 4,
  major: 3,
  minor: 2,
  cosmetic: 1,
  none: 0,
};

const SEVERITY_FILTERS: Array<Severity | "all"> = [
  "all",
  "breaking",
  "major",
  "minor",
  "cosmetic",
  "none",
];

function rankOf(sev: string): number {
  return SEV_RANK[sev as Severity] ?? 0;
}

function areaOf(b: BBox | unknown): number {
  if (
    b &&
    typeof b === "object" &&
    "width" in b &&
    "height" in b &&
    typeof (b as BBox).width === "number" &&
    typeof (b as BBox).height === "number"
  ) {
    return (b as BBox).width * (b as BBox).height;
  }
  return 0;
}

export function RegionListPanel({ regions }: { regions: DiffRegion[] }) {
  const [severityFilter, setSeverityFilter] = useState<Severity | "all">("all");
  const [categoryFilter, setCategoryFilter] = useState<string | "all">("all");
  // Dynamic-text audit rows (`source === "dynamic_text"`) are hidden by
  // default so they don't drown out actionable diff regions. Toggle reveals
  // them so reviewers can audit which OCR decisions Furan made for a run.
  const [showSuppressed, setShowSuppressed] = useState(false);

  const categories = useMemo(() => {
    const set = new Set(regions.map((r) => r.category));
    return ["all", ...Array.from(set).sort()];
  }, [regions]);

  const filtered = useMemo(() => {
    return regions
      .filter((r) => {
        // Always hide synthetic dynamic-text audit rows unless the toggle is on.
        if (r.source === "dynamic_text") return showSuppressed;
        return true;
      })
      .filter((r) => severityFilter === "all" || r.severity === severityFilter)
      .filter((r) => categoryFilter === "all" || r.category === categoryFilter)
      .slice()
      .sort((a, b) => {
        const sa = rankOf(a.severity);
        const sb = rankOf(b.severity);
        if (sa !== sb) return sb - sa;
        return areaOf(b.bbox) - areaOf(a.bbox);
      });
  }, [regions, severityFilter, categoryFilter, showSuppressed]);

  return (
    <aside
      className="border-l flex flex-col w-80 max-w-[40vw]"
      data-testid="region-list-panel"
    >
      <div className="p-2 border-b flex items-center justify-between gap-2 flex-wrap">
        <span className="text-sm font-medium">Regions ({filtered.length})</span>
        <div className="flex gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="text-xs border rounded px-2 py-1 hover:bg-accent"
                data-testid="severity-filter-trigger"
              >
                {severityFilter === "all"
                  ? "All severities"
                  : `Severity: ${severityFilter}`}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              {SEVERITY_FILTERS.map((sev) => (
                <DropdownMenuItem
                  key={sev}
                  onSelect={() => setSeverityFilter(sev)}
                  data-severity-option={sev}
                >
                  {sev === "all" ? "All severities" : sev}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="text-xs border rounded px-2 py-1 hover:bg-accent"
                data-testid="category-filter-trigger"
              >
                {categoryFilter === "all" ? "All categories" : categoryFilter}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              {categories.map((cat) => (
                <DropdownMenuItem
                  key={cat}
                  onSelect={() => setCategoryFilter(cat)}
                  data-category-option={cat}
                >
                  {cat === "all" ? "All categories" : cat}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <label
            className="flex items-center gap-1 text-xs px-2 py-1"
            data-testid="show-suppressed-toggle"
          >
            <input
              type="checkbox"
              checked={showSuppressed}
              onChange={(e) => setShowSuppressed(e.target.checked)}
              className="w-3 h-3"
            />
            Show suppressed
          </label>
        </div>
      </div>
      <div className="overflow-auto flex-1 p-2 space-y-1">
        {filtered.length === 0 ? (
          <div className="text-sm text-muted-foreground p-2">
            No regions match.
          </div>
        ) : (
          filtered.map((r) => <RegionItem key={r.id} region={r} />)
        )}
      </div>
    </aside>
  );
}
