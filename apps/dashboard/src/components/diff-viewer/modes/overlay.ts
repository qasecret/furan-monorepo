import type { Sprite } from "pixi.js";

import { createMount, handleOf } from "./mount";
import type { ModeRenderer } from "./types";

/**
 * The current image over the baseline at the opacity value, then both
 * hatchings, on one stage. The opacity changes in place.
 */
export const overlay: ModeRenderer = {
  panes: 1,
  needs: ({ hasBaseline }) =>
    hasBaseline ? ["baseline", "current"] : ["current"],
  host: { pane: 0, layers: ["regions", "ignore"] },
  mount([world], input) {
    const mount = createMount();
    if (!world) return handleOf(mount);
    const { baseline, current } = input.images;
    if (baseline) mount.image(world, baseline, "baseline");
    let top: Sprite | null = null;
    if (current) top = mount.image(world, current, "current", input.opacity);
    if (baseline) {
      mount.hatch(world, "hatch:baseline", (w) => w.missing.baseline, input);
    }
    if (current) {
      mount.hatch(world, "hatch:current", (w) => w.missing.current, input);
    }
    return handleOf(mount, ({ opacity }) => {
      if (top) top.alpha = opacity;
    });
  },
};
