"use client";

import type { DiffRegion, Severity } from "./layers/regionTypes";
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
    className: "bg-red-500/10 text-red-400 border-red-500/20",
  },
  major: {
    variant: "outline",
    className: "bg-orange-500/10 text-orange-400 border-orange-500/20",
  },
  minor: {
    variant: "outline",
    className: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
  },
  cosmetic: {
    variant: "outline",
    className: "bg-blue-500/10 text-blue-400 border-blue-500/20 border-dashed",
  },
  none: {
    variant: "outline",
    className: "bg-zinc-900 text-zinc-400 border-zinc-800 border-dotted",
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

export function RegionItem({ region }: { region: DiffRegion }) {
  const selectedId = useViewerStore((s) => s.selectedRegionId);
  const setSelected = useViewerStore((s) => s.setSelected);
  const isSelected = selectedId === region.id;
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
            ? "bg-zinc-900 ring-2 ring-brand border-zinc-700"
            : "border-zinc-800 hover:bg-zinc-900/50 hover:border-zinc-700",
          matched ? "" : "border-amber-500/30",
        )}
        data-region-id={region.id}
        data-source="dynamic_text"
      >
        <Badge
          variant="outline"
          className={
            matched
              ? "bg-purple-500/10 text-purple-400 border-purple-500/20"
              : "bg-amber-500/10 text-amber-400 border-amber-500/20"
          }
        >
          {matched ? "Dynamic text · matched" : "Dynamic text · NOT matched"}
        </Badge>
        <span className="text-xs font-mono truncate text-zinc-300">
          &quot;{region.ocrText ?? ""}&quot;
        </span>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setSelected(region.id)}
      aria-label={`${SEVERITY_LABEL[sev]} ${region.category}: ${region.description}`}
      aria-pressed={isSelected}
      className={cn(
        "w-full text-left p-2 rounded-md border transition-colors flex flex-col gap-1",
        isSelected
          ? "bg-zinc-900 ring-2 ring-brand border-zinc-700"
          : "border-zinc-800 hover:bg-zinc-900/50 hover:border-zinc-700",
      )}
      data-region-id={region.id}
    >
      <div className="flex items-center gap-2">
        <Badge
          variant={style.variant}
          className={style.className}
          data-severity={sev}
        >
          {SEVERITY_LABEL[sev]}
        </Badge>
        <span className="text-xs text-zinc-500 capitalize">
          {region.category}
        </span>
      </div>
      <p className="text-sm text-zinc-200 line-clamp-2">{region.description}</p>
    </button>
  );
}
