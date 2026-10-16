import { Container, Graphics } from "pixi.js";

import { canvasToWorld } from "../viewer-geometry";

import { createMount, handleOf, SINGLE_STAGE_HOST_LAYERS } from "./mount";
import type { ModeRenderer, RenderInput } from "./types";

/** The divider's width on screen, in canvas px (spec §4.2). */
const DIVIDER_WIDTH = 2;

/**
 * The divider's place in the world: its fraction of the canvas's width,
 * through the world transform. The fraction is of the canvas, not of the
 * world, so zoom, pan and resizes leave the divider where the reviewer put
 * it on screen, and the world moves under it.
 */
function splitX({ transform, swipe, canvas }: RenderInput): number {
  return canvasToWorld(transform, { x: swipe * canvas.w, y: 0 }).x;
}

/**
 * Swipe (spec §4.2): the baseline, then the current image clipped to the
 * right of the divider, both hatchings and the divider, on one stage. The
 * clip and the divider are drawn in world px, again whenever the swipe, the
 * transform or the canvas changes; the divider keeps 2 px on screen and spans
 * the canvas's height. Its handle is DOM over the stage (`SwipeHandle`).
 */
export const swipe: ModeRenderer = {
  panes: 1,
  needs: () => ["baseline", "current"],
  host: { pane: 0, layers: SINGLE_STAGE_HOST_LAYERS },
  draws: ["baseline", "current"],
  hatched: [["baseline", "current"]],
  mount([world], input) {
    const mount = createMount();
    if (!world) return handleOf(mount);
    const { baseline, current } = input.images;
    if (baseline) mount.image(world, baseline, "baseline");
    // The clip sits beside the image in their own container, so the world's
    // transform places both and pixi keeps the clip's transform up to date.
    let clip: Graphics | null = null;
    if (current) {
      const clipped = mount.own(world, new Container(), "current");
      mount.image(clipped, current, "current:image");
      clip = mount.own(clipped, new Graphics(), "current:mask");
      clipped.mask = clip;
    }
    if (baseline) {
      mount.hatch(world, "hatch:baseline", (w) => w.missing.baseline, input);
    }
    if (current) {
      mount.hatch(world, "hatch:current", (w) => w.missing.current, input);
    }
    const divider = mount.own(world, new Graphics(), "divider");

    const draw = (next: RenderInput) => {
      const { size } = next.world;
      const t = next.transform;
      const x = splitX(next);
      // A stencil clip: only its coverage counts, not its colour.
      clip
        ?.clear()
        .rect(x, 0, Math.max(0, size.w - x), size.h)
        .fill();
      const width = DIVIDER_WIDTH / t.scale;
      const top = canvasToWorld(t, { x: 0, y: 0 }).y;
      divider
        .clear()
        .rect(x - width / 2, top, width, next.canvas.h / t.scale)
        .fill({ color: next.colors.divider });
    };
    draw(input);
    return handleOf(mount, draw);
  },
};
