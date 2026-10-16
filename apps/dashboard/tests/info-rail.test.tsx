import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
// The global commands' ⌘Z: no review session here.
vi.mock("@/lib/review/use-review-mutations", () => ({
  useReviewMutations: () => ({ undo: vi.fn() }),
}));
// The rail's content without its heavy panels: the region list and the
// comment editor have suites of their own.
vi.mock("@/components/diff-viewer/RegionListPanel", () => ({
  RegionListPanel: () => <div data-testid="region-list-panel" />,
}));
vi.mock("@/components/diff-viewer/RunCommentPanel", () => ({
  RunCommentPanel: () => <div data-testid="comment-panel" />,
}));

import { createBackend, TrpcBackend } from "./trpc-backend";

import { CurrentProjectProvider } from "@/app/(protected)/_components/current-project-provider";
import { CommandPalette } from "@/components/cmdk/command-palette";
import { usePaletteStore } from "@/components/cmdk/use-command-palette";
import {
  IgnoreRegionListPanel,
  useIgnoreRegionsInView,
} from "@/components/diff-viewer/IgnoreRegionListPanel";
import { InfoRail } from "@/components/diff-viewer/InfoRail";
import { useRailState } from "@/components/diff-viewer/rail-state";
import { TestInfoSidebar } from "@/components/diff-viewer/TestInfoSidebar";
import {
  useDiffViewerShortcuts,
  type ShortcutOptions,
} from "@/components/diff-viewer/useDiffViewerShortcuts";
import { useViewerStore } from "@/components/diff-viewer/useViewerStore";
import { useViewState } from "@/components/diff-viewer/view-state";
import {
  DEFAULT_VIEWER_PREFS,
  prefsKey,
  useViewerPrefs,
  type RailTab,
  type ViewerPrefs,
} from "@/components/diff-viewer/viewer-prefs";
import { ShortcutsSheet } from "@/components/shortcuts/shortcuts-sheet";
import { useShortcutsSheet } from "@/components/shortcuts/use-shortcuts-sheet";
import { CommandDispatcher } from "@/lib/commands/dispatcher";
import { GlobalCommands } from "@/lib/commands/global-commands";
import { useSingleKeyStore } from "@/lib/commands/prefs";
import {
  CommandRoleProvider,
  useCommandRegistry,
} from "@/lib/commands/registry";

/**
 * The diff viewer's info rail (spec §5): a separator that resizes it from
 * 280 to 560 px, never over 45% of the window, without a narrow window
 * overwriting the stored width (Review Focus 5); a 40 px strip when
 * collapsed (`t`, the Hide / Show details buttons, the strip's tabs, `c`);
 * its width, state and tab remembered per user; below 1024 px it starts
 * collapsed for the visit and, opened, overlays the canvas; and while the
 * ignore-region editor is open it holds the editor's regions, one rail.
 */

const USER = "u1";
const backend = createBackend();

const INFO = {
  test: "Pricing Page",
  stepLabel: "1/2 Monthly Plans",
  match: null,
  app: null,
  branch: null,
  os: null,
  browser: null,
  viewport: null,
  startedAt: null,
  duration: null,
  runBy: null,
  pixelDiffPercent: null,
  regions: [],
  vlmDescription: null,
  testVariationId: null,
  currentBaselineKey: null,
  runId: "r1",
};

/**
 * The viewer's part that matters here: its keys, and the rail with its
 * content, the step's details or, while editing, the editor's regions.
 */
function Viewer({
  opts = {},
  onTab,
  stepLabel = INFO.stepLabel,
}: {
  opts?: Partial<ShortcutOptions>;
  onTab?: (tab: RailTab) => void;
  stepLabel?: string;
}) {
  useDiffViewerShortcuts({ viewports: [], ...opts });
  const count = useIgnoreRegionsInView(null).length;
  return (
    <div className="relative flex">
      <button type="button">Outside</button>
      <InfoRail
        {...(onTab ? { onTab } : {})}
        editor={{ content: <IgnoreRegionListPanel viewport={null} />, count }}
      >
        <TestInfoSidebar {...INFO} stepLabel={stepLabel} />
      </InfoRail>
    </div>
  );
}

/** Only the viewer's keys: no rail on screen. */
function KeysOnly() {
  useDiffViewerShortcuts({ viewports: [] });
  return null;
}

/** The protected layout: the role, the global commands, the dispatcher, the sheet and the palette. */
function Page({ children }: { children?: ReactNode }) {
  return (
    <TrpcBackend backend={backend}>
      <CommandRoleProvider role="editor">
        <CurrentProjectProvider
          initialProjects={[{ id: "p1", name: "Acme" }]}
          initialDefaultProjectId="p1"
        >
          <GlobalCommands />
          <CommandDispatcher />
          {children}
          <ShortcutsSheet />
          <CommandPalette userRole="editor" userId={USER} />
        </CurrentProjectProvider>
      </CommandRoleProvider>
    </TrpcBackend>
  );
}

function setWindowWidth(width: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: width,
  });
}

