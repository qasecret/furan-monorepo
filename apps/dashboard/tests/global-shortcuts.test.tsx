import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
  within,
} from "@testing-library/react";
import { tinykeys } from "tinykeys";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const pushMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
// The viewer's bindings, as it hands them to tinykeys (which still runs).
vi.mock("tinykeys", async (importOriginal) => {
  const actual = await importOriginal<typeof import("tinykeys")>();
  return { ...actual, tinykeys: vi.fn(actual.tinykeys) };
});

import { CommandPalette } from "@/components/cmdk/command-palette";
import { usePaletteStore } from "@/components/cmdk/use-command-palette";
import {
  getClipboardRegion,
  setClipboardRegion,
} from "@/components/diff-viewer/region-clipboard";
import { useDiffViewerShortcuts } from "@/components/diff-viewer/useDiffViewerShortcuts";
import { useViewerStore } from "@/components/diff-viewer/useViewerStore";
import { GlobalShortcuts } from "@/components/triage/global-shortcuts";
import { ShortcutsDialog } from "@/components/triage/shortcuts-dialog";

afterEach(cleanup);

function fireKey(key: string) {
  document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
}

describe("GlobalShortcuts", () => {
  beforeEach(() => {
    pushMock.mockReset();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens shortcuts dialog on ?", () => {
    render(<GlobalShortcuts />);
    expect(screen.queryByText("Keyboard shortcuts")).toBeNull();
    act(() => fireKey("?"));
    expect(screen.getByText("Keyboard shortcuts")).toBeTruthy();
  });

  it("navigates to /inbox on g i sequence", () => {
    render(<GlobalShortcuts />);
    act(() => {
      fireKey("g");
      fireKey("i");
    });
    expect(pushMock).toHaveBeenCalledWith("/inbox");
  });

  it("navigates to /projects on g p sequence", () => {
    render(<GlobalShortcuts />);
    act(() => {
      fireKey("g");
      fireKey("p");
    });
    expect(pushMock).toHaveBeenCalledWith("/projects");
  });

  it("clears prefix after the sequence window", () => {
    render(<GlobalShortcuts />);
    act(() => fireKey("g"));
    act(() => {
      vi.advanceTimersByTime(1100);
    });
    act(() => fireKey("i"));
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("ignores g i typed into a form field", () => {
    render(
      <>
        <input data-testid="probe" />
        <GlobalShortcuts />
      </>,
    );
    const input = screen.getByTestId("probe");
    input.focus();
    act(() => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "g", bubbles: true }),
      );
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "i", bubbles: true }),
      );
    });
    expect(pushMock).not.toHaveBeenCalled();
  });
});

/** A key the dialog lists, and the part of it (a heading) that says where. */
interface Listed {
  where: string;
  key: string;
}

/** What the open dialog lists, read from the page as a reader sees it. */
function readDialog(): { listed: Listed[]; text: string } {
  render(<ShortcutsDialog open onOpenChange={() => undefined} />);
  const dialog = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
  const listed = within(dialog)
    .getAllByRole("region")
    .flatMap((region) => {
      // The region is named by its heading.
      const heading = document.getElementById(
        region.getAttribute("aria-labelledby") ?? "",
      );
      const where = heading?.textContent ?? "";
      return Array.from(
        region.querySelectorAll<HTMLElement>("[data-shortcut]"),
        (el) => ({ where, key: el.dataset.shortcut ?? "" }),
      );
    });
  return { listed, text: dialog.textContent ?? "" };
}

// How a listed key is pressed: one key, or a sequence ("G I"); ⌘ is Ctrl off
// a Mac (tinykeys' $mod, and jsdom is not a Mac).
const NAMED: Record<string, string> = {
  Esc: "Escape",
  "←": "ArrowLeft",
  "→": "ArrowRight",
};
function eventsFor(key: string): KeyboardEventInit[] {
  return key
    .split(" ")
    .map((k) =>
      k.length > 1 && k.startsWith("⌘")
        ? { key: k.slice(1).toLowerCase(), ctrlKey: true }
        : { key: NAMED[k] ?? (k.length === 1 ? k.toLowerCase() : k) },
    );
}

/** A place keys work in, and whether a key pressed there did anything. */
interface Probe {
  changed(): boolean;
}

