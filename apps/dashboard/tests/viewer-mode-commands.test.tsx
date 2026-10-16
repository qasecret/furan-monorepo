import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useMemo, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { fake } from "./pixi-fake";
import { createBackend, TrpcBackend } from "./trpc-backend";

// The URL the viewer is on, and its router.
const nav = vi.hoisted(() => ({
  pathname: "",
  search: "",
  router: { push: vi.fn(), replace: vi.fn() },
}));
vi.mock("pixi.js/unsafe-eval", () => ({}));
vi.mock("pixi.js", async () => (await import("./pixi-fake")).pixiModule);
vi.mock("next/navigation", () => ({
  useRouter: () => nav.router,
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(nav.search),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
// The global commands' ⌘Z: no review session here.
vi.mock("@/lib/review/use-review-mutations", () => ({
  useReviewMutations: () => ({ undo: vi.fn() }),
}));

import { CurrentProjectProvider } from "@/app/(protected)/_components/current-project-provider";
import { CommandPalette } from "@/components/cmdk/command-palette";
import { usePaletteStore } from "@/components/cmdk/use-command-palette";
import {
  VIEWER_MODES,
  type ViewerMode,
} from "@/components/diff-viewer/comparison-modes";
import type {
  ImageSetRequest,
  ImageSetState,
  LoadedImage,
} from "@/components/diff-viewer/image-set";
import { useDiffViewerShortcuts } from "@/components/diff-viewer/useDiffViewerShortcuts";
import { useViewerStore } from "@/components/diff-viewer/useViewerStore";
import { useViewState } from "@/components/diff-viewer/view-state";
import {
  readEffectiveMode,
  setEditorOverride,
  useViewerMode,
  ViewerModeProvider,
} from "@/components/diff-viewer/viewer-mode";
import {
  DEFAULT_VIEWER_PREFS,
  prefsKey,
  readViewerPrefs,
  useViewerPrefs,
} from "@/components/diff-viewer/viewer-prefs";
import { ViewerStage } from "@/components/diff-viewer/ViewerStage";
import { ViewerToolbar } from "@/components/diff-viewer/ViewerToolbar";
import { ShortcutsSheet } from "@/components/shortcuts/shortcuts-sheet";
import { useShortcutsSheet } from "@/components/shortcuts/use-shortcuts-sheet";
import { CommandDispatcher } from "@/lib/commands/dispatcher";
import { GlobalCommands } from "@/lib/commands/global-commands";
import { bindingKey } from "@/lib/commands/keys";
import { useSingleKeyStore } from "@/lib/commands/prefs";
import {
  CommandRoleProvider,
  resolveCommands,
  useCommandRegistry,
} from "@/lib/commands/registry";
import type { ViewerRole } from "@/lib/roles";

/**
 * Task 12 (spec §4.1, §4.4, §8): the five comparison modes on 1–5, `o` and
 * `d` over them, the toolbar's radio group, the label on the canvas, and the
 * ignore-region editor's rule in Swipe and Flicker. The viewer here is wired
 * as the DiffViewer wires it: one `useViewerMode`, handed to the keys, the
 * toolbar and the stage.
 */

const STEP = "/projects/p1/runs/r1/checkpoints/c1";

/** The spec's five modes: their command, key and label (§4.1, §8). */
const MODES: Array<[ViewerMode, string, string, string]> = [
  ["side-by-side", "viewer.mode.sideBySide", "1", "Side by side"],
  ["swipe", "viewer.mode.swipe", "2", "Swipe"],
  ["flicker", "viewer.mode.flicker", "3", "Flicker"],
  ["overlay", "viewer.mode.overlay", "4", "Overlay"],
  ["diff", "viewer.mode.diff", "5", "Diff"],
];

let counter = 0;
/** A key no other test uses: the image loader's cache is module-wide. */
const k = (name: string): string => `vmc${counter}-${name}`;

function loaded(name: string, w = 400, h = 300): LoadedImage {
  const bitmap = { width: w, height: h, close: vi.fn() };
  return {
    key: k(name),
    bitmap: bitmap as unknown as ImageBitmap,
    size: { w, h },
  };
}

/** A step's settled images: a baseline unless `hasBaseline` is false. */
function images(hasBaseline: boolean): {
  set: ImageSetState;
  request: ImageSetRequest;
} {
  const baseline = hasBaseline ? loaded("b") : undefined;
  const current = loaded("c");
  return {
    set: {
      status: "ready",
      images: { ...(baseline ? { baseline } : {}), current },
      failed: {},
      retry: () => {},
    },
    request: {
      baseline: baseline?.key ?? null,
      current: current.key,
      diff: null,
    },
  };
}

interface ViewerProps {
  urlView?: ViewerMode | null;
  hasBaseline?: boolean;
  step?: string;
  onPrevStep?: () => void;
  onNextStep?: () => void;
}

/** The viewer's mode, keys, toolbar and stage, as the DiffViewer wires them. */
function Viewer({
  urlView = null,
  hasBaseline = true,
  step = "c1",
  onPrevStep,
  onNextStep,
}: ViewerProps) {
  const mode = useViewerMode({ urlView, hasBaseline, step });
  useDiffViewerShortcuts({
    viewports: [],
    hasBaseline,
    urlView: mode.view,
    setMode: mode.setMode,
    available: mode.available,
    onPrevStep,
    onNextStep,
  });
  const value = useMemo(
    () => ({
      view: mode.view,
      setMode: mode.setMode,
      available: mode.available,
    }),
    [mode.view, mode.setMode, mode.available],
  );
  // One image set per step, as `useImageSet` keeps it.
  const shown = useMemo(() => images(hasBaseline), [hasBaseline, step]);
  return (
    <ViewerModeProvider value={value}>
      <ViewerToolbar runId="r1" checkpointId={step} hasBaseline={hasBaseline} />
      <ViewerStage set={shown.set} request={shown.request} regions={[]} />
    </ViewerModeProvider>
  );
}

const backend = createBackend();

/** The protected layout: the role, the global commands, the dispatcher. */
function Layout({
  role = "editor",
  children,
}: {
  role?: ViewerRole;
  children?: ReactNode;
}) {
  return (
    <TrpcBackend backend={backend}>
      <CommandRoleProvider role={role}>
        <CurrentProjectProvider
          initialProjects={[{ id: "p1", name: "Acme" }]}
          initialDefaultProjectId="p1"
        >
          <GlobalCommands />
          <CommandDispatcher />
          {children}
        </CurrentProjectProvider>
      </CommandRoleProvider>
    </TrpcBackend>
  );
}

function mount(props: ViewerProps = {}, role: ViewerRole = "editor") {
  const r = render(
    <Layout role={role}>
      <Viewer {...props} />
    </Layout>,
  );
  return {
    ...r,
    rerenderWith: (next: ViewerProps) =>
      r.rerender(
        <Layout role={role}>
          <Viewer {...next} />
        </Layout>,
      ),
  };
}

/** Let pixi's init, promise chains and React effects run to a standstill. */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setImmediate(r));
  });
}

