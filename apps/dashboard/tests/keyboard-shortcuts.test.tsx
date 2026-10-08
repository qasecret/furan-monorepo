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

import { usePaletteStore } from "../src/components/cmdk/use-command-palette";
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

  it("D does not change mode when typing in an input", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    useViewerStore.setState({ mode: "side-by-side" });
    renderHook(() => useDiffViewerShortcuts({ viewports: [] }));
    act(() => press("D"));
    expect(useViewerStore.getState().mode).toBe("side-by-side");
    input.remove();
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

// Regression: single-key shortcuts used to fire while the reviewer was
// typing — e.g. typing "a" into the PatternEditor regex approved the run,
// "/" opened the palette mid-regex, Backspace deleted the selected region.
// Every single-key binding must yield when another control owns the
// keyboard: a text field, a select, or focus inside a menu / listbox / dialog.
describe("useDiffViewerShortcuts — yields when another control owns the keyboard", () => {
  const SINGLE_KEYS = [
    "A",
    "R",
    "X",
    "C",
    "I",
    "?",
    "/",
    "[",
    "]",
    "Delete",
    "Backspace",
    "Escape",
    "D",
    "O",
    "H",
    "n",
    "p",
    "ArrowLeft",
    "ArrowRight",
    "=",
    "+",
    "-",
    "0",
  ];

  const callbacks = {
    onApprove: vi.fn(),
    onReject: vi.fn(),
    onHelpToggle: vi.fn(),
    onNextDiff: vi.fn(),
    onPrevDiff: vi.fn(),
    onPrevStep: vi.fn(),
    onNextStep: vi.fn(),
  };

  // A state in which every key above would visibly change something.
  function armEveryShortcut() {
    usePaletteStore.setState({ open: false });
    useViewerStore.setState({
      mode: "side-by-side",
      viewport: "1280x720",
      commentPanelOpen: false,
      highlightActive: false,
      zoom: 2,
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
      selectedRegionId: "r1",
    });
  }

  function snapshot() {
    const s = useViewerStore.getState();
    return {
      mode: s.mode,
      viewport: s.viewport,
      commentPanelOpen: s.commentPanelOpen,
      highlightActive: s.highlightActive,
      zoom: s.zoom,
      ignoreEditMode: s.ignoreEditMode,
      drafts: s.draftIgnoreAreas.length,
      selectedIgnoreId: s.selectedIgnoreId,
      selectedRegionId: s.selectedRegionId,
      paletteOpen: usePaletteStore.getState().open,
    };
  }

  function mountHook() {
    renderHook(() =>
      useDiffViewerShortcuts({
        viewports: ["1280x720", "375x812"],
        nextDiffHref: "/next",
        prevDiffHref: "/prev",
        ...callbacks,
      }),
    );
  }

  function expectNothingFired(before: ReturnType<typeof snapshot>) {
    for (const cb of Object.values(callbacks))
      expect(cb).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
    expect(snapshot()).toEqual(before);
  }

  let focused: HTMLElement | null = null;
  beforeEach(() => {
    vi.clearAllMocks();
    pushMock.mockReset();
  });
  afterEach(() => {
    // Unmount hook trees first so tinykeys bindings don't accumulate.
    cleanup();
    focused?.closest("[data-owner]")?.remove();
    focused = null;
  });

  function focusInto(html: string, selector: string) {
    const host = document.createElement("div");
    host.setAttribute("data-owner", "");
    host.innerHTML = html;
    document.body.appendChild(host);
    focused = host.querySelector<HTMLElement>(selector);
    focused!.focus();
    expect(document.activeElement).toBe(focused);
  }

  const OWNERS: Array<[string, string, string]> = [
    ["a text input", `<input type="text" />`, "input"],
    ["a search input", `<input type="search" />`, "input"],
    ["a textarea", `<textarea></textarea>`, "textarea"],
    ["a select", `<select><option>a</option></select>`, "select"],
    [
      "a contenteditable",
      `<div contenteditable="true" tabindex="0"></div>`,
      "[contenteditable]",
    ],
    [
      "an open menu",
      `<div role="menu"><div role="menuitem" tabindex="-1">Approve all</div></div>`,
      "[role=menuitem]",
    ],
    [
      "a listbox",
      `<div role="listbox"><div role="option" tabindex="-1">x</div></div>`,
      "[role=option]",
    ],
    ["a dialog", `<div role="dialog"><button>Cancel</button></div>`, "button"],
    [
      "an alertdialog",
      `<div role="alertdialog"><button>Approve all</button></div>`,
      "button",
    ],
  ];

  for (const [label, html, selector] of OWNERS) {
    it.each(SINGLE_KEYS)(`%s is ignored while focus is in ${label}`, (key) => {
      armEveryShortcut();
      mountHook();
      focusInto(html, selector);
      const before = snapshot();
      act(() => press(key));
      expectNothingFired(before);
    });
  }

  it("still fires while focus sits on a non-text input (checkbox)", () => {
    mountHook();
    focusInto(`<input type="checkbox" />`, "input");
    act(() => press("A"));
    expect(callbacks.onApprove).toHaveBeenCalledOnce();
  });

  it("still fires while focus sits on an ordinary toolbar button", () => {
    mountHook();
    focusInto(`<button>Overlay</button>`, "button");
    act(() => press("R"));
    expect(callbacks.onReject).toHaveBeenCalledOnce();
  });

  it("ignores a keydown another handler already consumed (defaultPrevented)", () => {
    mountHook();
    const ev = new KeyboardEvent("keydown", {
      key: "A",
      bubbles: true,
      cancelable: true,
    });
    ev.preventDefault();
    act(() => {
      window.dispatchEvent(ev);
    });
    expect(callbacks.onApprove).not.toHaveBeenCalled();
  });

  it("ignores auto-repeat so holding A/R cannot fire approve/reject twice", () => {
    mountHook();
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "A", bubbles: true, repeat: true }),
      );
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "R", bubbles: true, repeat: true }),
      );
    });
    expect(callbacks.onApprove).not.toHaveBeenCalled();
    expect(callbacks.onReject).not.toHaveBeenCalled();
  });
});
