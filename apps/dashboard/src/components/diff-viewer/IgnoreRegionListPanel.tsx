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
      className="border-l border-zinc-200 bg-white flex flex-col w-80 max-w-[40vw] dark:border-zinc-800 dark:bg-zinc-950"
      data-testid="ignore-region-list-panel"
    >
      <div className="p-2 border-b border-zinc-200 flex items-center justify-between gap-2 flex-wrap dark:border-zinc-800">
        <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
          Ignore regions ({forViewport.length})
        </span>
      </div>
      <div className="overflow-auto flex-1 p-2 space-y-1">
        {forViewport.length === 0 ? (
          <div
            className="flex flex-col items-center justify-center gap-1 p-6 text-center"
            data-testid="ignore-regions-empty-state"
          >
            <div className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
              No ignore regions yet
            </div>
            <div className="text-xs text-zinc-500 max-w-[18rem]">
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
                  "rounded-md border p-2 text-xs flex items-start justify-between gap-2 cursor-pointer transition-colors",
                  isSelected
                    ? "border-brand bg-brand/10 text-zinc-950 dark:text-white"
                    : "border-zinc-200 text-zinc-700 hover:bg-zinc-100 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-900",
                )}
                data-testid="ignore-region-item"
                data-region-id={r.id}
              >
                <div className="flex flex-col gap-0.5 min-w-0 flex-1">
                  <div className="font-mono text-[11px] text-zinc-600 dark:text-zinc-400">
                    {x}, {y} — {w}×{h}
                  </div>
                  <div className="flex items-center gap-2 flex-wrap text-[11px]">
                    <span className="rounded border border-zinc-200 px-1.5 py-0.5 text-zinc-600 dark:border-zinc-700 dark:text-zinc-400">
                      {KIND_LABEL[r.kind]}
                    </span>
                    <span className="rounded border border-zinc-200 px-1.5 py-0.5 text-zinc-600 dark:border-zinc-700 dark:text-zinc-400">
                      {r.viewport}
                    </span>
                    {r.paddingPx > 0 && (
                      <span className="text-zinc-500">
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
                    className="shrink-0 inline-flex items-center justify-center h-5 w-5 rounded-sm text-zinc-500 hover:bg-zinc-200 hover:text-zinc-950 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-white"
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