/** A keydown on the window, as the browser sends a key the page doesn't take. */
function press(key: string): KeyboardEvent {
  const e = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
  });
  act(() => {
    window.dispatchEvent(e);
  });
  return e;
}

/** A keydown on the focused element, as the browser sends it. */
function pressOnFocus(key: string): KeyboardEvent {
  const e = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
  });
  act(() => {
    (document.activeElement ?? document.body).dispatchEvent(e);
  });
  return e;
}

/** The mode on the canvas: the single stage's, or side by side's two panes. */
function shownMode(): string | null {
  const single = document.querySelector<HTMLElement>(
    "[data-testid=single-stage-host]",
  );
  if (single) return single.dataset.mode ?? null;
  return document.querySelector("[data-testid=candidate-canvas-host]")
    ? "side-by-side"
    : null;
}

const group = () => screen.getByRole("radiogroup", { name: "Comparison mode" });
const radios = () => within(group()).getAllByRole("radio");
const radio = (name: string) => within(group()).getByRole("radio", { name });
/** The radio checked: its mode. */
const checked = () =>
  radios().find((r) => r.getAttribute("aria-checked") === "true")?.dataset
    .mode ?? null;

/** The canvas labels, in document order. */
const canvasLabels = () =>
  screen.queryAllByTestId("canvas-mode-label").map((el) => el.textContent);

/** The stored preference of the user "u1". */
const stored = () => readViewerPrefs("u1").mode;

