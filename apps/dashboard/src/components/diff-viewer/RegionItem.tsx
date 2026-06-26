"use client";

import type { DiffRegion, Severity } from "./layers/regionTypes";
import { cleanDescription, sizeLabel } from "./region-format";
import { useViewerStore } from "./useViewerStore";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";

const SEVERITY_LABEL: Record<Severity, string> = {
  breaking: "Breaking",
  major: "Major",
  minor: "Minor",
  cosmetic: "Cosmetic",
  none: "None",
};

// Shape varies per severity (a11y: don't rely on color alone). Each tint
// uses the Phase 1 status-pill family: bg-{hue}-500/10 + text-{hue}-400
// + border-{hue}-500/20. `variant="outline"` keeps the Badge primitive's
// border styling consistent. `none` uses zinc since there's no hue for
// the absence-of-severity state; the dotted border carries the a11y cue.
const SEVERITY_STYLE: Record<
  Severity,
  {
    variant: "default" | "destructive" | "secondary" | "outline";
    className: string;
  }
> = {
  breaking: {
    variant: "outline",
    className:
      "bg-red-100 text-red-900 border-red-300 dark:bg-red-500/10 dark:text-red-400 dark:border-red-500/20",
  },
  major: {
    variant: "outline",
    className:
      "bg-orange-100 text-orange-900 border-orange-300 dark:bg-orange-500/10 dark:text-orange-400 dark:border-orange-500/20",
  },
  minor: {
    variant: "outline",
    className:
      "bg-yellow-100 text-yellow-900 border-yellow-300 dark:bg-yellow-500/10 dark:text-yellow-400 dark:border-yellow-500/20",
  },
  cosmetic: {
    variant: "outline",
    className:
      "bg-blue-100 text-blue-900 border-blue-300 border-dashed dark:bg-blue-500/10 dark:text-blue-400 dark:border-blue-500/20",
  },
  none: {
    variant: "outline",
    className:
      "bg-zinc-100 text-zinc-700 border-zinc-200 border-dotted dark:bg-zinc-900 dark:text-zinc-400 dark:border-zinc-800",
  },
};

function asSeverity(v: string): Severity {
  switch (v) {
    case "breaking":
    case "major":
    case "minor":
    case "cosmetic":
    case "none":
      return v;
    default:
      return "none";
  }
}

export function RegionItem({
  region,
  memberIds,
}: {
  region: DiffRegion;
  /** All region ids this row stands in for (≥1); defaults to the region's
   *  own id. A row with >1 member renders a "×N" count and counts as
   *  selected when any member is the active selection. */
  memberIds?: string[];
}) {
  const selectedId = useViewerStore((s) => s.selectedRegionId);
  const setSelected = useViewerStore((s) => s.setSelected);
  const ids = memberIds ?? [region.id];
  const count = ids.length;
  const isSelected = selectedId != null && ids.includes(selectedId);
  const sev = asSeverity(region.severity);
  const style = SEVERITY_STYLE[sev];

  // Dynamic-text audit rows get a smaller, distinct card: the badge is the
  // match outcome, and we surface the OCR text inline so reviewers can audit
  // exactly what tesseract saw.
  if (region.source === "dynamic_text") {
    const matched = region.ocrMatched === true;
    return (
      <button
        type="button"
        onClick={() => setSelected(region.id)}
        aria-label={`Dynamic text ${matched ? "matched" : "not matched"}: ${region.ocrText ?? ""}`}
        aria-pressed={isSelected}
        className={cn(
          "w-full text-left p-2 rounded-md border border-dashed transition-colors flex items-center gap-2",
          isSelected
            ? "bg-zinc-200 ring-2 ring-brand border-zinc-300 dark:bg-zinc-900 dark:border-zinc-700"
            : "border-zinc-200 hover:bg-zinc-100/70 hover:border-zinc-300 dark:border-zinc-800 dark:hover:bg-zinc-900/50 dark:hover:border-zinc-700",
          matched ? "" : "border-amber-300 dark:border-amber-500/30",
        )}
        data-region-id={region.id}
        data-source="dynamic_text"
      >
        <Badge
          variant="outline"
          className={
            matched
              ? "bg-purple-100 text-purple-900 border-purple-300 dark:bg-purple-500/10 dark:text-purple-400 dark:border-purple-500/20"
              : "bg-amber-100 text-amber-900 border-amber-300 dark:bg-amber-500/10 dark:text-amber-400 dark:border-amber-500/20"
          }
        >
          {matched ? "Dynamic text · matched" : "Dynamic text · NOT matched"}
        </Badge>
        <span className="text-xs font-mono truncate text-zinc-700 dark:text-zinc-300">
          &quot;{region.ocrText ?? ""}&quot;
        </span>
      </button>
    );
  }

  const size = sizeLabel(region.bbox);
  const showCategory =
    !!region.category && region.category.toLowerCase() !== "image";

  return (
    <button
      type="button"
      onClick={() => setSelected(region.id)}
      aria-label={`${SEVERITY_LABEL[sev]} ${region.category}: ${region.description}${
        count > 1 ? ` (${count} similar)` : ""
      }`}
      aria-pressed={isSelected}
      className={cn(
        "w-full text-left p-2 rounded-md border transition-colors flex flex-col gap-1",
        isSelected
          ? "bg-zinc-200 ring-2 ring-brand border-zinc-300 dark:bg-zinc-900 dark:border-zinc-700"
          : "border-zinc-200 hover:bg-zinc-100/70 hover:border-zinc-300 dark:border-zinc-800 dark:hover:bg-zinc-900/50 dark:hover:border-zinc-700",
      )}
      data-region-id={region.id}
    >
      <div className="flex items-center gap-2 flex-wrap">
        <Badge
          variant={style.variant}
          className={style.className}
          data-severity={sev}
        >
          {SEVERITY_LABEL[sev]}
        </Badge>
        {count > 1 && (
          <span
            className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
            data-testid="region-count"
          >
            ×{count}
          </span>
        )}
        {/* Category is only worth a label when it isn't the obvious "image"
            default — every pixel diff is an image region, so the chip was
            pure repetition. Text / color / a11y categories still surface. */}
        {showCategory && (
          <span className="text-xs text-zinc-500 capitalize">
            {region.category}
          </span>
        )}
        {(region.source === "layout_kept" ||
          region.source === "layout_suppressed") && (
          <Badge
            variant="outline"
            className="bg-indigo-100 text-indigo-900 border-indigo-300 dark:bg-indigo-500/10 dark:text-indigo-400 dark:border-indigo-500/20"
            data-source={region.source}
          >
            {region.source === "layout_suppressed"
              ? "Layout · suppressed"
              : "Layout · geometry"}
          </Badge>
        )}
        {size && (
          <span
            className="ml-auto font-mono text-[11px] tabular-nums text-zinc-400 dark:text-zinc-500"
            data-testid="region-size"
          >
            {size}
          </span>
        )}
      </div>
      <p className="text-sm text-zinc-800 line-clamp-2 dark:text-zinc-200">
        {cleanDescription(region.description)}
      </p>
    </button>
  );
}
