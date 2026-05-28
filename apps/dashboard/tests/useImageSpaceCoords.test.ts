import { renderHook } from "@testing-library/react";
import type { Application, Container, Sprite, Texture } from "pixi.js";
import { describe, expect, it } from "vitest";

import { useImageSpaceCoords } from "../src/components/diff-viewer/useImageSpaceCoords";

/**
 * Unit tests for the client → image-pixel coordinate transform that drives
 * drag-to-draw ignore-region authoring and pick-mode element hit tests.
 *
 * The hook does:
 *   client(x,y)  →  CSS-rect-relative(x,y)  →  image-pixel(x,y) via world.toLocal
 *
 * Key invariant: with `autoDensity: true` + `resolution: dpr` (how Pixi is
 * initialized in ViewerCanvas), Pixi sets `canvas.width = CSS_width * dpr`
 * but leaves `canvas.style.width = CSS_width`. `app.screen.width`, which
 * `fitWorldToCanvas` uses to set `world.position`, is in CSS pixels. So
 * `world.toLocal` expects its input in CSS-pixel stage space — the hook
 * must NOT rescale by `canvas.width / rect.width` before calling it.
 * The DPR case below pins that invariant.
 */

function mockSpriteWithTexture(naturalW: number, naturalH: number): Sprite {
  return {
    texture: { width: naturalW, height: naturalH } as unknown as Texture,
  } as unknown as Sprite;
}

function mockApp(canvasW: number, canvasH: number, rect: DOMRect): Application {
  const canvas = {
    width: canvasW,
    height: canvasH,
    getBoundingClientRect: () => rect,
  } as unknown as HTMLCanvasElement;
  return { canvas } as unknown as Application;
}

function mockWorld(scale: number, posX: number, posY: number): Container {
  // toLocal inverts the world's affine transform: image-pixel = (stage - position) / scale
  return {
    toLocal: ({ x, y }: { x: number; y: number }) => ({
      x: (x - posX) / scale,
      y: (y - posY) / scale,
    }),
  } as unknown as Container;
}

function makeRect(
  left: number,
  top: number,
  width: number,
  height: number,
): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

