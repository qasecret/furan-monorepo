import { createMount, handleOf, SINGLE_STAGE_HOST_LAYERS } from "./mount";
import type { ModeRenderer } from "./types";

/** The current image, faded so the changed pixels read over it. */
export const DIFF_CURRENT_ALPHA = 0.35;
/**
 * The diff engines write an opaque PNG (the image with its changed pixels
 * marked), so it is drawn translucent over the faded current image, as
 * before.
 */
export const DIFF_IMAGE_ALPHA = 0.6;

/**
 * The changed pixels over a faded current image, with the current image's
 * hatching. The baseline is not drawn, but it is waited for: it takes part in
 * the world, so the world (its fit, the hatching) is final at the first draw.
 */
export const diff: ModeRenderer = {
  panes: 1,
  needs: () => ["baseline", "current", "diff"],
  host: { pane: 0, layers: SINGLE_STAGE_HOST_LAYERS },
  hatched: [["current"]],
  mount([world], input) {
    const mount = createMount();
    if (!world) return handleOf(mount);
    const { current, diff: changed } = input.images;
    if (current) mount.image(world, current, "current", DIFF_CURRENT_ALPHA);
    if (changed) mount.image(world, changed, "diff", DIFF_IMAGE_ALPHA);
    if (current) {
      mount.hatch(world, "hatch:current", (w) => w.missing.current, input);
    }
    return handleOf(mount);
  },
};
