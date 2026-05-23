import type { Application, Container, Sprite } from "pixi.js";
import { useCallback, type MutableRefObject } from "react";

interface Refs {
  appRef: MutableRefObject<Application | null>;
  worldRef: MutableRefObject<Container | null>;
  spriteRef: MutableRefObject<Sprite | null>;
}

export interface ImagePoint {
  x: number;
  y: number;
}

/**
 * Returns a function that converts a DOM `PointerEvent` into the natural
 * image-pixel coordinates of the candidate sprite's underlying texture.
 *
 * Math:
 *   client(x,y)  →  canvas-CSS(x,y)  →  canvas-device(x,y)
 *                                          via world.toLocal()
 *                                       →  image-pixel(x,y)
 *
 * `world` is a Container whose scale + position are managed by
 * `fitWorldToCanvas` (and, later, zoom/pan). The sprite is added to it
 * at natural texture size, so a local point in `world` IS the image-pixel
 * coordinate — no per-layer scale math.
 *
 * Returns `null` when refs aren't populated, when the pointer falls
 * outside the image bounds, or when the sprite has no texture.
 */
export function useImageSpaceCoords({ appRef, worldRef, spriteRef }: Refs) {
  return useCallback(
    (event: PointerEvent | React.PointerEvent): ImagePoint | null => {
      const app = appRef.current;
      const world = worldRef.current;
      const sprite = spriteRef.current;
      if (!app || !world || !sprite) return null;

      const canvas = app.canvas as HTMLCanvasElement;
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;

      // CSS pixels → canvas device pixels. Pixi's stage is in device
      // pixels by default, so we need this rescale even when DPR === 1
      // (CSS may still resize the canvas via width: 100%).
      const cssToCanvasX = canvas.width / rect.width;
      const cssToCanvasY = canvas.height / rect.height;
      const canvasX = (event.clientX - rect.left) * cssToCanvasX;
      const canvasY = (event.clientY - rect.top) * cssToCanvasY;

      // Convert canvas/stage-space point → world-local (= image-pixel).
      const local = world.toLocal({ x: canvasX, y: canvasY });
      const tex = sprite.texture;
      const naturalW = tex.width;
      const naturalH = tex.height;
      // Clamp to image bounds; out-of-bounds clicks (in the letterbox
      // bands around the image) should not count.
      if (
        local.x < 0 ||
        local.y < 0 ||
        local.x > naturalW ||
        local.y > naturalH
      ) {
        return null;
      }
      return {
        x: Math.round(local.x),
        y: Math.round(local.y),
      };
    },
    [appRef, worldRef, spriteRef],
  );
}
