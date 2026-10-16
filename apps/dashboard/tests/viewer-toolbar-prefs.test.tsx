import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));
// The toolbar's mutations, inert: these tests read its preferences only.
vi.mock("@/lib/trpc", () => {
  const mutation = () => ({ mutate: vi.fn(), isPending: false });
  return {
    trpc: {
      useUtils: () => ({ runs: { getById: { invalidate: vi.fn() } } }),
      runs: {
        setIgnoreAreas: { useMutation: mutation },
        setTempIgnoreAreas: { useMutation: mutation },
        setDiffThresholdOverride: { useMutation: mutation },
      },
    },
  };
});

import {
  DEFAULT_VIEWER_PREFS,
  prefsKey,
  readViewerPrefs,
  useViewerPrefs,
} from "@/components/diff-viewer/viewer-prefs";
import { ViewerToolbar } from "@/components/diff-viewer/ViewerToolbar";

/**
 * A pointer event as the browser sends it. jsdom has no PointerEvent, so
 * this is a MouseEvent of the pointer type, carrying the pointer's id.
 */
function pointer(type: string, clientX: number): MouseEvent {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX });
  Object.defineProperty(e, "pointerId", { value: 1 });
  return e;
}

/** The opacity slider's track, 100px wide from x = 0. */
function opacityTrack(): HTMLElement {
  const track = screen
    .getByTestId("opacity-slider-wrap")
    .querySelector<HTMLElement>("[data-orientation]");
  if (!track) throw new Error("no opacity slider");
  track.getBoundingClientRect = () =>
    ({
      left: 0,
      width: 100,
      top: 0,
      height: 8,
      right: 100,
      bottom: 8,
    }) as DOMRect;
  return track;
}

beforeEach(() => {
  localStorage.clear();
  useViewerPrefs.setState({
    userId: null,
    prefs: DEFAULT_VIEWER_PREFS,
    previousMode: "side-by-side",
  });
  useViewerPrefs.getState().hydrate("u1");
  useViewerPrefs.getState().set("mode", "overlay");
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("ViewerToolbar's opacity slider", () => {
  test("a drag shows each value live and writes once, on release", () => {
    render(<ViewerToolbar runId="r1" checkpointId="c1" />);
    const track = opacityTrack();
    // The slider has the pointer for the whole drag.
    vi.spyOn(HTMLElement.prototype, "hasPointerCapture").mockReturnValue(true);
    const setItem = vi.spyOn(Storage.prototype, "setItem");

    act(() => void fireEvent(track, pointer("pointerdown", 30)));
    expect(useViewerPrefs.getState().prefs.opacity).toBe(0.3);
    act(() => void fireEvent(track, pointer("pointermove", 70)));
    expect(useViewerPrefs.getState().prefs.opacity).toBe(0.7);
    expect(setItem).not.toHaveBeenCalled();

    act(() => void fireEvent(track, pointer("pointerup", 70)));
    expect(setItem).toHaveBeenCalledOnce();
    expect(setItem).toHaveBeenCalledWith(prefsKey("u1"), expect.any(String));
    expect(readViewerPrefs("u1").opacity).toBe(0.7);
  });
});
