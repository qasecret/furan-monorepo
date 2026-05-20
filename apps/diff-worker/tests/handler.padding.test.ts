import { describe, expect, test } from "vitest";

import { inflateRegion } from "../src/handler.js";

describe("inflateRegion", () => {
  test("paddingPx=0 returns bbox unchanged", () => {
    expect(
      inflateRegion(
        { x: 10, y: 10, width: 50, height: 50, paddingPx: 0 },
        { width: 1280, height: 720 },
      ),
    ).toEqual({ x: 10, y: 10, width: 50, height: 50 });
  });

  test("missing paddingPx (legacy row) treated as 0", () => {
    expect(
      inflateRegion({ x: 10, y: 10, width: 50, height: 50 } as never, {
        width: 1280,
        height: 720,
      }),
    ).toEqual({ x: 10, y: 10, width: 50, height: 50 });
  });

  test("paddingPx=5 inflates bbox on all sides", () => {
    expect(
      inflateRegion(
        { x: 10, y: 10, width: 50, height: 50, paddingPx: 5 },
        { width: 1280, height: 720 },
      ),
    ).toEqual({ x: 5, y: 5, width: 60, height: 60 });
  });

  test("clamps at top-left edge", () => {
    expect(
      inflateRegion(
        { x: 2, y: 2, width: 50, height: 50, paddingPx: 5 },
        { width: 1280, height: 720 },
      ),
    ).toEqual({ x: 0, y: 0, width: 57, height: 57 });
  });

  test("clamps at bottom-right edge", () => {
    expect(
      inflateRegion(
        { x: 1230, y: 670, width: 48, height: 48, paddingPx: 8 },
        { width: 1280, height: 720 },
      ),
    ).toEqual({ x: 1222, y: 662, width: 58, height: 58 });
  });

  test("zero-bounds defends against degenerate input", () => {
    // bounds {0,0} → everything clamps to nothing; width/height become 0.
    expect(
      inflateRegion(
        { x: 0, y: 0, width: 10, height: 10, paddingPx: 5 },
        { width: 0, height: 0 },
      ),
    ).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });
});