/** The window resized (or the browser zoomed) to `width` CSS px. */
function resizeWindow(width: number) {
  setWindowWidth(width);
  act(() => {
    window.dispatchEvent(new Event("resize"));
  });
}

/** The user's preferences: `p` over the defaults, and in storage too when `persisted`. */
function prefsAre(p: Partial<ViewerPrefs> = {}, { persisted = false } = {}) {
  const prefs = { ...DEFAULT_VIEWER_PREFS, ...p };
  useViewerPrefs.setState({
    userId: USER,
    prefs,
    previousMode: "side-by-side",
  });
  if (persisted) localStorage.setItem(prefsKey(USER), JSON.stringify(prefs));
}

/** What storage holds for the user. */
function stored(): Partial<ViewerPrefs> | null {
  const raw = localStorage.getItem(prefsKey(USER));
  return raw === null ? null : (JSON.parse(raw) as Partial<ViewerPrefs>);
}

/** Every write of the user's preferences to storage. */
function prefsWrites(spy: { mock: { calls: unknown[][] } }): unknown[][] {
  return spy.mock.calls.filter(([key]) => key === prefsKey(USER));
}

/** A keydown on the focused element, as the browser sends it. */
function press(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
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

/** A pointer event as the browser sends it (jsdom has no PointerEvent). */
function pointer(type: string, x: number): MouseEvent {
  const e = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: 200,
    button: 0,
  });
  Object.defineProperty(e, "pointerId", { value: 1 });
  return e;
}

function gesture(el: Element, ...points: Array<[string, number]>) {
  for (const [type, x] of points) {
    act(() => {
      el.dispatchEvent(pointer(type, x));
    });
  }
}

const rail = () => screen.getByRole("complementary");
/**
 * The space the rail takes in its row, as the canvas beside it sees it: the
 * widths of its in-flow boxes (an overlaid rail is positioned out of flow).
 */
const railSpace = () =>
  [...rail().parentElement!.children]
    .filter(
      (el): el is HTMLElement =>
        el instanceof HTMLElement &&
        el.textContent !== "Outside" &&
        !el.classList.contains("absolute"),
    )
    .map((el) => el.style.width);
const separator = () =>
  screen.getByRole("separator", { name: "Resize details" });
const button = (name: string) => screen.getByRole("button", { name });
const valueNow = () => separator().getAttribute("aria-valuenow");
const pressed = (name: string) => button(name).getAttribute("aria-pressed");

beforeEach(() => {
  localStorage.clear();
  setWindowWidth(1440);
  prefsAre();
  // A new visit: nothing decided about the rail yet.
  useRailState.setState({ visit: null, started: false, focus: null });
  useCommandRegistry.setState({ entries: [], role: "guest" });
  useSingleKeyStore.setState({ on: true });
  usePaletteStore.setState({ open: false });
  useShortcutsSheet.setState({ open: false });
  useViewerStore.setState({
    commentPanelOpen: false,
    commentDrafts: {},
    ignoreEditMode: "off",
    draftIgnoreAreas: [],
    selectedIgnoreId: null,
  });
  useViewState.setState({ selectedRegionId: null });
});

afterEach(() => {
  cleanup();
  setWindowWidth(1024);
  vi.restoreAllMocks();
});