/** The preference, set as a reviewer's earlier visit stored it. */
function prefer(mode: ViewerMode) {
  act(() => useViewerPrefs.getState().set("mode", mode));
  nav.router.replace.mockReset();
}

function enabled(id: string): boolean {
  const found = resolveCommands().find((c) => c.command.id === id);
  if (!found) throw new Error(`no ${id}`);
  return found.command.enabled?.(found.ctx()) ?? true;
}

const editing = () => useViewerStore.getState().ignoreEditMode !== "off";

beforeEach(() => {
  counter += 1;
  fake.registry.apps.length = 0;
  fake.registry.created.length = 0;
  fake.registry.holdInit = false;
  fake.registry.textures.length = 0;
  fake.registry.sprites.length = 0;
  fake.registry.uploaded.length = 0;
  fake.registry.maxTextureSize = null;
  localStorage.clear();
  nav.pathname = STEP;
  nav.search = "";
  nav.router.push.mockReset();
  nav.router.replace.mockReset();
  useViewerPrefs.setState({
    userId: null,
    prefs: DEFAULT_VIEWER_PREFS,
    previousMode: "side-by-side",
  });
  useViewerPrefs.getState().hydrate("u1");
  setEditorOverride(null);
  useViewState.getState().resetView({ reducedMotion: false });
  useViewerStore.setState({
    ignoreEditMode: "off",
    regionInputMode: "drag",
    viewport: "",
    savedRunIgnoreAreas: [],
    savedVariationIgnoreAreas: [],
    draftIgnoreAreas: [],
    markedForDeletion: new Set(),
    paddingOverrides: new Map(),
    kindOverrides: new Map(),
    geometryOverrides: new Map(),
    selectedIgnoreId: null,
  });
  useCommandRegistry.setState({ entries: [], role: "guest" });
  useSingleKeyStore.setState({ on: true });
  useShortcutsSheet.setState({ open: false });
  usePaletteStore.setState({ open: false });
});

afterEach(() => {
  cleanup();
  setEditorOverride(null);
  vi.restoreAllMocks();
  localStorage.clear();
  document.body.innerHTML = "";
});

