import { beforeEach, describe, expect, test } from "vitest";

import { useViewState } from "../src/components/diff-viewer/view-state";
import {
  canvasToWorld,
  transformFor,
  type Size,
} from "../src/components/diff-viewer/viewer-geometry";

const view = () => useViewState.getState();

/** Everything a step leaves behind, set away from its default. */
function dirty() {
  useViewState.setState({
    zoom: 3,
    panX: 40,
    panY: -12,
    swipe: 0.2,
    flickerFrame: "current",
    flickerPlaying: false,
    selectedRegionId: "r1",
    showSuppressed: true,
    focusBbox: { x: 1, y: 2, width: 3, height: 4 },
  });
}

const DEFAULTS = {
  zoom: 1,
  panX: 0,
  panY: 0,
  swipe: 0.5,
  flickerFrame: "baseline",
  selectedRegionId: null,
  showSuppressed: false,
  focusBbox: null,
};

describe("useViewState.resetView", () => {
  beforeEach(dirty);

  test("restores every default, the flicker playing", () => {
    view().resetView({ reducedMotion: false });
    expect(view()).toMatchObject({ ...DEFAULTS, flickerPlaying: true });
  });

  test("under reduced motion the flicker is paused on the baseline", () => {
    useViewState.setState({ flickerPlaying: true });
    view().resetView({ reducedMotion: true });
    expect(view()).toMatchObject({ ...DEFAULTS, flickerPlaying: false });
  });
});

describe("useViewState setters", () => {
  beforeEach(() => view().resetView({ reducedMotion: false }));

  test("the swipe position stays within 0..1; a non-number is ignored", () => {
    view().setSwipe(0.3);
    expect(view().swipe).toBe(0.3);
    view().setSwipe(1.4);
    expect(view().swipe).toBe(1);
    view().setSwipe(-0.2);
    expect(view().swipe).toBe(0);
    view().setSwipe(Number.NaN);
    expect(view().swipe).toBe(0);
  });

  test("setFlicker sets the frame and the play state together", () => {
    view().setFlicker("current", false);
    expect(view()).toMatchObject({
      flickerFrame: "current",
      flickerPlaying: false,
    });
  });

  test("setView clamps the zoom and takes the pan as given", () => {
    view().setView({ zoom: 100, panX: 5, panY: 6 });
    expect(view()).toMatchObject({ zoom: 8, panX: 5, panY: 6 });
  });

  test("zoomAt keeps the world point under the cursor", () => {
    const world: Size = { w: 1000, h: 3000 };
    const viewport: Size = { w: 600, h: 400 };
    const cursor = { x: 420, y: 90 };
    view().setView({ zoom: 1.5, panX: 30, panY: -20 });
    const before = canvasToWorld(transformFor(world, viewport, view()), cursor);

    view().zoomAt(2, cursor, world, viewport);

    expect(view().zoom).toBe(3);
    const after = canvasToWorld(transformFor(world, viewport, view()), cursor);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });
});
