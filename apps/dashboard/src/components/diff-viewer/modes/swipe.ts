import { Container, Graphics } from "pixi.js";

import { canvasToWorld, type Rect } from "../viewer-geometry";

import { createMount, handleOf, SINGLE_STAGE_HOST_LAYERS } from "./mount";
import type {
  HatchedImage,
  ModeRenderer,
  RenderInput,
  SplitInput,
} from "./types";

/** The divider's width on screen, in canvas px (spec §4.2). */
const DIVIDER_WIDTH = 2;

/**
 * The divider's place in the world: its fraction of the canvas's width,
 * through the world transform. The fraction is of the canvas, not of the
 * world, so zoom, pan and resizes leave the divider where the reviewer put
 * it on screen, and the world moves under it.
 */
function splitX({ transform, swipe, canvas }: SplitInput): number {
  return canvasToWorld(transform, { x: swipe * canvas.w, y: 0 }).x;
}

/**
 * Where each image shows (R15), in world px, over the world's height: the
 * baseline from the world's left edge to the divider, `[min(0, x) … x]`, and
 * the current from the divider to the world's right edge, `[x … max(W, x)]`.
 * A divider past an edge leaves one side empty.
 */
export function swipeSides(input: SplitInput): Record<HatchedImage, Rect> {
  const { w, h } = input.world.size;
  const x = splitX(input);
  const left = Math.min(0, x);
  return {
    baseline: { x: left, y: 0, w: x - left, h },
    current: { x, y: 0, w: Math.max(w, x) - x, h },
  };
}

const SIDES: readonly HatchedImage[] = ["baseline", "current"];

/**
 * Swipe (spec §4.2): the baseline left of the divider and the current image
 * right of it, then the divider, on one stage. Each side shows only its own
 * image (R15): each image sits in a container with its hatching and a
 * stencil clip to its side (`swipeSides`), so where the current image does
 * not reach, the right of the divider shows its hatching over the empty
 * canvas, never the baseline (and the mirror on the left). The two clips are
 * disjoint, so either image's hatching may stack under the other image.
 *
 * The clips and the divider are drawn in world px, again whenever the swipe,
 * the transform or the canvas changes; the divider keeps 2 px on screen and
 * spans the canvas's height. Its handle is DOM over the stage
 * (`SwipeHandle`).
 */
export const swipe: ModeRenderer = {
  panes: 1,
  needs: () => ["baseline", "current"],
  host: { pane: 0, layers: SINGLE_STAGE_HOST_LAYERS },
  draws: ["baseline", "current"],
  hatched: [["baseline", "current"]],
  shownIn: swipeSides,
  mount([world], input) {
    const mount = createMount();
    if (!world) return handleOf(mount);
    // Each clip sits beside its image in their own container, so the world's
    // transform places both and pixi keeps the clip's transform up to date.
    const clips: Array<[HatchedImage, Graphics]> = [];
    for (const side of SIDES) {
      const bitmap = input.images[side];
      if (!bitmap) continue;
      const shown = mount.own(world, new Container(), side);
      mount.image(shown, bitmap, `${side}:image`);
      mount.hatch(shown, `hatch:${side}`, (w) => w.missing[side], input);
      const clip = mount.own(shown, new Graphics(), `${side}:mask`);
      shown.mask = clip;
      clips.push([side, clip]);
    }
    const divider = mount.own(world, new Graphics(), "divider");

    const draw = (next: RenderInput) => {
      const sides = swipeSides(next);
      for (const [side, clip] of clips) {
        const r = sides[side];
        // A stencil clip: only its coverage counts, not its colour.
        clip.clear().rect(r.x, r.y, r.w, r.h).fill();
      }
      const t = next.transform;
      const width = DIVIDER_WIDTH / t.scale;
      const top = canvasToWorld(t, { x: 0, y: 0 }).y;
      divider
        .clear()
        .rect(sides.current.x - width / 2, top, width, next.canvas.h / t.scale)
        .fill({ color: next.colors.divider });
    };
    draw(input);
    return handleOf(mount, draw);
  },
};
