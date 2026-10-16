import { describe, expect, it } from "vitest";

import { pointerToImage } from "../src/components/diff-viewer/pointer-to-image";
import { transformFor } from "../src/components/diff-viewer/viewer-geometry";

/**
 * The client → image-pixel conversion behind drag-to-draw ignore regions and
 * pick-mode element hits:
 *
 *   client(x,y) → canvas CSS px (minus the canvas's rect) → world via
 *   canvasToWorld, and the world is in image pixels.
 *
 * Key invariant: pixi runs with `autoDensity: true` + `resolution: dpr`, so
 * the canvas's backing store is `CSS_width × dpr` while its rect stays at the
 * CSS width. The world transform is in CSS px, so the pointer must NOT be
 * rescaled by `canvas.width / rect.width`. The DPR cases below pin that.
 */

function rect(left: number, top: number, width: number, height: number) {
  return { left, top, width, height };
}

const at = (clientX: number, clientY: number) => ({ clientX, clientY });
const identity = { scale: 1, x: 0, y: 0 };

describe("pointerToImage", () => {
  it("returns image-pixel coords when canvas and world are aligned 1:1", () => {
    expect(
      pointerToImage(at(100, 200), rect(0, 0, 1280, 720), identity, {
        w: 1280,
        h: 720,
      }),
    ).toEqual({ x: 100, y: 200 });
  });

  it("uses CSS pointer coords directly (the transform is in CSS px under autoDensity)", () => {
    // A DPR=2 backing store of 1280×720 shows as a 640×360 CSS rect; the
    // world is fitted against the CSS size, 1:1 here.
    expect(
      pointerToImage(at(50, 100), rect(0, 0, 640, 360), identity, {
        w: 640,
        h: 360,
      }),
    ).toEqual({ x: 50, y: 100 });
  });

  it("returns null when the pointer is outside the image", () => {
    expect(
      pointerToImage(at(2000, 200), rect(0, 0, 1280, 720), identity, {
        w: 1280,
        h: 720,
      }),
    ).toBeNull();
    expect(
      pointerToImage(at(-1, 5), rect(0, 0, 1280, 720), identity, {
        w: 1280,
        h: 720,
      }),
    ).toBeNull();
  });

  it("is outside the image in the world's area the image does not cover", () => {
    // A 100×200 image in a 100×300 world: y 250 is world, but not image.
    expect(
      pointerToImage(at(50, 250), rect(0, 0, 100, 300), identity, {
        w: 100,
        h: 200,
      }),
    ).toBeNull();
  });

  it("undoes the pan offset", () => {
    expect(
      pointerToImage(
        at(150, 130),
        rect(0, 0, 1280, 720),
        { scale: 1, x: 50, y: 30 },
        { w: 1280, h: 720 },
      ),
    ).toEqual({ x: 100, y: 100 });
  });

  it("undoes the fit and zoom scale, rounding to whole pixels", () => {
    // A 400×300 world fitted into 800×600 is 2×; zoomed 1.5× about the
    // centre it is 3×, offset so the centre stays put.
    const t = transformFor(
      { w: 400, h: 300 },
      { w: 800, h: 600 },
      { zoom: 1.5, panX: 0, panY: 0 },
    );
    expect(t.scale).toBe(3);
    expect(
      pointerToImage(at(400, 300), rect(0, 0, 800, 600), t, {
        w: 400,
        h: 300,
      }),
    ).toEqual({ x: 200, y: 150 });
    expect(
      pointerToImage(at(401, 302), rect(0, 0, 800, 600), t, {
        w: 400,
        h: 300,
      }),
    ).toEqual({ x: 200, y: 151 });
  });

  it("subtracts rect.left/top so a canvas off the page origin doesn't shift coords", () => {
    expect(
      pointerToImage(at(300, 250), rect(100, 50, 1280, 720), identity, {
        w: 1280,
        h: 720,
      }),
    ).toEqual({ x: 200, y: 200 });
  });

  it("returns null for a canvas with no size (not laid out yet)", () => {
    expect(
      pointerToImage(at(0, 0), rect(0, 0, 0, 0), identity, { w: 10, h: 10 }),
    ).toBeNull();
  });
});
