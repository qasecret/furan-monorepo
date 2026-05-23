import { beforeEach, describe, expect, it } from "vitest";

import {
  useViewerStore,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_STEP,
} from "../src/components/diff-viewer/useViewerStore";

describe("useViewerStore — zoom + pan slice", () => {
  beforeEach(() => {
    useViewerStore.setState({
      zoom: 1,
      panX: 0,
      panY: 0,
      mode: "side-by-side",
    });
  });

  it("zoomBy multiplies the current zoom, clamped to [ZOOM_MIN, ZOOM_MAX]", () => {
    useViewerStore.getState().zoomBy(2);
    expect(useViewerStore.getState().zoom).toBe(2);

    useViewerStore.getState().zoomBy(0.5);
    expect(useViewerStore.getState().zoom).toBe(1);

    useViewerStore.setState({ zoom: ZOOM_MAX });
    useViewerStore.getState().zoomBy(2);
    expect(useViewerStore.getState().zoom).toBe(ZOOM_MAX);

    useViewerStore.setState({ zoom: ZOOM_MIN });
    useViewerStore.getState().zoomBy(0.1);
    expect(useViewerStore.getState().zoom).toBe(ZOOM_MIN);
  });

  it("setZoom clamps to bounds and rejects non-finite", () => {
    useViewerStore.getState().setZoom(0.0001);
    expect(useViewerStore.getState().zoom).toBe(ZOOM_MIN);

    useViewerStore.getState().setZoom(1000);
    expect(useViewerStore.getState().zoom).toBe(ZOOM_MAX);

    useViewerStore.getState().setZoom(Number.NaN);
    expect(useViewerStore.getState().zoom).toBe(1);
  });

  it("resetZoom clears zoom AND pan in a single action", () => {
    useViewerStore.setState({ zoom: 3, panX: 50, panY: -25 });
    useViewerStore.getState().resetZoom();
    const s = useViewerStore.getState();
    expect(s.zoom).toBe(1);
    expect(s.panX).toBe(0);
    expect(s.panY).toBe(0);
  });

  it("panBy is additive", () => {
    useViewerStore.getState().panBy(10, -5);
    useViewerStore.getState().panBy(2, 3);
    const s = useViewerStore.getState();
    expect(s.panX).toBe(12);
    expect(s.panY).toBe(-2);
  });

  it("setMode resets zoom + pan (different layouts shouldn't inherit transform)", () => {
    useViewerStore.setState({ zoom: 2, panX: 30, panY: 40 });
    useViewerStore.getState().setMode("overlay");
    const s = useViewerStore.getState();
    expect(s.mode).toBe("overlay");
    expect(s.zoom).toBe(1);
    expect(s.panX).toBe(0);
    expect(s.panY).toBe(0);
  });

  it("zoomAt keeps the anchored point under the cursor (no-pan center)", () => {
    // Anchor at canvas center → pan should not move when zooming about
    // the center, because (anchor - center) is zero.
    useViewerStore
      .getState()
      .zoomAt(ZOOM_STEP, { x: 200, y: 100 }, { width: 400, height: 200 });
    const s = useViewerStore.getState();
    expect(s.zoom).toBe(ZOOM_STEP);
    expect(s.panX).toBe(0);
    expect(s.panY).toBe(0);
  });

  it("zoomAt off-center applies opposing pan so the anchor stays put", () => {
    // Canvas 400x200, anchor at (300, 100) — 100px right of center.
    // After zooming by 2x, the world point under (300,100) was at
    // (300 - 200) = +100 right of center; at new zoom that point would
    // move to +200 right of center, so pan must shift -100 to compensate.
    useViewerStore
      .getState()
      .zoomAt(2, { x: 300, y: 100 }, { width: 400, height: 200 });
    const s = useViewerStore.getState();
    expect(s.zoom).toBe(2);
    expect(s.panX).toBe(-100);
    expect(s.panY).toBe(0);
  });

  it("zoomAt at clamp boundary is a no-op (no spurious pan)", () => {
    useViewerStore.setState({ zoom: ZOOM_MAX, panX: 7, panY: 9 });
    useViewerStore
      .getState()
      .zoomAt(2, { x: 300, y: 100 }, { width: 400, height: 200 });
    const s = useViewerStore.getState();
    expect(s.zoom).toBe(ZOOM_MAX);
    // Pan untouched — zoomAt early-returns when the clamped zoom didn't
    // actually change, so we don't accumulate phantom pan offsets every
    // time the user keeps scrolling past max.
    expect(s.panX).toBe(7);
    expect(s.panY).toBe(9);
  });
});