describe("useImageSpaceCoords", () => {
  it("returns image-pixel coords when canvas, world, and sprite are aligned 1:1", () => {
    const appRef = {
      current: mockApp(1280, 720, makeRect(0, 0, 1280, 720)),
    };
    const worldRef = { current: mockWorld(1, 0, 0) };
    const spriteRef = { current: mockSpriteWithTexture(1280, 720) };

    const { result } = renderHook(() =>
      useImageSpaceCoords({ appRef, worldRef, spriteRef }),
    );
    const fn = result.current;
    expect(fn({ clientX: 100, clientY: 200 } as PointerEvent)).toEqual({
      x: 100,
      y: 200,
    });
  });

  it("uses CSS pointer coords directly (stage is in CSS pixels under autoDensity)", () => {
    // Under autoDensity, the canvas's internal `width` attribute may differ
    // from its CSS rect.width (this is how Pixi packs more device pixels
    // into the same on-screen area for sharpness). The stage / world live
    // in CSS-pixel space, so `world.toLocal` must receive CSS coords —
    // canvas.width / rect.width must NOT be applied as a scaling factor.
    //
    // Here: canvas internal 1280x720 (e.g. DPR=2 backing store), CSS rect
    // 640x360, world is at scale 1 against a 640x360 stage with the sprite
    // drawn at natural size 640x360. Cursor at CSS (50, 100) maps to
    // image-pixel (50, 100).
    const appRef = {
      current: mockApp(1280, 720, makeRect(0, 0, 640, 360)),
    };
    const worldRef = { current: mockWorld(1, 0, 0) };
    const spriteRef = { current: mockSpriteWithTexture(640, 360) };

    const { result } = renderHook(() =>
      useImageSpaceCoords({ appRef, worldRef, spriteRef }),
    );
    const fn = result.current;
    expect(fn({ clientX: 50, clientY: 100 } as PointerEvent)).toEqual({
      x: 50,
      y: 100,
    });
  });

  it("returns null when cursor is outside the image bounds", () => {
    const appRef = {
      current: mockApp(1280, 720, makeRect(0, 0, 1280, 720)),
    };
    const worldRef = { current: mockWorld(1, 0, 0) };
    const spriteRef = { current: mockSpriteWithTexture(1280, 720) };

    const { result } = renderHook(() =>
      useImageSpaceCoords({ appRef, worldRef, spriteRef }),
    );
    const fn = result.current;
    expect(fn({ clientX: 2000, clientY: 200 } as PointerEvent)).toBeNull();
  });

  it("handles world pan offset correctly", () => {
    // The user panned the canvas so world.position = (50, 30). Cursor at
    // CSS (150, 130) should map to image-pixel (100, 100).
    const appRef = {
      current: mockApp(1280, 720, makeRect(0, 0, 1280, 720)),
    };
    const worldRef = { current: mockWorld(1, 50, 30) };
    const spriteRef = { current: mockSpriteWithTexture(1280, 720) };

    const { result } = renderHook(() =>
      useImageSpaceCoords({ appRef, worldRef, spriteRef }),
    );
    const fn = result.current;
    expect(fn({ clientX: 150, clientY: 130 } as PointerEvent)).toEqual({
      x: 100,
      y: 100,
    });
  });

  it("does not double-apply DPR scaling (autoDensity case)", () => {
    // ViewerCanvas inits Pixi with `autoDensity: true` + `resolution: dpr`,
    // which sets `canvas.width = CSS_width * dpr` while `canvas.style.width`
    // (and thus rect.width) stays at CSS_width. Pixi's stage / `app.screen`
    // is in CSS pixels, so `world.toLocal` must receive CSS-pixel input.
    //
    // On a DPR=2 retina display with a 640x360 CSS canvas:
    //   canvas.width  = 1280  (device pixels)
    //   rect.width    = 640   (CSS pixels)
    //   world set up with screen.width = 640, sprite drawn 1:1 at 640x360
    //
    // A click at CSS (100, 50) on a 1:1-fit pane should map to image-pixel
    // (100, 50). If the hook multiplies clientX by canvas.width / rect.width
    // = 2 before handing it to toLocal, it would produce (200, 100) — wrong.
    const appRef = {
      current: mockApp(1280, 720, makeRect(0, 0, 640, 360)),
    };
    // World is set up against CSS-pixel screen space: 640x360 sprite at scale 1, centered.
    const worldRef = { current: mockWorld(1, 0, 0) };
    const spriteRef = { current: mockSpriteWithTexture(640, 360) };

    const { result } = renderHook(() =>
      useImageSpaceCoords({ appRef, worldRef, spriteRef }),
    );
    const fn = result.current;
    expect(fn({ clientX: 100, clientY: 50 } as PointerEvent)).toEqual({
      x: 100,
      y: 50,
    });
  });

  it("subtracts rect.left/top so a non-zero canvas offset doesn't shift coords", () => {
    // The canvas isn't at the document origin — its host has padding /
    // header bars above and to the left of it. The hook must subtract
    // rect.left + rect.top from clientX/Y before applying any other math.
    const appRef = {
      current: mockApp(1280, 720, makeRect(100, 50, 1280, 720)),
    };
    const worldRef = { current: mockWorld(1, 0, 0) };
    const spriteRef = { current: mockSpriteWithTexture(1280, 720) };

    const { result } = renderHook(() =>
      useImageSpaceCoords({ appRef, worldRef, spriteRef }),
    );
    const fn = result.current;
    // Cursor at document (300, 250) is canvas-relative (200, 200) → image (200, 200).
    expect(fn({ clientX: 300, clientY: 250 } as PointerEvent)).toEqual({
      x: 200,
      y: 200,
    });
  });
});
