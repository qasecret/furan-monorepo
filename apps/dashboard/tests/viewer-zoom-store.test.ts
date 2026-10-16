import { beforeEach, describe, expect, it } from "vitest";

import { useViewState } from "../src/components/diff-viewer/view-state";
import {
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_STEP,
  type Size,
} from "../src/components/diff-viewer/viewer-geometry";

/** A world that fits its 400×200 viewport at 1:1. */
const WORLD: Size = { w: 400, h: 200 };
const VIEWPORT: Size = { w: 400, h: 200 };

describe("useViewState — zoom + pan", () => {
  beforeEach(() => {
    useViewState.setState({ zoom: 1, panX: 0, panY: 0 });
  });

  it("zoomBy multiplies the current zoom, clamped to [ZOOM_MIN, ZOOM_MAX]", () => {
    useViewState.getState().zoomBy(2);
    expect(useViewState.getState().zoom).toBe(2);

    useViewState.getState().zoomBy(0.5);
    expect(useViewState.getState().zoom).toBe(1);

    useViewState.setState({ zoom: ZOOM_MAX });
    useViewState.getState().zoomBy(2);
    expect(useViewState.getState().zoom).toBe(ZOOM_MAX);

    useViewState.setState({ zoom: ZOOM_MIN });
    useViewState.getState().zoomBy(0.1);
    expect(useViewState.getState().zoom).toBe(ZOOM_MIN);
  });

  it("setZoom clamps to bounds and rejects non-finite", () => {
    useViewState.getState().setZoom(0.0001);
    expect(useViewState.getState().zoom).toBe(ZOOM_MIN);

    useViewState.getState().setZoom(1000);
    expect(useViewState.getState().zoom).toBe(ZOOM_MAX);

    useViewState.getState().setZoom(Number.NaN);
    expect(useViewState.getState().zoom).toBe(1);
  });

  it("resetZoom clears zoom AND pan in a single action", () => {
    useViewState.setState({ zoom: 3, panX: 50, panY: -25 });
    useViewState.getState().resetZoom();
    const s = useViewState.getState();
    expect(s.zoom).toBe(1);
    expect(s.panX).toBe(0);
    expect(s.panY).toBe(0);
  });

  it("panBy is additive, in world px: a drag over the transform's scale", () => {
    useViewState.getState().panBy(10, -5, 1);
    useViewState.getState().panBy(2, 3, 1);
    expect(useViewState.getState()).toMatchObject({ panX: 12, panY: -2 });
    // At 2 canvas px per world px, a 10 px drag is 5 world px.
    useViewState.getState().panBy(10, -4, 2);
    expect(useViewState.getState()).toMatchObject({ panX: 17, panY: -4 });
  });

  it("panBy ignores a scale that is not a positive number", () => {
    useViewState.getState().panBy(10, 10, 0);
    useViewState.getState().panBy(10, 10, Number.NaN);
    expect(useViewState.getState()).toMatchObject({ panX: 0, panY: 0 });
  });

  it("zoomAt keeps the anchored point under the cursor (no-pan center)", () => {
    // Anchor at canvas center → pan should not move when zooming about
    // the center, because (anchor - center) is zero.
    useViewState
      .getState()
      .zoomAt(ZOOM_STEP, { x: 200, y: 100 }, WORLD, VIEWPORT);
    const s = useViewState.getState();
    expect(s.zoom).toBe(ZOOM_STEP);
    expect(s.panX).toBe(0);
    expect(s.panY).toBe(0);
  });

  it("zoomAt off-center applies opposing pan so the anchor stays put", () => {
    // Canvas 400x200, anchor at (300, 100) — 100px right of center.
    // After zooming by 2x, the world point under (300,100) was at
    // (300 - 200) = +100 right of center; at new zoom that point would
    // move to +200 right of center, so pan must shift -100 canvas px to
    // compensate: -50 world px at 2 canvas px per world px.
    useViewState.getState().zoomAt(2, { x: 300, y: 100 }, WORLD, VIEWPORT);
    const s = useViewState.getState();
    expect(s.zoom).toBe(2);
    expect(s.panX).toBe(-50);
    expect(s.panY).toBe(0);
  });

  it("zoomAt at clamp boundary is a no-op (no spurious pan)", () => {
    useViewState.setState({ zoom: ZOOM_MAX, panX: 7, panY: 9 });
    useViewState.getState().zoomAt(2, { x: 300, y: 100 }, WORLD, VIEWPORT);
    const s = useViewState.getState();
    expect(s.zoom).toBe(ZOOM_MAX);
    // Pan untouched — zoomAt leaves the view alone when the clamped zoom
    // didn't actually change, so we don't accumulate phantom pan offsets
    // every time the user keeps scrolling past max.
    expect(s.panX).toBe(7);
    expect(s.panY).toBe(9);
  });
});