describe("the five mode commands on 1–5 (spec §4.1)", () => {
  test("they are View commands of the viewer, named for their modes, in order", async () => {
    mount();
    await flush();
    const found = resolveCommands().filter(({ command }) =>
      command.id.startsWith("viewer.mode."),
    );
    expect(
      found.map(({ command, scope }) => [
        command.id,
        (command.keys ?? []).map(bindingKey),
        command.label,
        command.group,
        scope,
      ]),
    ).toEqual(
      MODES.map(([, id, key, label]) => [id, [key], label, "View", "viewer"]),
    );
  });

  test.each(MODES)(
    "%s: its key selects it, on the canvas and in the toolbar, and stores it",
    async (mode, _id, key) => {
      prefer(mode === "overlay" ? "diff" : "overlay");
      mount();
      await flush();
      const e = press(key);
      await flush();
      expect(e.defaultPrevented).toBe(true);
      expect(shownMode()).toBe(mode);
      expect(checked()).toBe(mode);
      expect(stored()).toBe(mode);
      expect(nav.router.replace).toHaveBeenLastCalledWith(
        `${STEP}?view=${mode}`,
        { scroll: false },
      );
    },
  );

  test("on a step with no baseline only 1 works: 2–5 are left to the browser, and nothing is stored or written (Task 8 M7)", async () => {
    mount({ hasBaseline: false });
    await flush();
    for (const [mode, id, key] of MODES.slice(1)) {
      expect(enabled(id), id).toBe(false);
      expect(press(key).defaultPrevented, key).toBe(false);
      expect(shownMode(), mode).toBe("side-by-side");
    }
    expect(localStorage.getItem(prefsKey("u1"))).toBeNull();
    expect(nav.router.replace).not.toHaveBeenCalled();
    // Side by side is there: its key is the viewer's.
    expect(enabled("viewer.mode.sideBySide")).toBe(true);
    expect(press("1").defaultPrevented).toBe(true);
    expect(stored()).toBe("side-by-side");
  });

  test("a guest has every mode command and its key: none is a decision", async () => {
    mount({}, "guest");
    await flush();
    const ids = resolveCommands().map(({ command }) => command.id);
    for (const [, id] of MODES) expect(ids).toContain(id);
    for (const [mode, , key] of [...MODES.slice(1), MODES[0]!]) {
      expect(press(key).defaultPrevented, key).toBe(true);
      await flush();
      expect(shownMode()).toBe(mode);
    }
    press("o");
    expect(shownMode()).toBe("swipe");
    press("d");
    expect(shownMode()).toBe("diff");
  });

  test("the ? sheet lists them on the viewer's page, with their keys", () => {
    render(
      <Layout>
        <Viewer />
        <ShortcutsSheet />
      </Layout>,
    );
    act(() => useShortcutsSheet.getState().setOpen(true));
    const sheet = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
    const page = within(sheet)
      .getAllByRole("region")
      .find((region) =>
        document
          .getElementById(region.getAttribute("aria-labelledby") ?? "")
          ?.textContent?.includes("Diff viewer"),
      );
    expect(page).toBeDefined();
    const rows = within(page!).getAllByRole("listitem");
    for (const [, , key, label] of MODES) {
      const row = rows.find(
        (li) => li.firstElementChild?.textContent === label,
      );
      expect(row, label).toBeDefined();
      expect(within(row!).getByText(key)).toBeDefined();
    }
    // In the spec's order, together.
    const labels = rows.map((li) => li.firstElementChild?.textContent);
    const at = labels.indexOf("Side by side");
    expect(labels.slice(at, at + 5)).toEqual(MODES.map(([, , , l]) => l));
  });

  test("they are palette Actions, with their keys; running one selects its mode", async () => {
    render(
      <Layout>
        <Viewer />
        <CommandPalette userRole="editor" userId="user-a" />
      </Layout>,
    );
    await flush();
    act(() => usePaletteStore.getState().setOpen(true));
    const palette = await screen.findByTestId("command-palette");
    const actions = within(
      within(palette).getByRole("group", { name: "Actions" }),
    ).getAllByRole("option");
    const named = (label: string) =>
      actions.find((o) => o.firstElementChild?.textContent === label);
    for (const [, , key, label] of MODES) {
      expect(named(label)?.getAttribute("aria-keyshortcuts"), label).toBe(key);
    }
    fireEvent.click(named("Overlay")!);
    // It runs once the palette has closed (Radix's close auto-focus).
    await waitFor(() => expect(shownMode()).toBe("overlay"));
    expect(usePaletteStore.getState().open).toBe(false);
    expect(stored()).toBe("overlay");
  });
});

describe("o and d over the five modes", () => {
  test("with a baseline, o cycles through all five in order, and round", async () => {
    mount();
    await flush();
    const seen: Array<string | null> = [];
    for (let i = 0; i < 5; i += 1) {
      press("o");
      await flush();
      seen.push(shownMode());
    }
    expect(seen).toEqual([
      "swipe",
      "flicker",
      "overlay",
      "diff",
      "side-by-side",
    ]);
  });

  test("with no baseline, o stays on side by side: every other mode is skipped, and nothing is stored", async () => {
    mount({ hasBaseline: false });
    await flush();
    press("o");
    expect(shownMode()).toBe("side-by-side");
    expect(stored()).toBe("side-by-side");
    expect(localStorage.getItem(prefsKey("u1"))).toBeNull();
    expect(nav.router.replace).not.toHaveBeenCalled();
  });

  test("d goes to Diff, and back to the mode it left", async () => {
    prefer("swipe");
    mount();
    await flush();
    press("d");
    expect(shownMode()).toBe("diff");
    press("d");
    expect(shownMode()).toBe("swipe");
    expect(stored()).toBe("swipe");
  });

  test("with no baseline, d is the browser's: it never stores Diff", async () => {
    mount({ hasBaseline: false });
    await flush();
    expect(enabled("viewer.difference")).toBe(false);
    expect(press("d").defaultPrevented).toBe(false);
    expect(stored()).toBe("side-by-side");
    expect(localStorage.getItem(prefsKey("u1"))).toBeNull();
  });
});

