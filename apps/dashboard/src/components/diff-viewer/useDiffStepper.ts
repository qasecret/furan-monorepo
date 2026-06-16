import { useMemo } from "react";

import { orderDiffRegions } from "./diff-order";
import type { DiffRegion } from "./layers/regionTypes";
import { useViewerStore } from "./useViewerStore";

export interface DiffStepper {
  count: number;
  /** 0-based index of the selected region in the ordered list, or -1. */
  index: number;
  next: () => void;
  prev: () => void;
}

export function useDiffStepper(regions: DiffRegion[]): DiffStepper {
  const hideDisplacement = useViewerStore((s) => s.hideDisplacement);
  const selectedRegionId = useViewerStore((s) => s.selectedRegionId);
  const ordered = useMemo(
    () => orderDiffRegions(regions, { hideDisplacement }),
    [regions, hideDisplacement],
  );
  const index = ordered.findIndex((r) => r.id === selectedRegionId);

  const go = (dir: 1 | -1) => {
    if (ordered.length === 0) return;
    const nextIdx =
      index === -1
        ? dir === 1
          ? 0
          : ordered.length - 1
        : (index + dir + ordered.length) % ordered.length;
    const region = ordered[nextIdx]!;
    const store = useViewerStore.getState();
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
