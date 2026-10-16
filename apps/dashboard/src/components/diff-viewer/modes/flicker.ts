import { Container } from "pixi.js";

import { createMount, handleOf, SINGLE_STAGE_HOST_LAYERS } from "./mount";
import type { HatchedImage, ModeRenderer, RenderInput } from "./types";

const FRAMES: readonly HatchedImage[] = ["baseline", "current"];

/**
 * Flicker (spec §4.3): the baseline and the current image alternate in
 * place, on one stage. Its layers, bottom to top: the frame (both images,
 * one shown), the frame's hatching, then the host's regions and ignore
 * regions, which stay on both frames (R17).
 *
 * Both images are mounted once, each a sprite with its own texture in the
 * `frame` container, and each image's hatching likewise in `hatch:frame`. A
 * swap only flips which of each pair is visible: it is instant (no fade, so
 * the luminance never ramps), and it never remounts, re-uploads or refetches.
 * When the timer swaps is `useFlickerTimer`'s business, not the renderer's.
 */
export const flicker: ModeRenderer = {
  panes: 1,
  needs: () => ["baseline", "current"],
  host: { pane: 0, layers: SINGLE_STAGE_HOST_LAYERS },
  draws: ["baseline", "current"],
  hatched: ({ flickerFrame }) => [[flickerFrame]],
  mount([world], input) {
    const mount = createMount();
    if (!world) return handleOf(mount);
    const frame = mount.own(world, new Container(), "frame");
    const hatch = mount.own(world, new Container(), "hatch:frame");
    // Each image with its hatching, for the frame that shows it.
    const pairs: Array<[HatchedImage, Container[]]> = [];
    for (const image of FRAMES) {
      const bitmap = input.images[image];
      if (!bitmap) continue;
      pairs.push([
        image,
        [
          mount.image(frame, bitmap, `frame:${image}`),
          mount.hatch(hatch, `hatch:${image}`, (w) => w.missing[image], input),
        ],
      ]);
    }
    const show = ({ flickerFrame }: RenderInput) => {
      for (const [image, shown] of pairs) {
        for (const o of shown) o.visible = image === flickerFrame;
      }
    };
    show(input);
    return handleOf(mount, show);
  },
};