describe("the toolbar's radio group (spec §4.1)", () => {
  test("one group named Comparison mode: five radios, in order, the mode on screen checked", async () => {
    prefer("flicker");
    mount();
    await flush();
    expect(radios().map((r) => r.textContent)).toEqual(
      MODES.map(([, , , label]) => label),
    );
    expect(radios().map((r) => r.dataset.mode)).toEqual([...VIEWER_MODES]);
    expect(checked()).toBe("flicker");
    expect(
      radios().filter((r) => r.getAttribute("aria-checked") === "true"),
    ).toHaveLength(1);
    // No tab ARIA is left for the modes.
    expect(screen.queryByRole("tablist", { name: "View mode" })).toBeNull();
  });

  test("one tab stop: the checked radio", async () => {
    prefer("overlay");
    mount();
    await flush();
    expect(radios().map((r) => r.tabIndex)).toEqual([-1, -1, -1, 0, -1]);
  });

  test("→ and ↓ move the check, the mode and the focus; ← and ↑ back; they wrap; Home and End go to the ends", async () => {
    mount();
    await flush();
    act(() => radio("Side by side").focus());
    const step = (key: string) => {
      const e = pressOnFocus(key);
      expect(e.defaultPrevented, key).toBe(true);
      return {
        checked: checked(),
        focused: (document.activeElement as HTMLElement).dataset.mode,
        shown: shownMode(),
      };
    };
    const at = (mode: ViewerMode) => ({
      checked: mode,
      focused: mode,
      shown: mode,
    });
    expect(step("ArrowRight")).toEqual(at("swipe"));
    expect(step("ArrowDown")).toEqual(at("flicker"));
    expect(step("ArrowLeft")).toEqual(at("swipe"));
    expect(step("ArrowUp")).toEqual(at("side-by-side"));
    // Round from the first to the last, and back.
    expect(step("ArrowLeft")).toEqual(at("diff"));
    expect(step("ArrowRight")).toEqual(at("side-by-side"));
    expect(step("End")).toEqual(at("diff"));
    expect(step("Home")).toEqual(at("side-by-side"));
    expect(stored()).toBe("side-by-side");
    // The tab stop goes with the check.
    act(() => radio("Overlay").click());
    expect(radios().map((r) => r.tabIndex)).toEqual([-1, -1, -1, 0, -1]);
  });

  test("a held arrow moves once", async () => {
    mount();
    await flush();
    act(() => radio("Side by side").focus());
    pressOnFocus("ArrowRight");
    for (let i = 0; i < 3; i += 1) {
      const e = new KeyboardEvent("keydown", {
        key: "ArrowRight",
        repeat: true,
        bubbles: true,
        cancelable: true,
      });
      act(() => {
        document.activeElement!.dispatchEvent(e);
      });
      expect(e.defaultPrevented).toBe(true);
    }
    expect(checked()).toBe("swipe");
    expect(nav.router.replace).toHaveBeenCalledOnce();
  });

  test("the arrows are the group's: they never move to another step", async () => {
    const onPrevStep = vi.fn();
    const onNextStep = vi.fn();
    mount({ onPrevStep, onNextStep });
    await flush();
    act(() => radio("Side by side").focus());
    pressOnFocus("ArrowRight");
    pressOnFocus("ArrowLeft");
    expect(onNextStep).not.toHaveBeenCalled();
    expect(onPrevStep).not.toHaveBeenCalled();
    // Out of the group, the arrows are the steps' again.
    act(() => (document.activeElement as HTMLElement).blur());
    press("ArrowRight");
    expect(onNextStep).toHaveBeenCalledOnce();
  });

  test("each radio's title and aria-keyshortcuts are its command's: its digit", async () => {
    mount();
    await flush();
    expect(
      radios().map((r) => [
        r.getAttribute("title"),
        r.getAttribute("aria-keyshortcuts"),
      ]),
    ).toEqual(MODES.map(([, , key, label]) => [`${label} (${key})`, key]));
  });

  test("with single-key shortcuts off, no radio promises a key", async () => {
    mount();
    await flush();
    act(() => useSingleKeyStore.setState({ on: false }));
    for (const r of radios()) {
      expect(r.getAttribute("title")).toBeNull();
      expect(r.hasAttribute("aria-keyshortcuts")).toBe(false);
    }
  });

  test("no baseline: Swipe to Diff are aria-disabled and say why, a click does nothing, and the arrows skip them", async () => {
    mount({ hasBaseline: false });
    await flush();
    for (const [mode, , , label] of MODES.slice(1)) {
      const r = radio(label);
      expect(r.getAttribute("aria-disabled"), mode).toBe("true");
      expect(r.getAttribute("title"), mode).toBe("Needs a baseline");
      expect(r.hasAttribute("aria-keyshortcuts"), mode).toBe(false);
      act(() => r.click());
    }
    expect(radio("Side by side").hasAttribute("aria-disabled")).toBe(false);
    expect(checked()).toBe("side-by-side");
    expect(nav.router.replace).not.toHaveBeenCalled();

    act(() => radio("Side by side").focus());
    for (const key of ["ArrowRight", "ArrowLeft", "End", "Home"]) {
      pressOnFocus(key);
      expect(checked(), key).toBe("side-by-side");
      expect(document.activeElement, key).toBe(radio("Side by side"));
    }
    expect(stored()).toBe("side-by-side");
  });
});

