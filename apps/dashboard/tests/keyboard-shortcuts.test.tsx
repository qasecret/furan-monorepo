import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock next/navigation router.
const pushMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { useDiffViewerShortcuts } from "../src/components/diff-viewer/useDiffViewerShortcuts";
import { useViewerStore } from "../src/components/diff-viewer/useViewerStore";

function press(key: string) {
  window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
}

describe("useDiffViewerShortcuts", () => {
  beforeEach(() => {
    sessionStorage.clear();
    useViewerStore.setState({
      mode: "side-by-side",
      opacity: 0.5,
      selectedRegionId: null,
      viewport: "",
      ignoreEditMode: "off",
      savedRunIgnoreAreas: [],
      savedVariationIgnoreAreas: [],
      draftIgnoreAreas: [],
      markedForDeletion: new Set(),
      paddingOverrides: new Map(),
      kindOverrides: new Map(),
      selectedIgnoreId: null,
    });
    pushMock.mockReset();
  });
  afterEach(() => {
    // Unmount any mounted renderHook trees so tinykeys bindings registered
    // by `useDiffViewerShortcuts` don't accumulate across tests (otherwise
    // a single keypress would fire N handlers — leaks into the
    // $mod+V paste test that asserts a single draft).
    cleanup();
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
    expect(useViewerStore.getState().mode).toBe("difference");
  });

  it("A invokes onApprove", () => {
    const onApprove = vi.fn();
    renderHook(() => useDiffViewerShortcuts({ viewports: [], onApprove }));
    act(() => press("A"));
    expect(onApprove).toHaveBeenCalledOnce();
  });

  it("R invokes onReject", () => {
    const onReject = vi.fn();
    renderHook(() => useDiffViewerShortcuts({ viewports: [], onReject }));
    act(() => press("R"));
    expect(onReject).toHaveBeenCalledOnce();
  });

  it("X is an alias for R — also invokes onReject", () => {
    const onReject = vi.fn();
    renderHook(() => useDiffViewerShortcuts({ viewports: [], onReject }));
    act(() => press("X"));
    expect(onReject).toHaveBeenCalledOnce();
  });

  it("] cycles the viewport when viewports are set", () => {
    useViewerStore.setState({ viewport: "1280x720" });
    renderHook(() =>
      useDiffViewerShortcuts({ viewports: ["1280x720", "375x667"] }),
    );
    act(() => press("]"));
    expect(useViewerStore.getState().viewport).toBe("375x667");
  });

  it("I toggles ignoreEditMode off→run→off", () => {
    renderHook(() => useDiffViewerShortcuts({ viewports: [] }));
    act(() => press("I"));
    expect(useViewerStore.getState().ignoreEditMode).toBe("run");
    act(() => press("I"));
    expect(useViewerStore.getState().ignoreEditMode).toBe("off");
  });

  it("Delete removes the selected region when edit mode is on", () => {
    useViewerStore.setState({
      ignoreEditMode: "run",
      draftIgnoreAreas: [
        {
          id: "d1",
          x: 1,
          y: 1,
          width: 10,
          height: 10,
          viewport: "1280x720",
          paddingPx: 0,
          kind: "ignore",
        },
      ],
      selectedIgnoreId: "d1",
    });
    renderHook(() => useDiffViewerShortcuts({ viewports: [] }));
    act(() => press("Delete"));
    expect(useViewerStore.getState().draftIgnoreAreas).toEqual([]);
    expect(useViewerStore.getState().selectedIgnoreId).toBeNull();
  });

  it("Backspace also removes the selected region", () => {
    useViewerStore.setState({
      ignoreEditMode: "variation",
      draftIgnoreAreas: [
        {
          id: "d1",
          x: 1,
          y: 1,
          width: 10,
          height: 10,
          viewport: "1280x720",
          paddingPx: 0,
          kind: "ignore",
        },
      ],
      selectedIgnoreId: "d1",
    });
    renderHook(() => useDiffViewerShortcuts({ viewports: [] }));
    act(() => press("Backspace"));
    expect(useViewerStore.getState().draftIgnoreAreas).toEqual([]);
  });

  it("Escape exits ignore edit mode", () => {
    useViewerStore.setState({ ignoreEditMode: "run" });
    renderHook(() => useDiffViewerShortcuts({ viewports: [] }));
    act(() => press("Escape"));
    expect(useViewerStore.getState().ignoreEditMode).toBe("off");
  });

  it("Delete is a no-op when edit mode is off", () => {
    useViewerStore.setState({
      ignoreEditMode: "off",
      draftIgnoreAreas: [
        {
          id: "d1",
          x: 1,
          y: 1,
          width: 10,
          height: 10,
          viewport: "1280x720",
          paddingPx: 0,
          kind: "ignore",
        },
      ],
      selectedIgnoreId: "d1",
    });
    renderHook(() => useDiffViewerShortcuts({ viewports: [] }));
    act(() => press("Delete"));
    expect(useViewerStore.getState().draftIgnoreAreas).toHaveLength(1);
  });

  it("$mod+C copies selected region to clipboard when in edit mode", () => {
    const savedId = crypto.randomUUID();
    useViewerStore.setState({
      ignoreEditMode: "run",
      savedRunIgnoreAreas: [
        {
          id: savedId,
          x: 1,
          y: 2,
          width: 3,
          height: 4,
          viewport: "1280x720",
          paddingPx: 0,
          kind: "ignore",
        },
      ],
      selectedIgnoreId: savedId,
    });
    renderHook(() =>
      useDiffViewerShortcuts({
        viewports: ["1280x720"],
        projectId: "p1",
      }),
    );
    act(() =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "c", ctrlKey: true }),
      ),
    );
    expect(sessionStorage.getItem("furan:region-clipboard:p1")).not.toBeNull();
  });

  it("$mod+C is a no-op when not editing", () => {
    useViewerStore.setState({
      ignoreEditMode: "off",
      selectedIgnoreId: "some-id",
    });
    renderHook(() =>
      useDiffViewerShortcuts({
        viewports: ["1280x720"],
        projectId: "p1",
      }),
    );
    act(() =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "c", ctrlKey: true }),
      ),
    );
    expect(sessionStorage.getItem("furan:region-clipboard:p1")).toBeNull();
  });

  it("$mod+C yields when typing in an input", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    const savedId = crypto.randomUUID();
    useViewerStore.setState({
      ignoreEditMode: "run",
      savedRunIgnoreAreas: [
        {
          id: savedId,
          x: 1,
          y: 2,
          width: 3,
          height: 4,
          viewport: "1280x720",
          paddingPx: 0,
          kind: "ignore",
        },
      ],
      selectedIgnoreId: savedId,
    });
    renderHook(() =>
      useDiffViewerShortcuts({
        viewports: ["1280x720"],
        projectId: "p1",
      }),
    );
    act(() =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "c", ctrlKey: true }),
      ),
    );
    expect(sessionStorage.getItem("furan:region-clipboard:p1")).toBeNull();
    input.remove();
  });

  it("$mod+V pastes when clipboard has content and editing", () => {
    sessionStorage.setItem(
      "furan:region-clipboard:p1",
      JSON.stringify({
        _v: 1,
        copiedAt: 0,
        region: {
          x: 10,
          y: 20,
          width: 100,
          height: 50,
          viewport: "1280x720",
          paddingPx: 4,
          kind: "ignore" as const,
        },
      }),
    );
    useViewerStore.setState({
      ignoreEditMode: "run",
      draftIgnoreAreas: [],
      viewport: "1280x720",
    });
    renderHook(() =>
      useDiffViewerShortcuts({
        viewports: ["1280x720"],
        projectId: "p1",
      }),
    );
    act(() =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "v", ctrlKey: true }),
      ),
    );
    expect(useViewerStore.getState().draftIgnoreAreas).toHaveLength(1);
  });

  it("$mod+V is a no-op when clipboard is empty", () => {
    useViewerStore.setState({
      ignoreEditMode: "run",
      draftIgnoreAreas: [],
    });
    renderHook(() =>
      useDiffViewerShortcuts({
        viewports: ["1280x720"],
        projectId: "p1",
      }),
    );
    act(() =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "v", ctrlKey: true }),
      ),
    );
    expect(useViewerStore.getState().draftIgnoreAreas).toHaveLength(0);
  });
});