describe("the separator", () => {
  test("a focusable vertical separator named Resize details, 280 to 560 px in a wide window", () => {
    render(
      <Page>
        <Viewer />
      </Page>,
    );
    const sep = separator();
    expect(sep.getAttribute("aria-orientation")).toBe("vertical");
    expect(sep.tabIndex).toBe(0);
    expect(valueNow()).toBe("320");
    expect(sep.getAttribute("aria-valuemin")).toBe("280");
    // 45% of 1440 is 648: the 560 px maximum holds.
    expect(sep.getAttribute("aria-valuemax")).toBe("560");
    expect(rail().style.width).toBe("320px");
  });

  test("R24: ← / → move the handle on the rail's left edge, so ← widens by 16 and Shift+← by 64, → narrows, each key stored; End goes to the window's cap (450 in a 1000 px window) and stores the maximum asked for", () => {
    render(
      <Page>
        <Viewer />
      </Page>,
    );
    resizeWindow(1000);
    const sep = separator();
    expect(sep.getAttribute("aria-valuemax")).toBe("450");
    act(() => sep.focus());

    expect(press("ArrowLeft").defaultPrevented).toBe(true);
    expect(valueNow()).toBe("336");
    expect(stored()?.railWidth).toBe(336);

    press("ArrowLeft", { shiftKey: true });
    expect(valueNow()).toBe("400");
    expect(stored()?.railWidth).toBe(400);

    press("End");
    expect(valueNow()).toBe("450");
    expect(rail().style.width).toBe("450px");
    // Not the window's cap: a wider window shows the full maximum.
    expect(stored()?.railWidth).toBe(560);

    expect(press("ArrowRight").defaultPrevented).toBe(true);
    expect(valueNow()).toBe("434");
    expect(stored()?.railWidth).toBe(434);
    press("ArrowRight", { shiftKey: true });
    expect(valueNow()).toBe("370");
    press("Home");
    expect(valueNow()).toBe("280");
    expect(stored()?.railWidth).toBe(280);
    // Never under the minimum.
    press("ArrowRight");
    expect(valueNow()).toBe("280");
    press("ArrowRight", { shiftKey: true });
    expect(valueNow()).toBe("280");
  });

  test("its ← / → are its own: the step commands don't run while it has focus", () => {
    const onNextStep = vi.fn();
    const onPrevStep = vi.fn();
    render(
      <Page>
        <Viewer opts={{ onNextStep, onPrevStep }} />
      </Page>,
    );
    act(() => separator().focus());
    press("ArrowRight");
    press("ArrowLeft");
    expect(onNextStep).not.toHaveBeenCalled();
    expect(onPrevStep).not.toHaveBeenCalled();
    // Anywhere else they step.
    act(() => button("Outside").focus());
    press("ArrowRight");
    expect(onNextStep).toHaveBeenCalledOnce();
  });

  test("a drag shows each width as it goes and stores only the last, on pointerup", () => {
    prefsAre({}, { persisted: true });
    render(
      <Page>
        <Viewer />
      </Page>,
    );
    const sep = separator();
    // The handle is the rail's left edge: dragging left widens it.
    gesture(sep, ["pointerdown", 1000], ["pointermove", 900]);
    expect(valueNow()).toBe("420");
    expect(rail().style.width).toBe("420px");
    expect(useViewerPrefs.getState().prefs.railWidth).toBe(420);
    // Never per frame.
    expect(stored()?.railWidth).toBe(320);
    gesture(sep, ["pointermove", 880]);
    expect(valueNow()).toBe("440");
    expect(stored()?.railWidth).toBe(320);
    gesture(sep, ["pointerup", 880]);
    expect(stored()?.railWidth).toBe(440);
    // Past the maximum it holds there.
    gesture(sep, ["pointerdown", 880], ["pointermove", 100]);
    expect(valueNow()).toBe("560");
    gesture(sep, ["pointerup", 100]);
    expect(stored()?.railWidth).toBe(560);
  });

  test("a press with no drag stores nothing", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    render(
      <Page>
        <Viewer />
      </Page>,
    );
    gesture(separator(), ["pointerdown", 1000], ["pointerup", 1000]);
    expect(prefsWrites(setItem)).toEqual([]);
    expect(valueNow()).toBe("320");
  });

  test("a double click resets it to 320 px, stored", () => {
    prefsAre({ railWidth: 500 }, { persisted: true });
    render(
      <Page>
        <Viewer />
      </Page>,
    );
    expect(valueNow()).toBe("500");
    fireEvent.doubleClick(separator());
    expect(valueNow()).toBe("320");
    expect(rail().style.width).toBe("320px");
    expect(stored()?.railWidth).toBe(320);
  });
});

describe("Review Focus 5: a narrower window clamps the rail on screen, never the stored width", () => {
  test("at 900 px the rail is 405 px and the stored width stays 560; a wider window gives it back", () => {
    prefsAre({ railWidth: 560 }, { persisted: true });
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    render(
      <Page>
        <Viewer />
      </Page>,
    );
    expect(valueNow()).toBe("560");

    resizeWindow(900);
    expect(rail().style.width).toBe("405px");
    expect(valueNow()).toBe("405");
    expect(separator().getAttribute("aria-valuemax")).toBe("405");
    expect(useViewerPrefs.getState().prefs.railWidth).toBe(560);
    expect(stored()?.railWidth).toBe(560);
    expect(prefsWrites(setItem)).toEqual([]);

    resizeWindow(1440);
    expect(rail().style.width).toBe("560px");
    expect(valueNow()).toBe("560");
  });

  test("at the window's cap, ← and a drag past it leave the stored width alone; → narrows it", () => {
    prefsAre({ railWidth: 560 }, { persisted: true });
    render(
      <Page>
        <Viewer />
      </Page>,
    );
    resizeWindow(900);
    const sep = separator();
    act(() => sep.focus());
    press("ArrowLeft");
    expect(valueNow()).toBe("405");
    expect(useViewerPrefs.getState().prefs.railWidth).toBe(560);
    expect(stored()?.railWidth).toBe(560);

    gesture(sep, ["pointerdown", 500], ["pointermove", 400]);
    expect(valueNow()).toBe("405");
    expect(useViewerPrefs.getState().prefs.railWidth).toBe(560);
    gesture(sep, ["pointerup", 400]);
    expect(stored()?.railWidth).toBe(560);

    // Narrower than the cap is the reviewer's own width: stored.
    press("ArrowRight");
    expect(valueNow()).toBe("389");
    expect(stored()?.railWidth).toBe(389);
  });
});