describe("the label on the canvas (spec §4.1, §8, R18)", () => {
  test.each([
    ["side-by-side", ["Baseline", "Current"]],
    ["swipe", ["Baseline | Current"]],
    ["flicker", ["Baseline"]],
    ["overlay", ["Current over baseline"]],
    ["diff", ["Current"]],
  ] as const)("%s: %j", async (mode, labels) => {
    prefer(mode);
    mount();
    await flush();
    expect(canvasLabels()).toEqual(labels);
  });

  test("in Flicker it names the frame on screen, swap by swap", async () => {
    prefer("flicker");
    mount();
    await flush();
    press("f"); // pause, on the baseline
    expect(canvasLabels()).toEqual(["Baseline"]);
    press("f");
    expect(canvasLabels()).toEqual(["Current"]);
    press("f");
    expect(canvasLabels()).toEqual(["Baseline"]);
  });

  test("no baseline: pane A says so, pane B is the current screenshot", async () => {
    mount({ hasBaseline: false });
    await flush();
    expect(canvasLabels()).toEqual(["No baseline", "Current"]);
  });

  test.each(VIEWER_MODES)(
    "%s: every label lies over its card's top-left, out of the flow, and lets the pointer through",
    async (mode) => {
      prefer(mode);
      mount();
      await flush();
      const labels = screen.getAllByTestId("canvas-mode-label");
      expect(labels.length).toBeGreaterThan(0);
      for (const label of labels) {
        expect(label.className.split(" ")).toEqual(
          expect.arrayContaining([
            "absolute",
            "pointer-events-none",
            "left-3",
            "top-3",
          ]),
        );
        // Beside its canvas host, in the card's wrapper.
        const card = label.parentElement!;
        expect(
          card.querySelector(
            ":scope > [data-testid$=canvas-host], :scope > [data-testid=single-stage-host]",
          ),
        ).not.toBeNull();
      }
    },
  );
});

