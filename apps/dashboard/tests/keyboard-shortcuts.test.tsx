import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock next/navigation router.
const pushMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

import { useDiffViewerShortcuts } from "../src/components/diff-viewer/useDiffViewerShortcuts";
import { useViewerStore } from "../src/components/diff-viewer/useViewerStore";

function press(key: string) {
  window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
}

describe("useDiffViewerShortcuts", () => {
  beforeEach(() => {
    useViewerStore.setState({
      mode: "side-by-side",
      opacity: 0.5,
      selectedRegionId: null,
      viewport: "",
    });
    pushMock.mockReset();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("ArrowRight pushes the next-diff href if provided", () => {
    renderHook(() =>
      useDiffViewerShortcuts({ viewports: [], nextDiffHref: "/next" }),
    );
    act(() => press("ArrowRight"));
    expect(pushMock).toHaveBeenCalledWith("/next");
  });

  it("O cycles the mode", () => {
    renderHook(() => useDiffViewerShortcuts({ viewports: [] }));
    act(() => press("O"));
    expect(useViewerStore.getState().mode).toBe("overlay");
    act(() => press("O"));
    expect(useViewerStore.getState().mode).toBe("onion-skin");
  });

  it("A invokes onApprove", () => {
    const onApprove = vi.fn();
    renderHook(() => useDiffViewerShortcuts({ viewports: [], onApprove }));
    act(() => press("A"));
    expect(onApprove).toHaveBeenCalledOnce();
  });

  it("] cycles the viewport when viewports are set", () => {
    useViewerStore.setState({ viewport: "1280x720" });
    renderHook(() =>
      useDiffViewerShortcuts({ viewports: ["1280x720", "375x667"] }),
    );
    act(() => press("]"));
    expect(useViewerStore.getState().viewport).toBe("375x667");
  });
});
