import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { pushMock, undoMock } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  undoMock: vi.fn(),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));
// The global ⌘Z: the review session's undo, watched.
vi.mock("@/lib/review/use-review-mutations", () => ({
  useReviewMutations: () => ({ undo: undoMock }),
}));

import { createBackend, TrpcBackend } from "./trpc-backend";

import { CurrentProjectProvider } from "@/app/(protected)/_components/current-project-provider";
import { CommandPalette } from "@/components/cmdk/command-palette";
import { usePaletteStore } from "@/components/cmdk/use-command-palette";
import { BatchDoneCard } from "@/components/diff-viewer/BatchDoneCard";
import {
  getClipboardRegion,
  setClipboardRegion,
} from "@/components/diff-viewer/region-clipboard";
import {
  useDiffViewerShortcuts,
  type ShortcutOptions,
} from "@/components/diff-viewer/useDiffViewerShortcuts";
import {
  useViewerStore,
  ZOOM_STEP,
} from "@/components/diff-viewer/useViewerStore";
import { useShortcutsSheet } from "@/components/shortcuts/use-shortcuts-sheet";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { CommandDispatcher } from "@/lib/commands/dispatcher";
import { GlobalCommands } from "@/lib/commands/global-commands";
import { bindingKey, keyIdentity } from "@/lib/commands/keys";
import { useSingleKeyStore } from "@/lib/commands/prefs";
import {
  CommandRoleProvider,
  resolveCommands,
  resolveKeyMap,
  useCommandKeys,
  useCommandRegistry,
} from "@/lib/commands/registry";
import { useUndoStore } from "@/lib/review/use-undo-store";
import type { ViewerRole } from "@/lib/roles";

/**
 * The protected layout's keyboard: the role, the global commands (⌘Z, `?`,
 * `/`, `g i`) and the one dispatcher. The viewer's keys reach it only through
 * the registry.
 */
function Keyboard({
  role = "editor",
  children,
}: {
  role?: ViewerRole;
  children?: ReactNode;
}) {
  return (
    <CommandRoleProvider role={role}>
      <GlobalCommands />
      <CommandDispatcher />
      {children}
    </CommandRoleProvider>
  );
}

/** The viewer's hook on a page of the protected layout. */
function mountViewer(opts: ShortcutOptions, role: ViewerRole = "editor") {
  return renderHook((props: ShortcutOptions) => useDiffViewerShortcuts(props), {
    initialProps: opts,
    wrapper: ({ children }) => <Keyboard role={role}>{children}</Keyboard>,
  });
}

/** A keydown on the window, as the viewer's old tests sent it. */
function press(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const e = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  act(() => {
    window.dispatchEvent(e);
  });
  return e;
}

/** A keydown on the focused element, as the browser sends it. */
function pressOnFocus(key: string, init: KeyboardEventInit = {}) {
  const e = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  act(() => {
    (document.activeElement ?? document.body).dispatchEvent(e);
  });
  return e;
}

const DRAFT = {
  id: "d1",
  x: 1,
  y: 1,
  width: 10,
  height: 10,
  viewport: "1280x720",
  paddingPx: 0,
  kind: "ignore" as const,
};

/** ⌘Z takes back this session's newest review action: there is one. */
function haveSomethingToUndo() {
  useUndoStore.setState({
    stack: [{ actionId: "a1", label: "Approved home", runIds: ["r1"] }],
  });
}

