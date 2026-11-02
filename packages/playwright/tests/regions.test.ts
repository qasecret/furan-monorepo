import type { Box } from "@furan/client";
import { describe, expect, it } from "vitest";

import { toImageRegion, type CaptureMode } from "../src/regions.js";

const image = { width: 100, height: 100 };
const b = (x: number, y: number, width: number, height: number): Box => ({
  x,
  y,
  width,
  height,
});

describe("toImageRegion", () => {
  it.each<[string, Box, CaptureMode, Box | null]>([
    [
      "a viewport shot keeps the box",
      b(10, 20, 30, 40),
      { kind: "viewport" },
      b(10, 20, 30, 40),
    ],
    [
      "a full-page shot adds the scroll",
      b(10, 20, 30, 40),
      { kind: "fullPage", scrollX: 0, scrollY: 50 },
      b(10, 70, 30, 30),
    ],
    [
      "an element shot is relative to the element",
      b(110, 110, 10, 10),
      { kind: "element", box: b(100, 100, 50, 50) },
      b(10, 10, 10, 10),
    ],
    [
      "a box crossing the edge is clipped",
      b(90, 90, 20, 20),
      { kind: "viewport" },
      b(90, 90, 10, 10),
    ],
    [
      "a box outside the image is dropped",
      b(200, 10, 5, 5),
      { kind: "viewport" },
      null,
    ],
    ["a zero-size box is dropped", b(10, 10, 0, 5), { kind: "viewport" }, null],
    [
      "fractional CSS boxes round outward",
      b(10.4, 20.6, 5.2, 5.2),
      { kind: "viewport" },
      b(10, 20, 6, 6),
    ],
  ])("%s", (_name, box, mode, expected) => {
    expect(toImageRegion(box, mode, image)).toEqual(expected);
  });

  it("a full page taller than the viewport keeps a box below the fold", () => {
    expect(
      toImageRegion(
        b(0, 700, 100, 50),
        { kind: "fullPage", scrollX: 0, scrollY: 0 },
        { width: 100, height: 2000 },
      ),
    ).toEqual(b(0, 700, 100, 50));
  });
});
