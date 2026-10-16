import { createMount, handleOf } from "./mount";
import type { ModeRenderer } from "./types";

/**
 * Baseline in pane A, current in pane B, each with its hatching. Both panes
 * hold the same world under the same transform (the host applies it), so a
 * point is at the same place in both and zoom and pan move them together.
 * The host's layers go on pane B, over the current image.
 */
export const sideBySide: ModeRenderer = {
  panes: 2,
  needs: ({ hasBaseline }) =>
    hasBaseline ? ["baseline", "current"] : ["current"],
  host: { pane: 1, layers: ["shading", "regions", "ignore"] },
  mount([paneA, paneB], input) {
    const mount = createMount();
    const { baseline, current } = input.images;
    if (paneA && baseline) {
      mount.image(paneA, baseline, "baseline");
      mount.hatch(paneA, "hatch:baseline", (w) => w.missing.baseline, input);
    }
    if (paneB && current) {
      mount.image(paneB, current, "current");
      mount.hatch(paneB, "hatch:current", (w) => w.missing.current, input);
    }
    return handleOf(mount);
  },
};