describe("collapsing", () => {
  test("Hide details collapses the rail to the 40 px strip, stored; focus moves to Show details", () => {
    render(
      <Page>
        <Viewer />
      </Page>,
    );
    expect(screen.getByText("1/2 Monthly Plans")).toBeDefined();
    fireEvent.click(button("Hide details"));

    expect(document.activeElement).toBe(button("Show details"));
    expect(rail().style.width).toBe("40px");
    expect(screen.queryByRole("separator")).toBeNull();
    expect(screen.queryByText("1/2 Monthly Plans")).toBeNull();
    expect(stored()?.railCollapsed).toBe(true);
  });

  test("Task 13 M10: the open rail spends no row on Hide details: it ends the tab row", () => {
    render(
      <Page>
        <Viewer />
      </Page>,
    );
    const row = button("Info").parentElement!;
    expect(
      within(row)
        .getAllByRole("button")
        .map((b) => b.getAttribute("aria-label") ?? b.textContent),
    ).toEqual(["Info", "History", "Comments", "Hide details"]);
    // The rail itself holds the separator and its content, nothing else.
    const hide = button("Hide details");
    expect(hide.getAttribute("title")).toBe("Hide details (T)");
    expect(hide.getAttribute("aria-keyshortcuts")).toBe("T");
    expect(
      screen.getAllByRole("button", { name: "Hide details" }),
    ).toHaveLength(1);
  });

  test("the strip's buttons are named Info, History and Comments, each with a matching title", () => {
    prefsAre({ railCollapsed: true });
    render(
      <Page>
        <Viewer />
      </Page>,
    );
    const strip = rail();
    expect(strip.style.width).toBe("40px");
    const names = within(strip)
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label") ?? b.textContent);
    expect(names).toEqual(["Show details", "Info", "History", "Comments"]);
    for (const name of ["Info", "History", "Comments"]) {
      expect(button(name).getAttribute("title")).toBe(name);
    }
  });

  test("t collapses it; with focus in the rail, focus moves to the counterpart each way", () => {
    render(
      <Page>
        <Viewer />
      </Page>,
    );
    act(() => separator().focus());
    expect(press("t").defaultPrevented).toBe(true);
    expect(rail().style.width).toBe("40px");
    expect(document.activeElement).toBe(button("Show details"));
    expect(stored()?.railCollapsed).toBe(true);

    press("t");
    expect(rail().style.width).toBe("320px");
    expect(document.activeElement).toBe(button("Hide details"));
    expect(stored()?.railCollapsed).toBe(false);
  });

  test("t from outside the rail leaves focus where it is", () => {
    render(
      <Page>
        <Viewer />
      </Page>,
    );
    const outside = button("Outside");
    act(() => outside.focus());
    press("t");
    expect(button("Show details")).toBeDefined();
    expect(document.activeElement).toBe(outside);
    press("t");
    expect(button("Hide details")).toBeDefined();
    expect(document.activeElement).toBe(outside);
  });

  test.each([
    ["Info", "info", "1/2 Monthly Plans"],
    ["History", "history", "History will appear"],
    ["Comments", "comments", null],
  ] as const)(
    "the strip's %s opens the rail on that tab, stored; focus moves to Hide details",
    (name, tab, shows) => {
      const onTab = vi.fn();
      prefsAre({
        railCollapsed: true,
        railTab: tab === "info" ? "history" : "info",
      });
      render(
        <Page>
          <Viewer onTab={onTab} />
        </Page>,
      );
      fireEvent.click(button(name));

      expect(pressed(name)).toBe("true");
      expect(document.activeElement).toBe(button("Hide details"));
      expect(stored()).toMatchObject({ railCollapsed: false, railTab: tab });
      expect(onTab.mock.calls).toEqual([[tab]]);
      if (shows) expect(screen.getByText(new RegExp(shows))).toBeDefined();
      else expect(screen.getByTestId("comment-panel")).toBeDefined();
    },
  );
});

describe("c and the comment request", () => {
  test("c opens a collapsed rail on Comments", () => {
    prefsAre({ railCollapsed: true });
    render(
      <Page>
        <Viewer />
      </Page>,
    );
    expect(press("c").defaultPrevented).toBe(true);
    expect(pressed("Comments")).toBe("true");
    expect(screen.getByTestId("comment-panel")).toBeDefined();
    expect(stored()).toMatchObject({
      railCollapsed: false,
      railTab: "comments",
    });
    // The request is taken.
    expect(useViewerStore.getState().commentPanelOpen).toBe(false);
  });

  test("c on an open rail switches it to Comments, and c after a collapse opens it again", () => {
    render(
      <Page>
        <Viewer />
      </Page>,
    );
    press("c");
    expect(pressed("Comments")).toBe("true");
    press("t");
    expect(button("Show details")).toBeDefined();
    press("c");
    expect(pressed("Comments")).toBe("true");
  });

  test("Task 13 M2: with no rail on screen, c is the browser's and leaves no request for the next rail", () => {
    const { rerender } = render(
      <Page>
        <KeysOnly />
      </Page>,
    );
    expect(press("c").defaultPrevented).toBe(false);
    expect(useViewerStore.getState().commentPanelOpen).toBe(false);

    // The next rail opens as the reviewer left it, and stores nothing.
    rerender(
      <Page>
        <Viewer />
      </Page>,
    );
    expect(pressed("Info")).toBe("true");
    expect(stored()).toBeNull();
  });

  test("Mark as Bug's request (the comment flag) opens a collapsed rail on Comments too", () => {
    prefsAre({ railCollapsed: true, railTab: "history" });
    render(
      <Page>
        <Viewer />
      </Page>,
    );
    act(() => useViewerStore.getState().setCommentPanelOpen(true));
    expect(pressed("Comments")).toBe("true");
    expect(useViewerStore.getState().commentPanelOpen).toBe(false);
  });
});

