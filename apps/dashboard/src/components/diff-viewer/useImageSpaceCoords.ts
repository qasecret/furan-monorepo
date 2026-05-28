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
 *   client(x,y)  →  canvas-CSS(x,y)  →  image-pixel(x,y) via world.toLocal()
 *
 * `world` is a Container whose scale + position are managed by
 * `fitWorldToCanvas` (and, later, zoom/pan). The sprite is added to it
 * at natural texture size, so a local point in `world` IS the image-pixel
 * coordinate — no per-layer scale math.
 *
 * Important: ViewerCanvas initializes Pixi with `autoDensity: true` +
 * `resolution: window.devicePixelRatio`. Under that setup Pixi sets the
 * canvas's internal `width` attribute to `CSS_width × DPR` (device pixels)
 * while leaving `canvas.style.width` (and therefore `getBoundingClientRect`)
 * at `CSS_width`. The stage / `app.screen` — which `fitWorldToCanvas` uses
 * to position `world` — stays in **CSS pixels**. So `world.toLocal` expects
 * its input in CSS-pixel stage coordinates, NOT device pixels.
 *
 * The previous implementation multiplied the cursor by
 * `canvas.width / rect.width` to "convert to device pixels" before calling
 * `toLocal`, which on retina (DPR=2) drove every cursor coord through a 2×
 * factor — visually, drag-to-draw produced an ignore region offset from
 * the cursor by the size of the cursor's distance from the canvas origin.
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

      // Client → CSS-relative pointer coords. These ARE stage coords —
      // Pixi's `app.screen` (under autoDensity) is sized in CSS pixels,
      // so no further DPR rescale is needed.
      const stageX = event.clientX - rect.left;
      const stageY = event.clientY - rect.top;

      // Convert stage-space point → world-local (= image-pixel).
      const local = world.toLocal({ x: stageX, y: stageY });
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
