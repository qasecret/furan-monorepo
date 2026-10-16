import { type Container, type Graphics, Sprite, Texture } from "pixi.js";

import {
  drawHatch,
  HATCH_SPACING,
  mountHatchLayer,
} from "../layers/HatchLayer";
import type { Rect, World } from "../viewer-geometry";

import type { HostLayer, ModeHandle, RenderInput } from "./types";

/**
 * The host's layers on a single stage (swipe, flicker, overlay, diff): one
 * constant, so a mode change between them keeps those layers mounted.
 */
export const SINGLE_STAGE_HOST_LAYERS: readonly HostLayer[] = [
  "regions",
  "ignore",
];

/** The hatch's world spacing for a scale: `HATCH_SPACING` on screen. */
const hatchSpacing = (scale: number) => HATCH_SPACING / scale;

/**
 * What one renderer mount adds to the stage, kept so it is torn down as one.
 *
 * Textures: each sprite gets a texture of its own, made from the cached
 * bitmap and kept out of pixi's global texture cache (`skipCache`), so no one
 * else can hold it. Disposing destroys the sprite, its texture and the
 * texture's source. A source's `destroy` only frees its GPU copy and drops
 * its reference to the bitmap; pixi never closes a bitmap, and neither does
 * this. The image cache owns them and is the only code that closes one.
 */
export interface Mount {
  /** A sprite of `bitmap`, labelled, added to `parent`. */
  image(
    parent: Container,
    bitmap: ImageBitmap,
    label: string,
    alpha?: number,
  ): Sprite;
  /** The hatching of the world area `rects` picks, labelled, added to `parent`. */
  hatch(
    parent: Container,
    label: string,
    rects: (world: World) => Rect[],
    input: RenderInput,
  ): Graphics;
  /**
   * A display object of the mode's own (a container, a clip, a line),
   * labelled, added to `parent`, and destroyed with the mount after its
   * images and hatching. A clip one carries (`mask`) is let go of first.
   */
  own<T extends Container>(parent: Container, child: T, label: string): T;
  /** Redraws the hatching for a new world, scale or colour. */
  update(input: RenderInput): void;
  dispose(): void;
}

interface Hatch {
  g: Graphics;
  rects: (world: World) => Rect[];
  world: World;
  color: number;
  scale: number;
}

/** Teardown is best effort: a leaked GPU texture beats a thrown cleanup. */
function destroyQuietly(destroy: () => void): void {
  try {
    destroy();
  } catch (err) {
    console.warn("viewer layer destroy threw (non-fatal)", err);
  }
}

export function createMount(): Mount {
  const sprites: Sprite[] = [];
  const hatches: Hatch[] = [];
  const owned: Container[] = [];
  let disposed = false;

  return {
    image(parent, bitmap, label, alpha = 1) {
      const sprite = new Sprite(Texture.from(bitmap, true));
      sprite.label = label;
      sprite.alpha = alpha;
      parent.addChild(sprite);
      sprites.push(sprite);
      return sprite;
    },
    hatch(parent, label, rects, input) {
      const { scale } = input.transform;
      const g = mountHatchLayer(
        parent,
        rects(input.world),
        input.colors.hatch,
        hatchSpacing(scale),
      );
      g.label = label;
      hatches.push({
        g,
        rects,
        world: input.world,
        color: input.colors.hatch,
        scale,
      });
      return g;
    },
    update(input) {
      if (disposed) return;
      const { scale } = input.transform;
      for (const h of hatches) {
        if (
          h.world === input.world &&
          h.color === input.colors.hatch &&
          h.scale === scale
        ) {
          continue;
        }
        drawHatch(
          h.g,
          h.rects(input.world),
          input.colors.hatch,
          hatchSpacing(scale),
        );
        h.world = input.world;
        h.color = input.colors.hatch;
        h.scale = scale;
      }
    },
    own(parent, child, label) {
      child.label = label;
      parent.addChild(child);
      owned.push(child);
      return child;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const sprite of sprites) {
        destroyQuietly(() =>
          sprite.destroy({ texture: true, textureSource: true }),
        );
      }
      for (const h of hatches) destroyQuietly(() => h.g.destroy());
      // pixi lets go of a clip's effect when it is unset, not on a destroy.
      for (const o of owned) {
        if (!o.mask) continue;
        destroyQuietly(() => {
          o.mask = null;
        });
      }
      // Last made, first gone: a clip before the container that held it.
      for (const o of owned.slice().reverse()) {
        destroyQuietly(() => o.destroy());
      }
    },
  };
}

/** A handle whose `update` also does the mode's own updates. */
export function handleOf(
  mount: Mount,
  update?: (input: RenderInput) => void,
): ModeHandle {
  return {
    update(input) {
      mount.update(input);
      update?.(input);
    },
    dispose: () => mount.dispose(),
  };
}