/** The viewer, in a state where every one of its keys changes something. */
function inTheViewer(): Probe {
  usePaletteStore.setState({ open: false });
  sessionStorage.clear();
  setClipboardRegion("p1", {
    id: "copied",
    x: 50,
    y: 50,
    width: 5,
    height: 5,
    viewport: "1280x720",
    paddingPx: 0,
    kind: "ignore",
  });
  useViewerStore.setState({
    mode: "side-by-side",
    viewport: "1280x720",
    commentPanelOpen: false,
    highlightActive: false,
    zoom: 2,
    ignoreEditMode: "run",
    savedRunIgnoreAreas: [],
    savedVariationIgnoreAreas: [],
    markedForDeletion: new Set(),
    paddingOverrides: new Map(),
    kindOverrides: new Map(),
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
  const callbacks = {
    onApprove: vi.fn(),
    onReject: vi.fn(),
    onUndo: vi.fn(),
    onNextDiff: vi.fn(),
    onPrevDiff: vi.fn(),
    onPrevStep: vi.fn(),
    onNextStep: vi.fn(),
    onNextPending: vi.fn(),
    onPrevPending: vi.fn(),
  };
  const state = () => {
    const s = useViewerStore.getState();
    return JSON.stringify({
      mode: s.mode,
      viewport: s.viewport,
      commentPanelOpen: s.commentPanelOpen,
      highlightActive: s.highlightActive,
      zoom: s.zoom,
      ignoreEditMode: s.ignoreEditMode,
      drafts: s.draftIgnoreAreas.length,
      selectedIgnoreId: s.selectedIgnoreId,
      selectedRegionId: s.selectedRegionId,
      palette: usePaletteStore.getState().open,
      clipboard: getClipboardRegion("p1"),
    });
  };
  const before = state();
  renderHook(() =>
    useDiffViewerShortcuts({
      viewports: ["1280x720", "375x812"],
      projectId: "p1",
      ...callbacks,
    }),
  );
  return {
    changed: () =>
      Object.values(callbacks).some((cb) => cb.mock.calls.length > 0) ||
      state() !== before,
  };
}

/** Any page: the layout's global keys and the command palette. */
function everywhere(): Probe {
  usePaletteStore.setState({ open: false });
  pushMock.mockReset();
  render(
    <>
      <GlobalShortcuts />
      <CommandPalette userRole="editor" />
    </>,
  );
  return {
    changed: () =>
      pushMock.mock.calls.length > 0 ||
      usePaletteStore.getState().open ||
      screen.queryByRole("dialog", { name: "Keyboard shortcuts" }) !== null,
  };
}

const PLACES: Record<string, () => Probe> = {
  "In the diff viewer": inTheViewer,
  Everywhere: everywhere,
};

describe("ShortcutsDialog", () => {
  beforeEach(() => {
    pushMock.mockReset();
    // The palette asks for the projects when it opens.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => [] })),
    );
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    usePaletteStore.setState({ open: false });
  });

  it("ShortcutsDialog lists only bound keys (incl. J / K and ⌘Z) and none of j/k-row, a/r-row, Enter, or the old / filter row", async () => {
    const { listed, text } = readDialog();
    const keys = listed.map((l) => l.key);
    expect(keys).toEqual(expect.arrayContaining(["J", "K", "⌘Z"]));
    // The old triage list's rows, for keys nothing binds any more.
    for (const stale of [
      "Move selection",
      "Approve selected row",
      "Reject selected row",
      "Open diff viewer",
      "Focus filter bar",
    ]) {
      expect(text).not.toContain(stale);
    }
    for (const stale of ["↑", "↓", "j", "k", "a", "r"]) {
      expect(keys).not.toContain(stale);
    }
    // `/` is listed, for what it does: the old list taught it as the filter
    // bar's key, and in the viewer it opens the command palette.
    expect(listed).toContainEqual({ where: "In the diff viewer", key: "/" });
    expect(listed).not.toContainEqual({ where: "Everywhere", key: "/" });
    expect(keys.filter((k) => k.includes("Enter"))).toEqual([]);
    cleanup();

    // Every key it lists does something, where it says the key works.
    expect(new Set(listed.map((l) => l.where))).toEqual(
      new Set(Object.keys(PLACES)),
    );
    for (const { where, key } of listed) {
      const probe = PLACES[where]!();
      await act(async () => {
        for (const init of eventsFor(key)) {
          document.dispatchEvent(
            new KeyboardEvent("keydown", { bubbles: true, ...init }),
          );
        }
      });
      expect(probe.changed(), `${key} (${where})`).toBe(true);
      cleanup();
    }
  });

  it("every key the viewer binds is listed, or is another key for a listed one", () => {
    const keys = readDialog().listed.map((l) => l.key);
    cleanup();
    vi.mocked(tinykeys).mockClear();
    renderHook(() => useDiffViewerShortcuts({ viewports: [] }));
    const bound = Object.keys(vi.mocked(tinykeys).mock.calls.at(-1)![1]);
    // A second key for the same thing is not listed again.
    const SAME_AS: Record<string, string> = {
      X: "R",
      "=": "+",
      Backspace: "Delete",
      "Shift+?": "?",
      // `+` as a US keyboard sends it.
      "Shift++": "+",
    };
    const CAPS: Record<string, string> = {
      ArrowLeft: "←",
      ArrowRight: "→",
      Escape: "Esc",
    };
    const capOf = (binding: string) =>
      SAME_AS[binding] ??
      (binding.startsWith("$mod+")
        ? `⌘${binding.slice(5).toUpperCase()}`
        : (CAPS[binding] ??
          (binding.length === 1 ? binding.toUpperCase() : binding)));
    for (const binding of bound)
      expect(keys, binding).toContain(capOf(binding));
  });
});
