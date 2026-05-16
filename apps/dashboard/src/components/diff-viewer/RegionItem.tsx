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

// Shape varies per severity (a11y: don't rely on color alone).
const SEVERITY_STYLE: Record<
  Severity,
  {
    variant: "default" | "destructive" | "secondary" | "outline";
    className: string;
  }
> = {
  breaking: {
    variant: "destructive",
    className: "border border-red-700",
  },
  major: {
    variant: "default",
    className:
      "border border-orange-500 bg-orange-100 text-orange-900 hover:bg-orange-100/80",
  },
  minor: {
    variant: "outline",
    className: "border-yellow-500 text-yellow-700",
  },
  cosmetic: {
    variant: "outline",
    className: "border-blue-400 border-dashed text-blue-700",
  },
  none: {
    variant: "outline",
    className: "border-gray-400 border-dotted text-gray-600",
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

  return (
    <button
      type="button"
      onClick={() => setSelected(region.id)}
      aria-label={`${SEVERITY_LABEL[sev]} ${region.category}: ${region.description}`}
      aria-pressed={isSelected}
      className={cn(
        "w-full text-left p-2 rounded border hover:bg-accent transition-colors flex flex-col gap-1",
        isSelected && "bg-accent ring-2 ring-primary",
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
        <span className="text-xs text-muted-foreground capitalize">
          {region.category}
        </span>
      </div>
      <p className="text-sm line-clamp-2">{region.description}</p>
    </button>
  );
}
