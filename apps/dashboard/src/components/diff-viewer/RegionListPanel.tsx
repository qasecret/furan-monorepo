"use client";

import { compareSeverity, SEVERITIES } from "@furan/shared-types";
import { Sparkles } from "lucide-react";
import { useMemo, useState } from "react";

import {
  asSeverity,
  type BBox,
  type DiffRegion,
  type Severity,
} from "./layers/regionTypes";
import { groupRegions } from "./region-format";
import { isRegionShown } from "./region-visibility";
import { RegionItem } from "./RegionItem";
import { useViewState } from "./view-state";
import { useViewerPrefs } from "./viewer-prefs";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const SEVERITY_FILTERS: Array<Severity | "all"> = ["all", ...SEVERITIES];

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

interface RegionListPanelProps {
  regions: DiffRegion[];
  vlmDescription?: string | null;
}

export function RegionListPanel({
  regions,
  vlmDescription,
}: RegionListPanelProps) {
  const [severityFilter, setSeverityFilter] = useState<Severity | "all">("all");
  const [categoryFilter, setCategoryFilter] = useState<string | "all">("all");
  // Dynamic-text audit rows (`source === "dynamic_text"`) are hidden by
  // default so they don't drown out actionable diff regions. Toggle reveals
  // them so reviewers can audit which OCR decisions Furan made for a run.
  // The toggle is the view's (reset per step), so the canvas shows what the
  // list shows (R10), and so does "Hide displacement".
  const showSuppressed = useViewState((s) => s.showSuppressed);
  const setShowSuppressed = useViewState((s) => s.setShowSuppressed);
  const hideDisplacement = useViewerPrefs((s) => s.prefs.hideDisplacement);

  const categories = useMemo(() => {
    const set = new Set(regions.map((r) => r.category));
    return ["all", ...Array.from(set).sort()];
  }, [regions]);

  const filtered = useMemo(() => {
    // Synthetic audit rows (dynamic-text OCR + Layout-suppressed content/color
    // changes, ADR-053) are hidden unless the toggle is on.
    return regions
      .filter((r) => isRegionShown(r, { showSuppressed, hideDisplacement }))
      .filter((r) => severityFilter === "all" || r.severity === severityFilter)
      .filter((r) => categoryFilter === "all" || r.category === categoryFilter)
      .slice()
      .sort(
        (a, b) =>
          compareSeverity(asSeverity(a.severity), asSeverity(b.severity)) ||
          areaOf(b.bbox) - areaOf(a.bbox),
      );
  }, [
    regions,
    severityFilter,
    categoryFilter,
    showSuppressed,
    hideDisplacement,
  ]);

  // Collapse visually-identical rows (same severity / category / source /
  // cleaned description / size) into a single "×N" entry so a run with many
  // near-duplicate pixel clusters isn't a wall of repeated cards. Every
  // region is still highlighted on the canvas and steppable — only the list
  // is de-duplicated. `filtered` is already severity-then-area sorted, so the
  // group order matches.
  const grouped = useMemo(() => groupRegions(filtered), [filtered]);

  // A section of the rail's Info tab, as wide as the rail (spec §5): no
  // aside or width of its own.
  return (
    <section className="flex min-w-0 flex-col" data-testid="region-list-panel">
      <div className="p-2 border-b border-edge flex items-center justify-between gap-2 flex-wrap">
        <span className="text-sm font-medium text-fg">
          Regions ({filtered.length})
        </span>
        <div className="flex gap-1 flex-wrap">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="text-xs rounded-md border border-edge px-2 py-1 text-fg-secondary hover:bg-hover hover:text-fg transition-colors focus-ring"
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
                className="text-xs rounded-md border border-edge px-2 py-1 text-fg-secondary hover:bg-hover hover:text-fg transition-colors focus-ring"
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
            className="flex items-center gap-1 text-xs px-2 py-1 text-fg-secondary"
            data-testid="show-suppressed-toggle"
          >
            <input
              type="checkbox"
              checked={showSuppressed}
              onChange={(e) => setShowSuppressed(e.target.checked)}
              className="w-3 h-3 accent-brand focus-ring"
            />
            Show suppressed
          </label>
        </div>
      </div>
      {vlmDescription && (
        <div
          className="mx-2 mt-2 rounded-md border border-blue-500/25 bg-blue-500/10 p-3"
          data-testid="vlm-description-box"
        >
          <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-fg">
            <Sparkles className="h-3.5 w-3.5 text-blue-500" aria-hidden />
            AI Analysis
          </div>
          <p className="text-xs leading-relaxed text-fg-secondary">
            {vlmDescription}
          </p>
        </div>
      )}
      <div className="overflow-auto flex-1 p-2 space-y-1">
        {filtered.length === 0 ? (
          <div
            className="flex flex-col items-center justify-center gap-1 p-6 text-center"
            data-testid="regions-empty-state"
          >
            <div className="text-sm font-medium text-fg-secondary">
              {regions.length === 0
                ? "No regions to display"
                : "No regions match the active filters"}
            </div>
            <div className="text-xs text-fg-muted max-w-[18rem]">
              {regions.length === 0
                ? "No ignore or diff regions are configured for this checkpoint. Use 'Edit regions' above to draw ignore areas, or adjust the sensitivity slider to surface pixel-level diffs."
                : "Try clearing the severity / category filter or toggling 'Show suppressed' above."}
            </div>
          </div>
        ) : (
          grouped.map((g) => (
            <RegionItem
              key={g.representative.id}
              region={g.representative}
              memberIds={g.memberIds}
            />
          ))
        )}
      </div>
    </section>
  );
}
