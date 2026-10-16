import { useMemo } from "react";

import { orderDiffRegions } from "./diff-order";
import type { DiffRegion } from "./layers/regionTypes";
import { useViewState } from "./view-state";
import { useViewerPrefs } from "./viewer-prefs";

export interface DiffStepper {
  count: number;
  /** 0-based index of the selected region in the ordered list, or -1. */
  index: number;
  next: () => void;
  prev: () => void;
}

/**
 * `n` / `p` over the step's regions, worst first. They step through exactly
 * what the region list and the canvas show (R10): "Hide displacement" drops
 * the position-only changes, and the audit rows count only while "Show
 * suppressed" is on.
 */
export function useDiffStepper(regions: DiffRegion[]): DiffStepper {
  const hideDisplacement = useViewerPrefs((s) => s.prefs.hideDisplacement);
  const showSuppressed = useViewState((s) => s.showSuppressed);
  const selectedRegionId = useViewState((s) => s.selectedRegionId);
  const ordered = useMemo(
    () => orderDiffRegions(regions, { hideDisplacement, showSuppressed }),
    [regions, hideDisplacement, showSuppressed],
  );
  const index = ordered.findIndex((r) => r.id === selectedRegionId);

  const go = (dir: 1 | -1) => {
    if (ordered.length === 0) return;
    const store = useViewState.getState();
    const currentIdx = ordered.findIndex(
      (r) => r.id === store.selectedRegionId,
    );
    const nextIdx =
      currentIdx === -1
        ? dir === 1
          ? 0
          : ordered.length - 1
        : (currentIdx + dir + ordered.length) % ordered.length;
    const region = ordered[nextIdx]!;
    store.setSelected(region.id);
    if (region.bbox && typeof region.bbox === "object" && "x" in region.bbox) {
      const b = region.bbox as {
        x: number;
        y: number;
        width: number;
        height: number;
      };
      store.setFocusBbox({ x: b.x, y: b.y, width: b.width, height: b.height });
    }
  };

  return {
    count: ordered.length,
    index,
    next: () => go(1),
    prev: () => go(-1),
  };
}
