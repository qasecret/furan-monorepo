import { type Container, type Graphics, Sprite, Texture } from "pixi.js";

import { drawHatch, mountHatchLayer } from "../layers/HatchLayer";
import type { Rect, World } from "../viewer-geometry";

import type { ModeHandle, RenderInput } from "./types";

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
  ): void;
  /** Redraws the hatching for a new world or a new colour. */
  update(input: RenderInput): void;
  dispose(): void;
}

interface Hatch {
  g: Graphics;
  rects: (world: World) => Rect[];
  world: World;
  color: number;
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
      const g = mountHatchLayer(parent, rects(input.world), input.colors.hatch);
      g.label = label;
      hatches.push({ g, rects, world: input.world, color: input.colors.hatch });
    },
    update(input) {
      if (disposed) return;
      for (const h of hatches) {
        if (h.world === input.world && h.color === input.colors.hatch) {
          continue;
        }
        drawHatch(h.g, h.rects(input.world), input.colors.hatch);
        h.world = input.world;
        h.color = input.colors.hatch;
      }
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