function resetStores() {
  sessionStorage.clear();
  useUndoStore.setState({ stack: [] });
  useCommandRegistry.setState({ entries: [], role: "guest" });
  useSingleKeyStore.setState({ on: true });
  usePaletteStore.setState({ open: false });
  useShortcutsSheet.setState({ open: false });
  useViewerStore.setState({
    mode: "side-by-side",
    opacity: 0.5,
    selectedRegionId: null,
    viewport: "",
    zoom: 1,
    commentPanelOpen: false,
    highlightActive: false,
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
  undoMock.mockReset();
}

beforeEach(resetStores);
afterEach(() => {
  // Unmount every tree, so no registrant or listener outlives its test.
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("useDiffViewerShortcuts", () => {
  it("ArrowLeft / ArrowRight move between the run's own steps", () => {
    const onPrevStep = vi.fn();
    const onNextStep = vi.fn();
    mountViewer({ viewports: [], onPrevStep, onNextStep });
    press("ArrowRight");
    expect(onNextStep).toHaveBeenCalledOnce();
    press("ArrowLeft");
    expect(onPrevStep).toHaveBeenCalledOnce();
  });

  it("ArrowLeft / ArrowRight with no step that way are the browser's", () => {
    // At the ends of the run, or while the done card is up, the viewer hands
    // no step callback: the arrows scroll as usual.
    const onNextDiff = vi.fn();
    mountViewer({ viewports: [], onNextDiff });
    expect(press("ArrowLeft").defaultPrevented).toBe(false);
    expect(press("ArrowRight").defaultPrevented).toBe(false);
    expect(onNextDiff).not.toHaveBeenCalled();
  });

  it("J / K invoke onNextPending / onPrevPending, either case", () => {
    const onNextPending = vi.fn();
    const onPrevPending = vi.fn();
    mountViewer({ viewports: [], onNextPending, onPrevPending });
    press("j");
    press("J");
    expect(onNextPending).toHaveBeenCalledTimes(2);
    press("k");
    press("K");
    expect(onPrevPending).toHaveBeenCalledTimes(2);
  });

  it("J / K do nothing without the loop", () => {
    const others = {
      onApprove: vi.fn(),
      onReject: vi.fn(),
      onNextStep: vi.fn(),
      onPrevStep: vi.fn(),
      onNextDiff: vi.fn(),
      onPrevDiff: vi.fn(),
    };
    mountViewer({ viewports: [], ...others });
    const before = useViewerStore.getState();
    // Disabled: left to the browser.
    expect(press("J").defaultPrevented).toBe(false);
    expect(press("K").defaultPrevented).toBe(false);
    // Neither falls through to another binding, nor touches the viewer.
    for (const cb of Object.values(others)) expect(cb).not.toHaveBeenCalled();
    expect(useViewerStore.getState()).toEqual(before);
    // The bindings are live: the same press of another key does fire.
    press("A");
    expect(others.onApprove).toHaveBeenCalledOnce();
  });

  it("Escape goes to onEscape instead of the viewer's own, when it is given", () => {
    useViewerStore.setState({ ignoreEditMode: "run", selectedRegionId: "r1" });
    const onEscape = vi.fn();
    const { rerender } = mountViewer({ viewports: [], onEscape });
    press("Escape");
    expect(onEscape).toHaveBeenCalledOnce();
    // The viewer's own Esc did not run.
    expect(useViewerStore.getState().ignoreEditMode).toBe("run");
    expect(useViewerStore.getState().selectedRegionId).toBe("r1");
    // Without it, Esc is the viewer's again.
    rerender({ viewports: [] });
    press("Escape");
    expect(onEscape).toHaveBeenCalledOnce();
    expect(useViewerStore.getState().ignoreEditMode).toBe("off");
    expect(useViewerStore.getState().selectedRegionId).toBeNull();
    // With nothing to leave or clear, Esc is the browser's.
    expect(press("Escape").defaultPrevented).toBe(false);
  });

  it("held Esc leaves once", () => {
    const onEscape = vi.fn();
    mountViewer({ viewports: [], onEscape });
    for (const repeat of [false, true, true, true]) press("Escape", { repeat });
    // The auto-repeats of a held key are not more presses.
    expect(onEscape).toHaveBeenCalledOnce();
  });

  it("+ zooms in as a US keyboard sends it (Shift with =), once", () => {
    mountViewer({ viewports: [] });
    press("+", { shiftKey: true });
    expect(useViewerStore.getState().zoom).toBeCloseTo(ZOOM_STEP);
  });

  it("O cycles the mode", () => {
    mountViewer({ viewports: [] });
    press("O");
    expect(useViewerStore.getState().mode).toBe("overlay");
    press("O");
    expect(useViewerStore.getState().mode).toBe("difference");
  });

  it("A invokes onApprove", () => {
    const onApprove = vi.fn();
    mountViewer({ viewports: [], onApprove });
    press("A");
    expect(onApprove).toHaveBeenCalledOnce();
  });

  it("R invokes onReject", () => {
    const onReject = vi.fn();
    mountViewer({ viewports: [], onReject });
    press("R");
    expect(onReject).toHaveBeenCalledOnce();
  });

  it("X is an alias for R — also invokes onReject", () => {
    const onReject = vi.fn();
    mountViewer({ viewports: [], onReject });
    press("X");
    expect(onReject).toHaveBeenCalledOnce();
  });

  it("] cycles the viewport when viewports are set", () => {
    useViewerStore.setState({ viewport: "1280x720" });
    mountViewer({ viewports: ["1280x720", "375x667"] });
    press("]");
    expect(useViewerStore.getState().viewport).toBe("375x667");
  });

  it("I toggles ignoreEditMode off→run→off", () => {
    mountViewer({ viewports: [] });
    press("I");
    expect(useViewerStore.getState().ignoreEditMode).toBe("run");
    press("I");
    expect(useViewerStore.getState().ignoreEditMode).toBe("off");
  });

  it("Delete removes the selected region when edit mode is on", () => {
    useViewerStore.setState({
      ignoreEditMode: "run",
      draftIgnoreAreas: [DRAFT],
      selectedIgnoreId: "d1",
    });
    mountViewer({ viewports: [] });
    press("Delete");
    expect(useViewerStore.getState().draftIgnoreAreas).toEqual([]);
    expect(useViewerStore.getState().selectedIgnoreId).toBeNull();
  });

  it("Backspace also removes the selected region", () => {
    useViewerStore.setState({
      ignoreEditMode: "variation",
      draftIgnoreAreas: [DRAFT],
      selectedIgnoreId: "d1",
    });
    mountViewer({ viewports: [] });
    press("Backspace");
    expect(useViewerStore.getState().draftIgnoreAreas).toEqual([]);
  });

  it("Escape exits ignore edit mode", () => {
    useViewerStore.setState({ ignoreEditMode: "run" });
    mountViewer({ viewports: [] });
    press("Escape");
    expect(useViewerStore.getState().ignoreEditMode).toBe("off");
  });

  it("Delete is a no-op when edit mode is off", () => {
    useViewerStore.setState({
      ignoreEditMode: "off",
      draftIgnoreAreas: [DRAFT],
      selectedIgnoreId: "d1",
    });
    mountViewer({ viewports: [] });
    // Disabled: the browser's own Delete / Backspace.
    expect(press("Delete").defaultPrevented).toBe(false);
    expect(press("Backspace").defaultPrevented).toBe(false);
    expect(useViewerStore.getState().draftIgnoreAreas).toHaveLength(1);
  });

  it("Delete and Backspace with no region selected are the browser's", () => {
    useViewerStore.setState({
      ignoreEditMode: "run",
      draftIgnoreAreas: [DRAFT],
      selectedIgnoreId: null,
    });
    mountViewer({ viewports: [] });
    expect(press("Delete").defaultPrevented).toBe(false);
    expect(press("Backspace").defaultPrevented).toBe(false);
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
    mountViewer({ viewports: ["1280x720"], projectId: "p1" });
    const e = press("c", { ctrlKey: true });
    expect(sessionStorage.getItem("furan:region-clipboard:p1")).not.toBeNull();
    expect(e.defaultPrevented).toBe(true);
  });

  it("$mod+C is a no-op when not editing", () => {
    useViewerStore.setState({
      ignoreEditMode: "off",
      selectedIgnoreId: "some-id",
    });
    mountViewer({ viewports: ["1280x720"], projectId: "p1" });
    press("c", { ctrlKey: true });
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
    mountViewer({ viewports: ["1280x720"], projectId: "p1" });
    press("c", { ctrlKey: true });
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
    mountViewer({ viewports: ["1280x720"], projectId: "p1" });
    const e = press("v", { ctrlKey: true });
    expect(useViewerStore.getState().draftIgnoreAreas).toHaveLength(1);
    expect(e.defaultPrevented).toBe(true);
  });

  it("D does not change mode when typing in an input", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    useViewerStore.setState({ mode: "side-by-side" });
    mountViewer({ viewports: [] });
    press("D");
    expect(useViewerStore.getState().mode).toBe("side-by-side");
    input.remove();
  });

  it("$mod+V is a no-op when clipboard is empty", () => {
    useViewerStore.setState({
      ignoreEditMode: "run",
      draftIgnoreAreas: [],
    });
    mountViewer({ viewports: ["1280x720"], projectId: "p1" });
    // The browser's own paste.
    expect(press("v", { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(useViewerStore.getState().draftIgnoreAreas).toHaveLength(0);
  });

  // ⌘Z is the global `review.undo` now (Task 3): on the viewer's page it is
  // the same undo, through the one dispatcher.
  it("Ctrl+Z invokes the review undo and prevents the browser default", () => {
    haveSomethingToUndo();
    mountViewer({ viewports: [] });
    const ev = press("z", { ctrlKey: true });
    expect(undoMock).toHaveBeenCalledOnce();
    // The newest action: no id.
    expect(undoMock).toHaveBeenCalledWith();
    expect(ev.defaultPrevented).toBe(true);
  });

  it("Ctrl+Shift+Z (redo) does not invoke the review undo", () => {
    mountViewer({ viewports: [] });
    press("Z", { ctrlKey: true, shiftKey: true });
    expect(undoMock).not.toHaveBeenCalled();
  });

  it("Ctrl+Z ignores auto-repeat and leaves the event alone", () => {
    mountViewer({ viewports: [] });
    const ev = press("z", { ctrlKey: true, repeat: true });
    expect(undoMock).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);
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
    "J",
    "K",
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
    onNextDiff: vi.fn(),
    onPrevDiff: vi.fn(),
    onPrevStep: vi.fn(),
    onNextStep: vi.fn(),
    onNextPending: vi.fn(),
    onPrevPending: vi.fn(),
  };

  // A state in which every key above would visibly change something.
  function armEveryShortcut() {
    haveSomethingToUndo();
    usePaletteStore.setState({ open: false });
    useShortcutsSheet.setState({ open: false });
    useViewerStore.setState({
      mode: "side-by-side",
      viewport: "1280x720",
      commentPanelOpen: false,
      highlightActive: false,
      zoom: 2,
      ignoreEditMode: "run",
      draftIgnoreAreas: [DRAFT],
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
      sheetOpen: useShortcutsSheet.getState().open,
    };
  }

  function mountHook() {
    mountViewer({ viewports: ["1280x720", "375x812"], ...callbacks });
  }

  function expectNothingFired(before: ReturnType<typeof snapshot>) {
    for (const cb of Object.values(callbacks))
      expect(cb).not.toHaveBeenCalled();
    expect(undoMock).not.toHaveBeenCalled();
    expect(snapshot()).toEqual(before);
  }

  let focused: HTMLElement | null = null;
  beforeEach(() => {
    for (const cb of Object.values(callbacks)) cb.mockClear();
  });
  afterEach(() => {
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
      press(key);
      expectNothingFired(before);
    });
  }

  // Ctrl+Z (⌘Z) carries a modifier, so the single-key table above never sends
  // it: each owner gets its own check, through the same guard.
  const pressCtrlZ = () => press("z", { ctrlKey: true });

  for (const [label, html, selector] of OWNERS) {
    it(`Ctrl+Z is ignored while focus is in ${label}`, () => {
      armEveryShortcut();
      mountHook();
      focusInto(html, selector);
      const before = snapshot();
      pressCtrlZ();
      expectNothingFired(before);
    });
  }

  // The review loop's done card (BatchDoneCard) is a dialog that owns the
  // keys while focus is in it, all but ⌘Z (undoing the decision that brought
  // it up brings the step back, R20) and Esc (back to the batch).
  const DONE_CARD = `<div role="dialog" data-done-card="" data-passes-undo=""><button>Continue</button></div>`;

  it.each(SINGLE_KEYS.filter((key) => key !== "Escape"))(
    "%s is ignored while focus is in the done card",
    (key) => {
      armEveryShortcut();
      mountHook();
      focusInto(DONE_CARD, "button");
      const before = snapshot();
      press(key);
      expectNothingFired(before);
    },
  );

  it("Ctrl+Z still undoes while focus is in the done card", () => {
    armEveryShortcut();
    mountHook();
    focusInto(DONE_CARD, "button");
    pressCtrlZ();
    expect(undoMock).toHaveBeenCalledOnce();
  });

  it("Ctrl+Z stays with a menu opened inside a dialog that lets it through", () => {
    mountHook();
    focusInto(
      `<div role="dialog" data-passes-undo=""><div role="menu"><div role="menuitem" tabindex="-1">x</div></div></div>`,
      "[role=menuitem]",
    );
    pressCtrlZ();
    expect(undoMock).not.toHaveBeenCalled();
  });

  it("still fires Ctrl+Z while focus sits on an ordinary toolbar button", () => {
    haveSomethingToUndo();
    mountHook();
    focusInto(`<button>Overlay</button>`, "button");
    pressCtrlZ();
    expect(undoMock).toHaveBeenCalledOnce();
  });

  it("still fires while focus sits on a non-text input (checkbox)", () => {
    mountHook();
    focusInto(`<input type="checkbox" />`, "input");
    press("A");
    expect(callbacks.onApprove).toHaveBeenCalledOnce();
  });

  it("still fires while focus sits on an ordinary toolbar button", () => {
    mountHook();
    focusInto(`<button>Overlay</button>`, "button");
    press("R");
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
    press("A", { repeat: true });
    press("R", { repeat: true });
    expect(callbacks.onApprove).not.toHaveBeenCalled();
    expect(callbacks.onReject).not.toHaveBeenCalled();
  });

  it("ignores auto-repeat so holding J/K cannot walk the queue", () => {
    mountHook();
    press("J", { repeat: true });
    press("K", { repeat: true });
    expect(callbacks.onNextPending).not.toHaveBeenCalled();
    expect(callbacks.onPrevPending).not.toHaveBeenCalled();
  });
});

describe("the viewer's keys are registry commands", () => {
  /** Every callback the viewer hands its keys, watched. */
  function spies() {
    return {
      onApprove: vi.fn(),
      onReject: vi.fn(),
      onNextDiff: vi.fn(),
      onPrevDiff: vi.fn(),
      onPrevStep: vi.fn(),
      onNextStep: vi.fn(),
      onNextPending: vi.fn(),
      onPrevPending: vi.fn(),
    };
  }
  type Spies = ReturnType<typeof spies> & {
    onEscape: ReturnType<typeof vi.fn>;
  };
  type Called = keyof Spies | "undo";

  const COPIED = {
    id: "copied",
    x: 50,
    y: 50,
    width: 5,
    height: 5,
    viewport: "1280x720",
    paddingPx: 0,
    kind: "ignore" as const,
  };

  /** Every key's effect is visible from here: the editor on, d1 selected. */
  function arm() {
    haveSomethingToUndo();
    setClipboardRegion("p1", COPIED);
    useViewerStore.setState({
      mode: "side-by-side",
      viewport: "b",
      commentPanelOpen: false,
      highlightActive: false,
      zoom: 2,
      ignoreEditMode: "run",
      draftIgnoreAreas: [DRAFT],
      selectedIgnoreId: "d1",
      selectedRegionId: "r1",
    });
  }

  function state() {
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
      palette: usePaletteStore.getState().open,
      sheet: useShortcutsSheet.getState().open,
      clipboard: JSON.stringify(getClipboardRegion("p1")),
      pushed: pushMock.mock.calls.length,
    };
  }
  type State = ReturnType<typeof state>;

  interface Row {
    /** The key as the old sheet (spec §4.4) lists it. */
    key: string;
    /** The binding that holds it, as the registry writes it. */
    binding: string;
    id: string;
    /** The keydown the browser sends for it. */
    event: [key: string, init?: KeyboardEventInit];
    /** The viewer hands it an `onEscape` (the done card is up). */
    escape?: boolean;
    called?: Called[];
    changed?: Partial<State>;
  }

  const copiedDraft = JSON.stringify({
    x: 1,
    y: 1,
    width: 10,
    height: 10,
    viewport: "1280x720",
    paddingPx: 0,
    kind: "ignore",
  });

  const row = (
    key: string,
    binding: string,
    id: string,
    effect: Pick<Row, "called" | "changed" | "escape">,
    event: Row["event"] = [binding],
  ): Row => ({ key, binding, id, event, ...effect });

  // One row per key of spec §4.4, with what it did before the move: the
  // same callback, or the same store change, and nothing else. ⌘Z, `?` and
  // `/` were the viewer's too; on its page they now are the global ones.
  const ROWS: Row[] = [
    row("←", "ArrowLeft", "viewer.prevStep", { called: ["onPrevStep"] }),
    row("→", "ArrowRight", "viewer.nextStep", { called: ["onNextStep"] }),
    row("J", "j", "viewer.nextPending", { called: ["onNextPending"] }),
    row("K", "k", "viewer.prevPending", { called: ["onPrevPending"] }),
    row("N", "n", "viewer.nextRegion", { called: ["onNextDiff"] }),
    row("P", "p", "viewer.prevRegion", { called: ["onPrevDiff"] }),
    row("[", "[", "viewer.prevViewport", { changed: { viewport: "a" } }),
    row("]", "]", "viewer.nextViewport", { changed: { viewport: "c" } }),
    row("A", "a", "review.approve", { called: ["onApprove"] }),
    row("R", "r", "review.reject", { called: ["onReject"] }),
    row("X", "x", "review.reject", { called: ["onReject"] }),
    // A mode change also resets the zoom (the store's own rule).
    row("D", "d", "viewer.difference", {
      changed: { mode: "difference", zoom: 1 },
    }),
    row("O", "o", "viewer.cycleMode", {
      changed: { mode: "overlay", zoom: 1 },
    }),
    row("H", "h", "viewer.highlight", { changed: { highlightActive: true } }),
    row("C", "c", "viewer.comments", { changed: { commentPanelOpen: true } }),
    row("=", "=", "viewer.zoomIn", { changed: { zoom: 2 * ZOOM_STEP } }),
    row("+", "+", "viewer.zoomIn", { changed: { zoom: 2 * ZOOM_STEP } }),
    // `+` as a US keyboard sends it: the dispatcher's Shift twin (R11).
    row("⇧+", "+", "viewer.zoomIn", { changed: { zoom: 2 * ZOOM_STEP } }, [
      "+",
      { shiftKey: true },
    ]),
    row("-", "-", "viewer.zoomOut", { changed: { zoom: 2 / ZOOM_STEP } }),
    row("0", "0", "viewer.fit", { changed: { zoom: 1 } }),
    row("I", "i", "editor.toggle", { changed: { ignoreEditMode: "off" } }),
    row("Delete", "Delete", "editor.delete", {
      changed: { drafts: 0, selectedIgnoreId: null },
    }),
    row("Backspace", "Backspace", "editor.delete", {
      changed: { drafts: 0, selectedIgnoreId: null },
    }),
    // jsdom is not a Mac: $mod is Ctrl.
    row(
      "⌘C",
      "$mod+c",
      "editor.copy",
      { changed: { clipboard: copiedDraft } },
      ["c", { ctrlKey: true }],
    ),
    row("⌘V", "$mod+v", "editor.paste", { changed: { drafts: 2 } }, [
      "v",
      { ctrlKey: true },
    ]),
    row("Esc", "Escape", "viewer.escape", {
      changed: { ignoreEditMode: "off", selectedRegionId: null },
    }),
    row("Esc (on a done card)", "Escape", "viewer.escape", {
      escape: true,
      called: ["onEscape"],
    }),
    row("⌘Z", "$mod+z", "review.undo", { called: ["undo"] }, [
      "z",
      { ctrlKey: true },
    ]),
    row("?", "?", "help.shortcuts", { changed: { sheet: true } }, [
      "?",
      { shiftKey: true },
    ]),
    row("/", "/", "search.focus", { changed: { palette: true } }),
  ];

  it.each(ROWS)(
    "every key the old sheet listed does the same thing: $key ($id)",
    ({ binding, id, event, escape, called = [], changed = {} }) => {
      arm();
      const watched: Spies = { ...spies(), onEscape: vi.fn() };
      const { onEscape, ...always } = watched;
      mountViewer({
        viewports: ["a", "b", "c"],
        projectId: "p1",
        ...always,
        ...(escape ? { onEscape } : {}),
      });
      // The key is the command's, in the place the sheet says.
      const held = resolveKeyMap(resolveCommands()).get(keyIdentity(binding));
      expect(held?.command.id).toBe(id);

      const before = state();
      const e = press(...event);
      expect(e.defaultPrevented).toBe(true);
      expect(state()).toEqual({ ...before, ...changed });
      for (const [name, spy] of Object.entries(watched)) {
        expect(spy, name).toHaveBeenCalledTimes(
          called.includes(name as Called) ? 1 : 0,
        );
      }
      expect(undoMock).toHaveBeenCalledTimes(called.includes("undo") ? 1 : 0);
    },
  );

  it("registers spec §4.4's commands with their labels and keys", () => {
    mountViewer({ viewports: [] }, "owner");
    const viewer = resolveCommands().filter((c) => c.scope === "viewer");
    expect(
      viewer.map(({ command }) => [
        command.id,
        command.label,
        (command.keys ?? []).map(bindingKey),
      ]),
    ).toEqual([
      ["viewer.prevStep", "Previous step", ["ArrowLeft"]],
      ["viewer.nextStep", "Next step", ["ArrowRight"]],
      ["viewer.nextPending", "Next pending step", ["j"]],
      ["viewer.prevPending", "Previous pending step", ["k"]],
      ["viewer.nextRegion", "Next change", ["n"]],
      ["viewer.prevRegion", "Previous change", ["p"]],
      ["viewer.prevViewport", "Previous viewport", ["["]],
      ["viewer.nextViewport", "Next viewport", ["]"]],
      ["review.approve", "Approve step", ["a"]],
      ["review.reject", "Reject step", ["r", "x"]],
      ["viewer.difference", "Toggle difference view", ["d"]],
      ["viewer.cycleMode", "Cycle view mode", ["o"]],
      ["viewer.highlight", "Toggle highlight", ["h"]],
      ["viewer.comments", "Toggle comments", ["c"]],
      ["viewer.zoomIn", "Zoom in", ["=", "+"]],
      ["viewer.zoomOut", "Zoom out", ["-"]],
      ["viewer.fit", "Fit", ["0"]],
      ["editor.toggle", "Edit ignore regions", ["i"]],
      ["editor.delete", "Delete selected region", ["Delete", "Backspace"]],
      ["editor.copy", "Copy region", ["$mod+c"]],
      ["editor.paste", "Paste region", ["$mod+v"]],
      [
        "viewer.escape",
        "Leave editor / clear selection / back to batch (on a done card)",
        ["Escape"],
      ],
    ]);
    // The hint bar's commands (spec §4.4), and no other.
    expect(
      resolveCommands()
        .filter(({ command }) => command.primary)
        .map(({ command }) => command.id)
        .sort(),
    ).toEqual(
      [
        "review.approve",
        "review.reject",
        "review.undo",
        "viewer.nextPending",
        "viewer.nextStep",
        "viewer.prevPending",
        "viewer.prevStep",
      ].sort(),
    );
    // The viewer binds none of the global keys: they stay global.
    const keys = viewer.flatMap(({ command }) =>
      (command.keys ?? []).map(bindingKey),
    );
    for (const global of ["?", "/", "$mod+z", "$mod+k"]) {
      expect(keys).not.toContain(global);
    }
  });

  it("a guest gets no A / R binding and no hint", () => {
    const watched = spies();
    function Viewer({ opts }: { opts: ShortcutOptions }) {
      useDiffViewerShortcuts(opts);
      return null;
    }
    // What a button that runs them would say (`useCommandKeys`).
    const hints = () => ({
      approve: useCommandKeys("review.approve"),
      reject: useCommandKeys("review.reject"),
    });
    const guest = render(
      <Keyboard role="guest">
        <Viewer opts={{ viewports: [], ...watched }} />
      </Keyboard>,
    );
    const { result } = renderHook(hints);
    expect(result.current.approve).toEqual({ keys: [], titleSuffix: "" });
    expect(result.current.reject).toEqual({ keys: [], titleSuffix: "" });
    const ids = resolveCommands().map(({ command }) => command.id);
    expect(ids).not.toContain("review.approve");
    expect(ids).not.toContain("review.reject");
    // Navigation is anyone's.
    expect(ids).toContain("viewer.nextPending");
    for (const key of ["a", "r", "x", "A", "R", "X"]) {
      expect(press(key).defaultPrevented, key).toBe(false);
    }
    expect(watched.onApprove).not.toHaveBeenCalled();
    expect(watched.onReject).not.toHaveBeenCalled();
    guest.unmount();

    // Every role that reviews has both, with their hints.
    for (const role of ["editor", "admin", "owner"] as const) {
      const tree = render(
        <Keyboard role={role}>
          <Viewer opts={{ viewports: [], ...watched }} />
        </Keyboard>,
      );
      const { result: shown } = renderHook(hints);
      expect(shown.current.approve.ariaKeyShortcuts, role).toBe("A");
      expect(shown.current.reject.ariaKeyShortcuts, role).toBe("R X");
      press("a");
      press("x");
      tree.unmount();
    }
    expect(watched.onApprove).toHaveBeenCalledTimes(3);
    expect(watched.onReject).toHaveBeenCalledTimes(3);
  });

  it("Esc in the Approve-pending dialog does not run viewer.escape; Esc in the done card does", () => {
    const onEscape = vi.fn();
    const onLeave = vi.fn();
    function Page({
      dialog,
    }: {
      dialog: "approve-pending" | "done-card" | "none";
    }) {
      useDiffViewerShortcuts({ viewports: [], onEscape });
      if (dialog === "none") return null;
      return dialog === "approve-pending" ? (
        <AlertDialog open>
          <AlertDialogContent>
            <AlertDialogTitle>Approve pending steps?</AlertDialogTitle>
            <AlertDialogDescription>3 steps in 2 tests.</AlertDialogDescription>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
          </AlertDialogContent>
        </AlertDialog>
      ) : (
        <BatchDoneCard
          variant="batch"
          nextBatch={null}
          batchUnfiltered={0}
          onContinue={vi.fn()}
          onClearFilter={vi.fn()}
          onLeave={onLeave}
          backHref="/back"
          batchesHref="/inbox"
        />
      );
    }

    // The question before approving every pending step: Esc is its own
    // (Cancel), never the viewer's way back to the batch.
    render(
      <Keyboard>
        <Page dialog="approve-pending" />
      </Keyboard>,
    );
    const cancel = screen.getByRole("button", { name: "Cancel" });
    act(() => cancel.focus());
    pressOnFocus("Escape");
    press("Escape");
    expect(onEscape).not.toHaveBeenCalled();
    cleanup();

    // Nor in another dialog that lets ⌘Z through: the done card is the one.
    render(
      <Keyboard>
        <Page dialog="none" />
      </Keyboard>,
    );
    const host = document.createElement("div");
    host.innerHTML = `<div role="dialog" data-passes-undo=""><button>Keep</button></div>`;
    document.body.appendChild(host);
    const keep = host.querySelector("button")!;
    act(() => keep.focus());
    expect(document.activeElement).toBe(keep);
    press("Escape");
    expect(onEscape).not.toHaveBeenCalled();
    cleanup();

    // The done card is the one dialog `viewer.escape` fires in.
    render(
      <Keyboard>
        <Page dialog="done-card" />
      </Keyboard>,
    );
    const card = screen.getByRole("dialog", { name: "Batch done" });
    expect(card.matches("[data-done-card]")).toBe(true);
    expect(card.contains(document.activeElement)).toBe(true);
    // From the card's own focus, past its own handler: the viewer's Esc.
    const e = press("Escape");
    expect(onEscape).toHaveBeenCalledOnce();
    expect(e.defaultPrevented).toBe(true);
    // Pressed where the browser sends it, the card's own handler takes it
    // first: the batch is left once, not twice.
    pressOnFocus("Escape");
    expect(onLeave).toHaveBeenCalledOnce();
    expect(onEscape).toHaveBeenCalledOnce();
  });

  it("⌘C copies text normally outside the region editor", () => {
    setClipboardRegion("p1", COPIED);
    const before = JSON.stringify(getClipboardRegion("p1"));
    useViewerStore.setState({
      ignoreEditMode: "off",
      draftIgnoreAreas: [DRAFT],
      selectedIgnoreId: "d1",
    });
    mountViewer({ viewports: ["1280x720"], projectId: "p1" });

    // Outside the editor: the browser's copy and paste.
    expect(press("c", { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(press("v", { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(JSON.stringify(getClipboardRegion("p1"))).toBe(before);
    expect(useViewerStore.getState().draftIgnoreAreas).toHaveLength(1);

    // In the editor with text selected on the page: still the browser's.
    act(() => useViewerStore.setState({ ignoreEditMode: "run" }));
    const text = document.createElement("p");
    text.textContent = "Checkout total";
    document.body.appendChild(text);
    const range = document.createRange();
    range.selectNodeContents(text);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    expect(press("c", { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(JSON.stringify(getClipboardRegion("p1"))).toBe(before);

    // With nothing selected, it copies the region.
    window.getSelection()!.removeAllRanges();
    expect(press("c", { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(getClipboardRegion("p1")).toEqual(
      expect.objectContaining({ x: 1, y: 1, width: 10, height: 10 }),
    );
  });

  it("zoom repeats, A does not", () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    useViewerStore.setState({ zoom: 1 });
    mountViewer({ viewports: [], onApprove, onReject });

    press("=");
    press("=", { repeat: true });
    press("+", { repeat: true });
    expect(useViewerStore.getState().zoom).toBeCloseTo(ZOOM_STEP ** 3);
    press("-", { repeat: true });
    expect(useViewerStore.getState().zoom).toBeCloseTo(ZOOM_STEP ** 2);
    press("0", { repeat: true });
    expect(useViewerStore.getState().zoom).toBe(1);

    // A held decision key decides once, on its first press.
    press("a");
    press("a", { repeat: true });
    press("r", { repeat: true });
    expect(onApprove).toHaveBeenCalledOnce();
    expect(onReject).not.toHaveBeenCalled();
  });

  it("N repeats, ArrowRight does not", () => {
    const onNextDiff = vi.fn();
    const onPrevDiff = vi.fn();
    const onNextStep = vi.fn();
    mountViewer({ viewports: [], onNextDiff, onPrevDiff, onNextStep });

    // Held, N and P walk the changes (R13).
    press("n");
    press("n", { repeat: true });
    press("n", { repeat: true });
    expect(onNextDiff).toHaveBeenCalledTimes(3);
    press("p", { repeat: true });
    expect(onPrevDiff).toHaveBeenCalledTimes(1);

    // Held, → moves one step: each step is a route change, and its repeats
    // would push the same stale target.
    press("ArrowRight");
    const held = press("ArrowRight", { repeat: true });
    expect(onNextStep).toHaveBeenCalledOnce();
    expect(held.defaultPrevented).toBe(false);
  });

  it("a held [ switches the viewport once", () => {
    useViewerStore.setState({ viewport: "b" });
    mountViewer({ viewports: ["a", "b", "c"] });
    press("[");
    expect(useViewerStore.getState().viewport).toBe("a");
    // Each switch loads the images again: the repeats do nothing.
    press("[", { repeat: true });
    press("]", { repeat: true });
    expect(useViewerStore.getState().viewport).toBe("a");
  });

  it("typing a into the open palette's input approves nothing", async () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    function Viewer() {
      useDiffViewerShortcuts({ viewports: [], onApprove, onReject });
      return null;
    }
    render(
      <Keyboard role="editor">
        <CurrentProjectProvider
          initialProjects={[]}
          initialDefaultProjectId={null}
        >
          <TrpcBackend backend={createBackend()}>
            <CommandPalette userRole="editor" userId="u1" />
          </TrpcBackend>
        </CurrentProjectProvider>
        <Viewer />
      </Keyboard>,
    );
    press("k", { ctrlKey: true });
    const input = await screen.findByTestId("command-input");
    act(() => input.focus());

    const user = userEvent.setup();
    await user.type(input, "arx");
    expect(onApprove).not.toHaveBeenCalled();
    expect(onReject).not.toHaveBeenCalled();
    // The letters are the search's.
    expect((input as HTMLInputElement).value).toBe("arx");
  });

  it("g i in the viewer navigates and does not toggle the region editor", () => {
    const onApprove = vi.fn();
    const onPrevDiff = vi.fn();
    mountViewer({ viewports: [], onApprove, onPrevDiff });

    press("g");
    const i = press("i");
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenCalledWith("/inbox");
    expect(i.defaultPrevented).toBe(true);
    // `ignoreEditMode` persists across navigation: a toggle here would
    // carry the editor into the next page.
    expect(useViewerStore.getState().ignoreEditMode).toBe("off");

    // An editor's `g a` / `g p` are not theirs: nothing approves, and no
    // previous change.
    press("g");
    press("a");
    press("g");
    press("p");
    expect(onApprove).not.toHaveBeenCalled();
    expect(onPrevDiff).not.toHaveBeenCalled();
    expect(pushMock).toHaveBeenCalledTimes(1);

    // On its own, `i` is the viewer's.
    press("i");
    expect(useViewerStore.getState().ignoreEditMode).toBe("run");
  });
});
