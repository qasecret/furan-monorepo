"use client";

import { useMemo } from "react";

import type { DraftIgnoreArea } from "./useViewerStore";
import { useViewerStore } from "./useViewerStore";

import { cn } from "@/lib/cn";

interface IgnoreRegionListPanelProps {
  /**
   * Active viewport label. When non-null, the panel filters to only
   * regions whose `viewport` matches. When null, all draft regions are
   * shown — useful when the run has only a single viewport.
   */
  viewport: string | null;
  /**
   * Optional delete handler. When provided, each row renders a `×`
   * button that invokes `onDelete(region.id)`. Wired to the store's
   * `setSelectedIgnoreId` + `deleteSelected` pair in `DiffViewer`.
   */
  onDelete?: (regionId: string) => void;
}

const KIND_LABEL: Record<DraftIgnoreArea["kind"], string> = {
  ignore: "Ignore",
  "dynamic-text": "Dynamic text",
  strict: "Strict",
  layout: "Layout",
  content: "Content",
};

export function IgnoreRegionListPanel({
  viewport,
  onDelete,
}: IgnoreRegionListPanelProps) {
  const regions = useViewerStore((s) => s.draftIgnoreAreas);
  const selectedIgnoreId = useViewerStore((s) => s.selectedIgnoreId);
  const setSelectedIgnoreId = useViewerStore((s) => s.setSelectedIgnoreId);

  const forViewport = useMemo(
    () => regions.filter((r) => !viewport || r.viewport === viewport),
    [regions, viewport],
  );

  return (
    <aside
      className="border-l border-edge bg-canvas flex flex-col w-80 max-w-[40vw]"
      data-testid="ignore-region-list-panel"
    >
      <div className="p-2 border-b border-edge flex items-center justify-between gap-2 flex-wrap">
        <span className="text-sm font-medium text-fg">
          Ignore regions ({forViewport.length})
        </span>
      </div>
      <div className="overflow-auto flex-1 p-2 space-y-1">
        {forViewport.length === 0 ? (
          <div
            className="flex flex-col items-center justify-center gap-1 p-6 text-center"
            data-testid="ignore-regions-empty-state"
          >
            <div className="text-sm font-medium text-fg-secondary">
              No ignore regions yet
            </div>
            <div className="text-xs text-fg-muted max-w-[18rem]">
              Drag a rectangle on the candidate to mark an area as ignored.
              Approve to save these regions onto the variation.
            </div>
          </div>
        ) : (
          forViewport.map((r) => {
            const isSelected = selectedIgnoreId === r.id;
            const x = Math.round(r.x);
            const y = Math.round(r.y);
            const w = Math.round(r.width);
            const h = Math.round(r.height);
            return (
              <div
                key={r.id}
                role="button"
                tabIndex={0}
                onClick={() => setSelectedIgnoreId(r.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setSelectedIgnoreId(r.id);
                  }
                }}
                className={cn(
                  "rounded-md border p-2 text-xs flex items-start justify-between gap-2 cursor-pointer transition-colors focus-ring",
                  isSelected
                    ? "border-brand bg-brand/10 text-fg"
                    : "border-edge text-fg-secondary hover:bg-hover",
                )}
                data-testid="ignore-region-item"
                data-region-id={r.id}
              >
                <div className="flex flex-col gap-0.5 min-w-0 flex-1">
                  <div className="font-mono text-2xs tabular-nums text-fg-secondary">
                    {x}, {y} — {w}×{h}
                  </div>
                  <div className="flex items-center gap-2 flex-wrap text-2xs">
                    <span className="rounded border border-edge px-1.5 py-0.5 text-fg-secondary">
                      {KIND_LABEL[r.kind]}
                    </span>
                    <span className="rounded border border-edge px-1.5 py-0.5 text-fg-secondary">
                      {r.viewport}
                    </span>
                    {r.paddingPx > 0 && (
                      <span className="tabular-nums text-fg-muted">
                        +{r.paddingPx}px pad
                      </span>
                    )}
                  </div>
                </div>
                {onDelete && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete(r.id);
                    }}
                    aria-label="Delete ignore region"
                    className="shrink-0 inline-flex items-center justify-center h-5 w-5 rounded-sm text-fg-muted hover:bg-edge hover:text-fg focus-ring"
                    data-testid="ignore-region-delete"
                  >
                    ×
                  </button>
                )}
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
}