test("the tab is remembered: History, then the next step's viewer (a remount) is still on History", () => {
  const { rerender } = render(
    <Page>
      <Viewer key="step-1" />
    </Page>,
  );
  fireEvent.click(button("History"));
  expect(pressed("History")).toBe("true");

  rerender(
    <Page>
      <Viewer key="step-2" stepLabel="2/2 Annual Plans" />
    </Page>,
  );
  expect(pressed("History")).toBe("true");
  expect(pressed("Info")).toBe("false");
  expect(stored()?.railTab).toBe("history");
});

describe("below 1024 px", () => {
  test("it starts collapsed for the visit, and nothing is stored", () => {
    prefsAre({ railCollapsed: false }, { persisted: true });
    setWindowWidth(900);
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    render(
      <Page>
        <Viewer />
      </Page>,
    );
    expect(rail().style.width).toBe("40px");
    expect(button("Show details")).toBeDefined();
    expect(useViewerPrefs.getState().prefs.railCollapsed).toBe(false);
    expect(prefsWrites(setItem)).toEqual([]);
  });

  test("opened, it overlays the canvas's right edge with the overlay shadow, and t closes it; nothing is stored", () => {
    prefsAre({}, { persisted: true });
    setWindowWidth(900);
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    render(
      <Page>
        <Viewer />
      </Page>,
    );
    fireEvent.click(button("Show details"));
    const overlaid = rail();
    for (const cls of ["absolute", "right-0", "shadow-overlay"]) {
      expect(overlaid.classList.contains(cls), cls).toBe(true);
    }
    expect(overlaid.style.width).toBe("320px");

    press("t");
    expect(rail().style.width).toBe("40px");
    expect(rail().classList.contains("absolute")).toBe(false);
    expect(prefsWrites(setItem)).toEqual([]);
  });

  test("Task 13 M3: opening it over the canvas doesn't widen the canvas: the strip's 40 px stay taken", () => {
    setWindowWidth(900);
    render(
      <Page>
        <Viewer />
      </Page>,
    );
    expect(railSpace()).toEqual(["40px"]);

    fireEvent.click(button("Show details"));
    expect(rail().classList.contains("absolute")).toBe(true);
    expect(railSpace()).toEqual(["40px"]);
    // Still one landmark: what holds the place is not one.
    expect(screen.getAllByRole("complementary")).toHaveLength(1);

    press("t");
    expect(railSpace()).toEqual(["40px"]);

    // A wide window's rail is in the row itself, at its width.
    resizeWindow(1440);
    press("t");
    expect(rail().classList.contains("absolute")).toBe(false);
    expect(railSpace()).toEqual(["320px"]);
  });

  test("the visit's choice holds on the next step", () => {
    setWindowWidth(900);
    const { rerender } = render(
      <Page>
        <Viewer key="step-1" />
      </Page>,
    );
    fireEvent.click(button("Show details"));
    rerender(
      <Page>
        <Viewer key="step-2" />
      </Page>,
    );
    expect(button("Hide details")).toBeDefined();
  });

  test("Esc closes it while focus is in it, before the editor; focus moves to Show details", () => {
    setWindowWidth(900);
    render(
      <Page>
        <Viewer />
      </Page>,
    );
    act(() => useViewerStore.getState().setIgnoreEditMode("run"));
    // In the editor the strip's button names the editor's regions (R26).
    fireEvent.click(button("Ignore regions (0)"));
    expect(document.activeElement).toBe(button("Hide details"));

    expect(press("Escape").defaultPrevented).toBe(true);
    expect(rail().style.width).toBe("40px");
    expect(document.activeElement).toBe(button("Ignore regions (0)"));
    // The rail took that Esc: the editor is still open.
    expect(useViewerStore.getState().ignoreEditMode).toBe("run");
  });

  test("with focus outside it, Esc is the viewer's first (the editor, the selection), then closes the rail", () => {
    setWindowWidth(900);
    render(
      <Page>
        <Viewer />
      </Page>,
    );
    act(() => {
      useViewerStore.getState().setIgnoreEditMode("run");
      useViewState.setState({ selectedRegionId: "r1" });
    });
    fireEvent.click(button("Ignore regions (0)"));
    const outside = button("Outside");
    act(() => outside.focus());

    press("Escape");
    expect(useViewerStore.getState().ignoreEditMode).toBe("off");
    expect(useViewState.getState().selectedRegionId).toBeNull();
    expect(button("Hide details")).toBeDefined();

    expect(press("Escape").defaultPrevented).toBe(true);
    expect(button("Show details")).toBeDefined();
    expect(document.activeElement).toBe(outside);
    // Nothing left to close: the browser's.
    expect(press("Escape").defaultPrevented).toBe(false);
  });

  test("a wide window's rail is no overlay, and Esc never closes it", () => {
    render(
      <Page>
        <Viewer />
      </Page>,
    );
    expect(rail().classList.contains("absolute")).toBe(false);
    act(() => separator().focus());
    expect(press("Escape").defaultPrevented).toBe(false);
    expect(button("Hide details")).toBeDefined();
    // The editor's Esc is unchanged.
    act(() => useViewerStore.getState().setIgnoreEditMode("run"));
    press("Escape");
    expect(useViewerStore.getState().ignoreEditMode).toBe("off");
    expect(button("Hide details")).toBeDefined();
  });

  test("after a narrow start, a toggle in a wide window is stored again", () => {
    prefsAre({ railCollapsed: false }, { persisted: true });
    setWindowWidth(900);
    render(
      <Page>
        <Viewer />
      </Page>,
    );
    expect(button("Show details")).toBeDefined();
    resizeWindow(1440);
    // Still the visit's collapse.
    expect(button("Show details")).toBeDefined();
    press("t");
    expect(button("Hide details")).toBeDefined();
    press("t");
    expect(stored()?.railCollapsed).toBe(true);
  });
});

