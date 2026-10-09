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

// Shape varies per severity (a11y: don't rely on color alone). Severity is not
// a run status, so these are plain hue chips: an opaque pastel -100 fill with
// -800 text, the same in both themes (a hue tint can't carry AA text in dark).
// `variant="outline"` keeps the Badge primitive's border styling consistent.
// `none` is neutral since there's no hue for the absence-of-severity state;
// the dotted border carries the a11y cue.
const SEVERITY_STYLE: Record<
  Severity,
  {
    variant: "default" | "destructive" | "secondary" | "outline";
    className: string;
  }
> = {
  breaking: {
    variant: "outline",
    className: "border-red-300 bg-red-100 text-red-800",
  },
  major: {
    variant: "outline",
    className: "border-orange-300 bg-orange-100 text-orange-800",
  },
  minor: {
    variant: "outline",
    className: "border-yellow-300 bg-yellow-100 text-yellow-800",
  },
  cosmetic: {
    variant: "outline",
    className: "border-blue-300 border-dashed bg-blue-100 text-blue-800",
  },
  none: {
    variant: "outline",
    className: "border-edge border-dotted bg-hover text-fg-secondary",
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
          "w-full text-left p-2 rounded-md border border-dashed transition-colors flex items-center gap-2 focus-ring",
          isSelected
            ? "bg-hover ring-2 ring-ring border-edge-strong"
            : "border-edge hover:bg-hover/50 hover:border-edge-strong",
          matched ? "" : "border-amber-500/50",
        )}
        data-region-id={region.id}
        data-source="dynamic_text"
      >
        <Badge
          variant="outline"
          className={
            matched
              ? "border-purple-300 bg-purple-100 text-purple-800"
              : "border-amber-300 bg-amber-100 text-amber-800"
          }
        >
          {matched ? "Dynamic text · matched" : "Dynamic text · NOT matched"}
        </Badge>
        <span className="text-xs font-mono truncate text-fg-secondary">
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
        "w-full text-left p-2 rounded-md border transition-colors flex flex-col gap-1 focus-ring",
        isSelected
          ? "bg-hover ring-2 ring-ring border-edge-strong"
          : "border-edge hover:bg-hover/50 hover:border-edge-strong",
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
            className="rounded-full bg-edge px-1.5 py-0.5 text-2xs font-semibold tabular-nums text-fg-secondary"
            data-testid="region-count"
          >
            ×{count}
          </span>
        )}
        {/* Category is only worth a label when it isn't the obvious "image"
            default — every pixel diff is an image region, so the chip was
            pure repetition. Text / color / a11y categories still surface. */}
        {showCategory && (
          <span className="text-xs text-fg-muted capitalize">
            {region.category}
          </span>
        )}
        {(region.source === "layout_kept" ||
          region.source === "layout_suppressed") && (
          <Badge
            variant="outline"
            className="border-indigo-300 bg-indigo-100 text-indigo-800"
            data-source={region.source}
          >
            {region.source === "layout_suppressed"
              ? "Layout · suppressed"
              : "Layout · geometry"}
          </Badge>
        )}
        {size && (
          <span
            className="ml-auto font-mono text-2xs tabular-nums text-fg-muted"
            data-testid="region-size"
          >
            {size}
          </span>
        )}
      </div>
      <p className="text-sm text-fg line-clamp-2">
        {cleanDescription(region.description)}
      </p>
    </button>
  );
}