describe("the ignore-region editor in Swipe and Flicker (spec §4.4, R3)", () => {
  test.each(["swipe", "flicker"] as const)(
    "I in %s: side by side with the editor on; Esc brings it back; the preference and the URL never change",
    async (mode) => {
      prefer(mode);
      mount();
      await flush();
      expect(shownMode()).toBe(mode);

      press("i");
      await flush();
      expect(editing()).toBe(true);
      expect(shownMode()).toBe("side-by-side");
      expect(checked()).toBe("side-by-side");
      expect(canvasLabels()).toEqual(["Baseline", "Current"]);
      expect(screen.getByTestId("ignore-region-overlay")).toBeDefined();
      expect(stored()).toBe(mode);

      press("Escape");
      await flush();
      expect(editing()).toBe(false);
      expect(shownMode()).toBe(mode);
      expect(checked()).toBe(mode);
      expect(stored()).toBe(mode);
      expect(nav.router.replace).not.toHaveBeenCalled();
    },
  );

  test("I and Done leave it too", async () => {
    prefer("swipe");
    mount();
    await flush();
    press("i");
    expect(shownMode()).toBe("side-by-side");
    press("i");
    expect(editing()).toBe(false);
    expect(shownMode()).toBe("swipe");

    fireEvent.click(screen.getByTestId("edit-regions-toggle")); // Edit regions
    expect(editing()).toBe(true);
    expect(shownMode()).toBe("side-by-side");
    fireEvent.click(screen.getByTestId("edit-regions-toggle")); // Done editing
    expect(editing()).toBe(false);
    expect(shownMode()).toBe("swipe");
    expect(stored()).toBe("swipe");
    expect(nav.router.replace).not.toHaveBeenCalled();
  });

  test("the editor shows side by side over the URL's Swipe too, and never writes the URL", async () => {
    prefer("overlay");
    mount({ urlView: "swipe" });
    await flush();
    expect(shownMode()).toBe("swipe");
    press("i");
    expect(shownMode()).toBe("side-by-side");
    press("Escape");
    expect(shownMode()).toBe("swipe");
    expect(stored()).toBe("overlay");
    expect(nav.router.replace).not.toHaveBeenCalled();
  });

  test.each(["side-by-side", "overlay", "diff"] as const)(
    "in %s, the editor draws where it is: the mode stays",
    async (mode) => {
      prefer(mode);
      mount();
      await flush();
      press("i");
      await flush();
      expect(shownMode()).toBe(mode);
      expect(screen.getByTestId("ignore-region-overlay")).toBeDefined();
      press("Escape");
      expect(shownMode()).toBe(mode);
    },
  );

  test("a mode chosen in the editor shows at once, and stays when it closes", async () => {
    prefer("swipe");
    mount();
    await flush();
    press("i");
    press("4");
    expect(shownMode()).toBe("overlay");
    expect(checked()).toBe("overlay");
    press("Escape");
    expect(shownMode()).toBe("overlay");
    expect(stored()).toBe("overlay");
  });

  test("Swipe or Flicker chosen in the editor waits for it to close", async () => {
    prefer("overlay");
    mount();
    await flush();
    press("i");
    press("2");
    expect(shownMode()).toBe("side-by-side");
    expect(stored()).toBe("swipe");
    press("Escape");
    expect(shownMode()).toBe("swipe");
  });

  test("Swipe chosen in the editor never reaches the canvas, not for one render", async () => {
    prefer("overlay");
    mount();
    await flush();
    press("i");
    const host = screen.getByTestId("single-stage-host");
    // Every mode the single stage left from here on: each change records
    // the value it replaced. (Side by side then reuses its node, without
    // the attribute.)
    const left: Array<string | null> = [];
    const record = (records: MutationRecord[]) => {
      for (const r of records) left.push(r.oldValue);
    };
    const observer = new MutationObserver(record);
    observer.observe(host, {
      attributes: true,
      attributeFilter: ["data-mode"],
      attributeOldValue: true,
    });
    press("2");
    await flush();
    record(observer.takeRecords());
    observer.disconnect();
    // Overlay, straight to side by side: never Swipe in between.
    const seen = left.filter((mode) => mode !== "overlay");
    expect(seen).toEqual([]);
    expect(shownMode()).toBe("side-by-side");
  });

  test("o in the editor skips Swipe and Flicker, which it can't draw on", async () => {
    mount();
    await flush();
    press("i");
    const seen: Array<string | null> = [];
    for (let i = 0; i < 3; i += 1) {
      press("o");
      seen.push(shownMode());
    }
    expect(seen).toEqual(["overlay", "diff", "side-by-side"]);
  });

  test("the override goes with the viewer: unmounted, it pins nothing", async () => {
    prefer("swipe");
    const r = mount();
    await flush();
    press("i");
    expect(readEffectiveMode(null, true)).toBe("side-by-side");
    r.unmount();
    // The editor is still open (its own lifecycle), but no viewer holds the
    // override: the URL's view and the preference decide again.
    expect(editing()).toBe(true);
    expect(readEffectiveMode(null, true)).toBe("swipe");
    expect(readEffectiveMode("overlay", true)).toBe("overlay");
  });

  test("a step change clears it; the next step applies the rule afresh", async () => {
    prefer("swipe");
    const r = mount({ step: "c1" });
    await flush();
    press("i");
    expect(readEffectiveMode(null, true)).toBe("side-by-side");
    // A step with no baseline shows side by side on its own: no override.
    r.rerenderWith({ step: "c2", hasBaseline: false });
    await flush();
    expect(readEffectiveMode(null, true)).toBe("swipe");
    // On a step with a baseline, the editor still open: side by side again.
    r.rerenderWith({ step: "c3" });
    await flush();
    expect(shownMode()).toBe("side-by-side");
    press("Escape");
    expect(shownMode()).toBe("swipe");
    expect(stored()).toBe("swipe");
  });
});