describe("the ignore-region editor: one rail (spec §5)", () => {
  const DRAFT = {
    id: "d1",
    x: 10,
    y: 10,
    width: 20,
    height: 20,
    viewport: "1280x720",
    paddingPx: 0,
    kind: "ignore" as const,
  };
  const edit = () =>
    act(() => useViewerStore.getState().setIgnoreEditMode("run"));
  const leave = () =>
    act(() => useViewerStore.getState().setIgnoreEditMode("off"));
  const ignoreHeading = () =>
    within(rail()).queryByRole("heading", { name: "Ignore regions" });

  test("editing, the rail holds the editor's regions under Ignore regions: one landmark, no Info, History or Comments", () => {
    useViewerStore.setState({ draftIgnoreAreas: [DRAFT] });
    render(
      <Page>
        <Viewer />
      </Page>,
    );
    edit();
    expect(screen.getAllByRole("complementary")).toHaveLength(1);
    expect(ignoreHeading()).not.toBeNull();
    expect(within(rail()).getAllByTestId("ignore-region-item")).toHaveLength(1);
    for (const name of ["Info", "History", "Comments"]) {
      expect(screen.queryByRole("button", { name }), name).toBeNull();
    }
    expect(screen.queryByText("1/2 Monthly Plans")).toBeNull();
    // Still the rail: its width, its separator, and Hide details, which
    // ends the heading's row.
    expect(rail().style.width).toBe("320px");
    expect(separator()).toBeDefined();
    expect(
      within(ignoreHeading()!.parentElement!).getByRole("button", {
        name: "Hide details",
      }),
    ).toBeDefined();
    expect(
      screen.getAllByRole("button", { name: "Hide details" }),
    ).toHaveLength(1);
  });

  test("leaving the editor brings back the tab the reviewer was on, which editing never stored over", () => {
    prefsAre({ railTab: "history" }, { persisted: true });
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    render(
      <Page>
        <Viewer />
      </Page>,
    );
    edit();
    expect(ignoreHeading()).not.toBeNull();
    expect(prefsWrites(setItem)).toEqual([]);

    leave();
    expect(ignoreHeading()).toBeNull();
    expect(pressed("History")).toBe("true");
    expect(screen.getByText(/History will appear/)).toBeDefined();
    expect(stored()?.railTab).toBe("history");
  });

  test("Task 14 M3: collapsed, the strip's one button is Ignore regions (N), with the count; it opens the rail on them, and t folds it again", () => {
    prefsAre({ railCollapsed: true });
    useViewerStore.setState({
      draftIgnoreAreas: [DRAFT, { ...DRAFT, id: "d2" }],
    });
    render(
      <Page>
        <Viewer />
      </Page>,
    );
    edit();
    expect(rail().style.width).toBe("40px");
    // Its tabs would open on what the editor hides.
    const strip = within(rail()).getAllByRole("button");
    expect(strip.map((b) => b.getAttribute("aria-label"))).toEqual([
      "Ignore regions (2)",
    ]);
    const open = button("Ignore regions (2)");
    expect(open.textContent).toBe("2");
    expect(open.getAttribute("title")).toBe("Ignore regions (2) (T)");
    expect(open.getAttribute("aria-keyshortcuts")).toBe("T");
    // The count follows the editor's regions.
    act(() => useViewerStore.setState({ draftIgnoreAreas: [DRAFT] }));
    expect(button("Ignore regions (1)").textContent).toBe("1");

    fireEvent.click(button("Ignore regions (1)"));
    expect(ignoreHeading()).not.toBeNull();
    expect(document.activeElement).toBe(button("Hide details"));
    expect(screen.getAllByRole("complementary")).toHaveLength(1);

    press("t");
    expect(rail().style.width).toBe("40px");
    expect(document.activeElement).toBe(button("Ignore regions (1)"));
    // Out of the editor, the strip is Show details and its tabs again.
    leave();
    expect(button("Show details")).toBeDefined();
    expect(button("Comments")).toBeDefined();
  });

  test("Task 14 M3: below 1024 px, the strip's Ignore regions (N) opens the rail over the canvas", () => {
    setWindowWidth(900);
    useViewerStore.setState({ draftIgnoreAreas: [DRAFT] });
    render(
      <Page>
        <Viewer />
      </Page>,
    );
    edit();
    fireEvent.click(button("Ignore regions (1)"));
    expect(rail().classList.contains("absolute")).toBe(true);
    expect(ignoreHeading()).not.toBeNull();
    expect(railSpace()).toEqual(["40px"]);
  });

  test("Task 14 M2: the landmark is named Details, and in the editor by its Ignore regions heading", () => {
    render(
      <Page>
        <Viewer />
      </Page>,
    );
    expect(screen.getByRole("complementary", { name: "Details" })).toBe(rail());
    edit();
    const named = screen.getByRole("complementary", {
      name: "Ignore regions",
    });
    expect(named.getAttribute("aria-labelledby")).toBe(ignoreHeading()!.id);
    expect(named.hasAttribute("aria-label")).toBe(false);

    // Collapsed, the strip is named for what it opens on.
    fireEvent.click(button("Hide details"));
    expect(screen.getByRole("complementary", { name: "Ignore regions" })).toBe(
      rail(),
    );
    leave();
    expect(screen.getByRole("complementary", { name: "Details" })).toBe(rail());
  });

  test("c is the browser's in the editor, where the comments can't be shown; out of it, c shows them", () => {
    render(
      <Page>
        <Viewer />
      </Page>,
    );
    edit();
    expect(press("c").defaultPrevented).toBe(false);
    expect(useViewerStore.getState().commentPanelOpen).toBe(false);
    expect(ignoreHeading()).not.toBeNull();

    leave();
    expect(press("c").defaultPrevented).toBe(true);
    expect(pressed("Comments")).toBe("true");
  });

  test("Mark as Bug in the editor: the request is taken and the rail stays as it was, and Comments is the tab that comes back", () => {
    prefsAre({ railCollapsed: true });
    render(
      <Page>
        <Viewer />
      </Page>,
    );
    edit();
    act(() => useViewerStore.getState().setCommentPanelOpen(true));
    expect(useViewerStore.getState().commentPanelOpen).toBe(false);
    // Opening it would show the editor's regions, not the comments.
    expect(button("Ignore regions (0)")).toBeDefined();
    expect(useViewerPrefs.getState().prefs.railTab).toBe("comments");

    leave();
    fireEvent.click(button("Show details"));
    expect(pressed("Comments")).toBe("true");
    expect(screen.getByTestId("comment-panel")).toBeDefined();
  });

  test("opening or closing the editor with focus in what the rail swaps out: focus moves to the toggle, which stays", () => {
    useViewerStore.setState({ draftIgnoreAreas: [DRAFT] });
    render(
      <Page>
        <Viewer />
      </Page>,
    );
    // In the details' tab row: the editor's regions replace it.
    act(() => button("History").focus());
    press("i");
    expect(ignoreHeading()).not.toBeNull();
    expect(document.activeElement).toBe(button("Hide details"));

    // On one of the editor's rows: the details replace them.
    const row = within(rail()).getByTestId("ignore-region-item");
    act(() => row.focus());
    press("Escape");
    expect(ignoreHeading()).toBeNull();
    expect(document.activeElement).toBe(button("Hide details"));

    // On what stays (the separator), and outside the rail: where it was.
    act(() => separator().focus());
    press("i");
    expect(document.activeElement).toBe(separator());
    press("i");
    act(() => button("Outside").focus());
    press("i");
    expect(document.activeElement).toBe(button("Outside"));
    press("i");
    act(() => button("Outside").blur());
    press("i");
    expect(document.activeElement).toBe(document.body);
    press("i");

    // On the strip's tabs, which the editor's strip doesn't have.
    fireEvent.click(button("Hide details"));
    act(() => button("Comments").focus());
    press("i");
    expect(document.activeElement).toBe(button("Ignore regions (1)"));
  });

  test("below 1024 px, the editor's rail overlays the canvas like the details do, and Esc with focus in it closes the rail first", () => {
    setWindowWidth(900);
    render(
      <Page>
        <Viewer />
      </Page>,
    );
    edit();
    fireEvent.click(button("Ignore regions (0)"));
    expect(rail().classList.contains("absolute")).toBe(true);
    expect(ignoreHeading()).not.toBeNull();
    expect(railSpace()).toEqual(["40px"]);

    press("Escape");
    expect(rail().style.width).toBe("40px");
    expect(useViewerStore.getState().ignoreEditMode).toBe("run");
  });
});

