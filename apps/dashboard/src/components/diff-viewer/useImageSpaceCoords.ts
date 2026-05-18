import type { Application, Sprite } from "pixi.js";
import { useCallback, type MutableRefObject } from "react";

interface Refs {
  appRef: MutableRefObject<Application | null>;
  spriteRef: MutableRefObject<Sprite | null>;
}

export interface ImagePoint {
  x: number;
  y: number;
}

/**
 * Returns a function that converts a screen-space `PointerEvent` into the
 * natural image-pixel coordinates of the sprite's underlying texture.
 *
 * The math: the sprite is rendered at app.screen size (per
 * mountImageLayer's sprite.width = app.screen.width). The texture's
 * natural width/height gives the source pixel space. The pointer's
 * clientX/clientY relative to the canvas element scales by
 * (texture.width / sprite.width).
 *
 * Returns `null` when the refs are not yet populated (initial render).
 */
export function useImageSpaceCoords({ appRef, spriteRef }: Refs) {
  return useCallback(
    (event: PointerEvent | React.PointerEvent): ImagePoint | null => {
      const app = appRef.current;
      const sprite = spriteRef.current;
      if (!app || !sprite) return null;

      const canvas = app.canvas as HTMLCanvasElement;
      const rect = canvas.getBoundingClientRect();
      const screenX = event.clientX - rect.left;
      const screenY = event.clientY - rect.top;

      // Account for CSS scaling: clientX/Y are in CSS pixels; the canvas
      // is drawn at its intrinsic resolution. Use the displayed size for
      // the ratio so a CSS-resized canvas still maps correctly.
      const cssToCanvasX = canvas.width / rect.width;
      const cssToCanvasY = canvas.height / rect.height;
      const canvasX = screenX * cssToCanvasX;
      const canvasY = screenY * cssToCanvasY;

      // Sprite is drawn at app.screen.* size. Convert canvas coords →
      // sprite local coords → texture pixel coords.
      const spriteW = sprite.width;
      const spriteH = sprite.height;
      const tex = sprite.texture;
      const naturalW = tex.width;
      const naturalH = tex.height;

      const xRatio = naturalW / spriteW;
      const yRatio = naturalH / spriteH;

      return {
        x: Math.max(0, Math.round(canvasX * xRatio)),
        y: Math.max(0, Math.round(canvasY * yRatio)),
      };
    },
    [appRef, spriteRef],
  );
}
