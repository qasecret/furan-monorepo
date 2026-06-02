"use client";

import { useMemo, useState } from "react";

import type { BBox, DiffRegion, Severity } from "./layers/regionTypes";
import { RegionItem } from "./RegionItem";
import { RegionKindTabs } from "./RegionKindTabs";
import { useViewerStore } from "./useViewerStore";

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

type SourceFilter = "all" | "l1" | "l2";

const SOURCE_FILTERS: Array<{ value: SourceFilter; label: string }> = [
  { value: "all", label: "All sources" },
  { value: "l1", label: "Visual (pixel)" },
  { value: "l2", label: "Root Cause (DOM/CSS)" },
];

const L2_CATEGORY_ORDER = [
  "structural",
  "layout",
  "text",
  "color",
  "image",
] as const;

const L2_CATEGORY_LABEL: Record<string, string> = {
  structural: "Structural",
  layout: "Layout / class / style",
  text: "Text",
  color: "Color",
  image: "Image",
};

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
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  // Dynamic-text audit rows (`source === "dynamic_text"`) are hidden by
  // default so they don't drown out actionable diff regions. Toggle reveals
  // them so reviewers can audit which OCR decisions Furan made for a run.
  const [showSuppressed, setShowSuppressed] = useState(false);

  const selectedRegionKind = useViewerStore((s) => s.selectedRegionKind);
  const setSelectedRegionKind = useViewerStore((s) => s.setSelectedRegionKind);

  const categories = useMemo(() => {
    const set = new Set(regions.map((r) => r.category));
    return ["all", ...Array.from(set).sort()];
  }, [regions]);

  const filtered = useMemo(() => {
    return regions
      .filter((r) => {
        // Always hide synthetic dynamic-text audit rows unless the toggle is on.
        if (r.source === "dynamic_text") return showSuppressed;
        // L1 pixel clusters render only on the heatmap canvas (Applitools-
        // style yellow bounded rectangles). They're noisy by design (5-15
        // per checkpoint) and would drown out L2 / axe rows here.
        // Reviewers see them visually; they're not actionable as rows.
        if (r.source === "l1_pixel") return false;
        return true;
      })
      .filter((r) => sourceFilter === "all" || r.source === sourceFilter)
      .filter((r) => severityFilter === "all" || r.severity === severityFilter)
      .filter((r) => categoryFilter === "all" || r.category === categoryFilter)
      .slice()
      .sort((a, b) => {
        const sa = rankOf(a.severity);
        const sb = rankOf(b.severity);
        if (sa !== sb) return sb - sa;
        return areaOf(b.bbox) - areaOf(a.bbox);
      });
  }, [regions, sourceFilter, severityFilter, categoryFilter, showSuppressed]);

  // Root Cause view: when filtered to L2, group by category so a reviewer
  // can scan "what changed" by kind (text vs color vs structural vs ...).
  // Falls through to the flat severity-sorted list otherwise.
  const grouped = useMemo(() => {
    if (sourceFilter !== "l2") return null;
    const byCategory = new Map<string, DiffRegion[]>();
    for (const r of filtered) {
      const arr = byCategory.get(r.category) ?? [];
      arr.push(r);
      byCategory.set(r.category, arr);
    }
    const ordered: Array<{ category: string; rows: DiffRegion[] }> = [];
    for (const cat of L2_CATEGORY_ORDER) {
      const rows = byCategory.get(cat);
      if (rows && rows.length > 0) {
        ordered.push({ category: cat, rows });
        byCategory.delete(cat);
      }
    }
    for (const [category, rows] of byCategory) {
      ordered.push({ category, rows });
    }
    return ordered;
  }, [filtered, sourceFilter]);

  return (
    <aside
      className="border-l border-zinc-200 bg-white flex flex-col w-80 max-w-[40vw] dark:border-zinc-800 dark:bg-zinc-950"
      data-testid="region-list-panel"
    >
      <RegionKindTabs
        value={selectedRegionKind}
        onChange={setSelectedRegionKind}
      />
      <div className="p-2 border-b border-zinc-200 flex items-center justify-between gap-2 flex-wrap dark:border-zinc-800">
        <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
          Regions ({filtered.length})
        </span>
        <div className="flex gap-1 flex-wrap">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="text-xs rounded-md border border-zinc-200 px-2 py-1 text-zinc-700 hover:bg-zinc-100 hover:text-zinc-950 transition-colors dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-900 dark:hover:text-white"
                data-testid="source-filter-trigger"
              >
                {SOURCE_FILTERS.find((s) => s.value === sourceFilter)?.label ??
                  "All sources"}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              {SOURCE_FILTERS.map((s) => (
                <DropdownMenuItem
                  key={s.value}
                  onSelect={() => setSourceFilter(s.value)}
                  data-source-option={s.value}
                >
                  {s.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="text-xs rounded-md border border-zinc-200 px-2 py-1 text-zinc-700 hover:bg-zinc-100 hover:text-zinc-950 transition-colors dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-900 dark:hover:text-white"
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
                className="text-xs rounded-md border border-zinc-200 px-2 py-1 text-zinc-700 hover:bg-zinc-100 hover:text-zinc-950 transition-colors dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-900 dark:hover:text-white"
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
            className="flex items-center gap-1 text-xs px-2 py-1 text-zinc-600 dark:text-zinc-400"
            data-testid="show-suppressed-toggle"
          >
            <input
              type="checkbox"
              checked={showSuppressed}
              onChange={(e) => setShowSuppressed(e.target.checked)}
              className="w-3 h-3 accent-brand"
            />
            Show suppressed
          </label>
        </div>
      </div>
      <div className="overflow-auto flex-1 p-2 space-y-1">
        {filtered.length === 0 ? (
          <div
            className="flex flex-col items-center justify-center gap-1 p-6 text-center"
            data-testid="regions-empty-state"
          >
            <div className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
              {regions.length === 0
                ? "No differences detected"
                : sourceFilter === "l2"
                  ? "No DOM/CSS-level changes detected"
                  : "No regions match the active filters"}
            </div>
            <div className="text-xs text-zinc-500 max-w-[18rem]">
              {regions.length === 0
                ? "The candidate matches the baseline pixel-for-pixel for the current sensitivity. Adjust the sensitivity slider if you expected to see diffs."
                : sourceFilter === "l2"
                  ? "The visual diff comes from pixel-level changes only. Switch back to 'All sources' to see them."
                  : "Try clearing the severity / category filter or toggling 'Show suppressed' above."}
            </div>
          </div>
        ) : grouped ? (
          <div data-testid="root-cause-grouped" className="space-y-3">
            {grouped.map(({ category, rows }) => (
              <section
                key={category}
                data-root-cause-group={category}
                className="space-y-1"
              >
                <h3 className="px-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
                  {L2_CATEGORY_LABEL[category] ?? category} ({rows.length})
                </h3>
                {rows.map((r) => (
                  <RegionItem key={r.id} region={r} />
                ))}
              </section>
            ))}
          </div>
        ) : (
          filtered.map((r) => <RegionItem key={r.id} region={r} />)
        )}
      </div>
    </aside>
  );
}