describe("viewer.rail.toggle in the registry", () => {
  /** The `?` sheet's row for `label` under the viewer's heading. */
  function sheetRow(label: string): HTMLElement | undefined {
    const sheet = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
    const page = within(sheet)
      .getAllByRole("region")
      .find((region) =>
        document
          .getElementById(region.getAttribute("aria-labelledby") ?? "")
          ?.textContent?.includes("Diff viewer"),
      );
    return within(page!)
      .getAllByRole("listitem")
      .find((li) => li.firstElementChild?.textContent === label);
  }

  test("the ? sheet lists it on T as Hide details while the rail is open, Show details once it is collapsed", () => {
    render(
      <Page>
        <Viewer />
      </Page>,
    );
    act(() => useShortcutsSheet.getState().setOpen(true));
    const open = sheetRow("Hide details");
    expect(open).toBeDefined();
    expect(within(open!).getByText("T")).toBeDefined();
    expect(sheetRow("Show details")).toBeUndefined();
    act(() => useShortcutsSheet.getState().setOpen(false));

    press("t");
    act(() => useShortcutsSheet.getState().setOpen(true));
    const collapsed = sheetRow("Show details");
    expect(collapsed).toBeDefined();
    expect(within(collapsed!).getByText("T")).toBeDefined();
    expect(sheetRow("Hide details")).toBeUndefined();
  });

  test("the palette offers it as an action named for what it does, with T, and running it toggles the rail", async () => {
    render(
      <Page>
        <Viewer />
      </Page>,
    );
    async function action(label: string): Promise<HTMLElement | undefined> {
      act(() => usePaletteStore.getState().setOpen(true));
      const palette = await screen.findByTestId("command-palette");
      const group = within(palette).getByRole("group", { name: "Actions" });
      return within(group)
        .queryAllByRole("option")
        .find((o) => o.firstElementChild?.textContent === label);
    }
    const hide = await action("Hide details");
    expect(hide).toBeDefined();
    expect(hide!.getAttribute("aria-keyshortcuts")).toBe("T");
    fireEvent.click(hide!);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(usePaletteStore.getState().open).toBe(false);
    expect(button("Show details")).toBeDefined();

    expect(await action("Show details")).toBeDefined();
    expect(await action("Hide details")).toBeUndefined();
  });

  test("Task 13 M9: c is named for what it does, Show comments, in the ? sheet and the palette", async () => {
    render(
      <Page>
        <Viewer />
      </Page>,
    );
    act(() => useShortcutsSheet.getState().setOpen(true));
    const row = sheetRow("Show comments");
    expect(row).toBeDefined();
    expect(within(row!).getByText("C")).toBeDefined();
    expect(sheetRow("Toggle comments")).toBeUndefined();
    act(() => useShortcutsSheet.getState().setOpen(false));

    act(() => usePaletteStore.getState().setOpen(true));
    const palette = await screen.findByTestId("command-palette");
    const group = within(palette).getByRole("group", { name: "Actions" });
    const options = within(group).queryAllByRole("option");
    const show = options.find(
      (o) => o.firstElementChild?.textContent === "Show comments",
    );
    expect(show?.getAttribute("aria-keyshortcuts")).toBe("C");
    expect(
      options.find(
        (o) => o.firstElementChild?.textContent === "Toggle comments",
      ),
    ).toBeUndefined();
  });

  test("its buttons carry T: aria-keyshortcuts and the title", () => {
    render(
      <Page>
        <Viewer />
      </Page>,
    );
    const hide = button("Hide details");
    expect(hide.getAttribute("aria-keyshortcuts")).toBe("T");
    expect(hide.getAttribute("title")).toBe("Hide details (T)");
    fireEvent.click(hide);
    const show = button("Show details");
    expect(show.getAttribute("aria-keyshortcuts")).toBe("T");
    expect(show.getAttribute("title")).toBe("Show details (T)");
  });

  test("the single-key switch turns it off: t does nothing, the sheet says so, and the button names no key", () => {
    useSingleKeyStore.setState({ on: false });
    render(
      <Page>
        <Viewer />
      </Page>,
    );
    expect(press("t").defaultPrevented).toBe(false);
    expect(button("Hide details")).toBeDefined();
    expect(button("Hide details").getAttribute("aria-keyshortcuts")).toBeNull();
    expect(button("Hide details").getAttribute("title")).toBe("Hide details");
    act(() => useShortcutsSheet.getState().setOpen(true));
    expect(sheetRow("Hide details")?.textContent).toContain(
      "(single-key shortcuts are off)",
    );
  });

  test("with no rail on screen, t is the browser's", () => {
    render(
      <Page>
        <KeysOnly />
      </Page>,
    );
    expect(press("t").defaultPrevented).toBe(false);
    expect(useViewerPrefs.getState().prefs.railCollapsed).toBe(false);
  });
});
