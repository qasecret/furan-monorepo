import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { useEffect, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { fake } from "./pixi-fake";
import { createBackend, TrpcBackend } from "./trpc-backend";

const { pushMock } = vi.hoisted(() => ({ pushMock: vi.fn() }));
vi.mock("pixi.js/unsafe-eval", () => ({}));
vi.mock("pixi.js", async () => (await import("./pixi-fake")).pixiModule);
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn() }),
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

import { CurrentProjectProvider } from "@/app/(protected)/_components/current-project-provider";
import { CommandPalette } from "@/components/cmdk/command-palette";
import { usePaletteStore } from "@/components/cmdk/use-command-palette";
import {
  FLICKER_INTERVAL_MS,
  FlickerControls,
  useFlickerTimer,
} from "@/components/diff-viewer/FlickerControls";
import type {
  ImageRole,
  ImageSetRequest,
  ImageSetState,
  LoadedImage,
} from "@/components/diff-viewer/image-set";
import type { DiffRegion } from "@/components/diff-viewer/layers/regionTypes";
import { RENDERERS } from "@/components/diff-viewer/modes/types";
import { useDiffViewerShortcuts } from "@/components/diff-viewer/useDiffViewerShortcuts";
import { useReducedMotion } from "@/components/diff-viewer/useReducedMotion";
import { useViewerStore } from "@/components/diff-viewer/useViewerStore";
import {
  useViewState,
  type FlickerFrame,
} from "@/components/diff-viewer/view-state";
import {
  DEFAULT_VIEWER_PREFS,
  useViewerPrefs,
  type ViewerMode,
} from "@/components/diff-viewer/viewer-prefs";
import { ViewerStage } from "@/components/diff-viewer/ViewerStage";
import { ShortcutsSheet } from "@/components/shortcuts/shortcuts-sheet";
import { useShortcutsSheet } from "@/components/shortcuts/use-shortcuts-sheet";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CommandDispatcher } from "@/lib/commands/dispatcher";
import { GlobalCommands } from "@/lib/commands/global-commands";
import { useSingleKeyStore } from "@/lib/commands/prefs";
import {
  CommandRoleProvider,
  resolveCommands,
  useCommandRegistry,
} from "@/lib/commands/registry";

/**
 * Flicker (spec §4.3): baseline and current alternate in place every 500 ms,
 * 2 swaps a second, under WCAG 2.3.1's 3 flashes. It never animates under
 * reduced motion, and pauses while the page is hidden, in the ignore-region
 * editor and under a dialog. `f` pauses it, then swaps by hand; only a swap
 * by hand is announced. The regions and the ignore regions stay on both
 * frames (R17).
 */

type Box = InstanceType<typeof fake.Box>;
type Sprite = InstanceType<typeof fake.Sprite>;

let counter = 0;
/** A key no other test uses: the image loader's cache is module-wide. */
const k = (name: string): string => `fl${counter}-${name}`;

function loaded(name: string, w: number, h: number): LoadedImage {
  const key = k(name);
  const bitmap = { width: w, height: h, close: vi.fn() };
  return { key, bitmap: bitmap as unknown as ImageBitmap, size: { w, h } };
}

/** A settled image set, and the request it answers. */
function step(
  images: Partial<Record<ImageRole, LoadedImage>>,
  status: ImageSetState["status"] = "ready",
): { set: ImageSetState; request: ImageSetRequest } {
  return {
    set: { status, images, failed: {}, retry: () => {} },
    request: {
      baseline: images.baseline?.key ?? null,
      current: images.current?.key ?? null,
      diff: images.diff?.key ?? null,
    },
  };
}

const flickerStep = (
  baseline: [number, number] = [400, 300],
  current: [number, number] = [400, 300],
) =>
  step({
    baseline: loaded("b", ...baseline),
    current: loaded("c", ...current),
  });

const REGIONS: DiffRegion[] = [
  {
    id: "r1",
    severity: "major",
    category: "visual",
    bbox: { x: 10, y: 10, width: 20, height: 20 },
    description: "A change",
    source: "l1_pixel",
  },
];

/**
 * Let pixi's init, promise chains and React effects run to a standstill. A
 * real macrotask (setImmediate, never faked here), so it works under the
 * fake clock too.
 */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setImmediate(r));
  });
}

/**
 * The flicker's clock: the timers, Date and `performance` are faked, so the
 * clock's timeouts and its `performance.now()` floor move together.
 * setImmediate stays real, for `flush`. Nothing else here sets a timer, so
 * `vi.getTimerCount()` counts the flicker's.
 */
function fakeClock(): void {
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "Date",
      "performance",
    ],
  });
}

function tick(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

/** Every flicker frame change from now on, with the (fake) time it was made. */
const watching: Array<() => void> = [];
function recordSwaps(): Array<{ at: number; frame: FlickerFrame }> {
  const swaps: Array<{ at: number; frame: FlickerFrame }> = [];
  watching.push(
    useViewState.subscribe((s, prev) => {
      if (s.flickerFrame !== prev.flickerFrame) {
        swaps.push({ at: Date.now(), frame: s.flickerFrame });
      }
    }),
  );
  return swaps;
}

const view = () => useViewState.getState();

function setMode(mode: ViewerMode): void {
  act(() => useViewerPrefs.setState((s) => ({ prefs: { ...s.prefs, mode } })));
}

/** The world container drawn in the single stage. */
function stageWorld(): Box {
  const app = fake.registry.apps.find(
    (a) =>
      !a.destroyed &&
      a.canvas.parentElement?.getAttribute("data-testid") ===
        "single-stage-host",
  );
  if (!app) throw new Error("no live pixi app in the single stage");
  return app.stage.children[0] as Box;
}

const labels = (box: Box): string[] => box.children.map((c) => c.label);

function child(box: Box, label: string): Box {
  const found = box.children.find((c) => c.label === label);
  if (!found) throw new Error(`no ${label} in ${box.label}`);
  return found as Box;
}

/** The labels of the children of `layer` that are drawn. */
const visibleIn = (layer: Box): string[] =>
  layer.children.filter((c) => c.visible).map((c) => c.label);

/** The bitmap the frame shows: its one visible sprite's. */
function shownBitmap(world: Box): unknown {
  const frame = child(world, "frame");
  const shown = frame.children.filter((c) => c.visible);
  expect(shown).toHaveLength(1);
  return (shown[0] as Sprite).texture.bitmap;
}

/** The hatching's tooltips' titles. */
const tooltipTitles = () =>
  screen.queryAllByTestId("hatch-tooltip").map((el) => el.title);

/** The flicker's polite live region. */
const status = () => screen.getByTestId("flicker-status");

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

/**
 * `prefers-reduced-motion`, as the page reads it (`matchMedia`), with a live
 * `change` the test sends.
 */
function reducedMotion(initial: boolean): { set(on: boolean): void } {
  const listeners = new Set<(e: MediaQueryListEvent) => void>();
  const query = {
    matches: initial,
    media: "(prefers-reduced-motion: reduce)",
    addEventListener: (_: string, l: (e: MediaQueryListEvent) => void) =>
      listeners.add(l),
    removeEventListener: (_: string, l: (e: MediaQueryListEvent) => void) =>
      listeners.delete(l),
  };
  vi.stubGlobal("matchMedia", (q: string) =>
    q === query.media
      ? query
      : {
          matches: false,
          media: q,
          addEventListener: () => {},
          removeEventListener: () => {},
        },
  );
  return {
    set(on) {
      query.matches = on;
      act(() => {
        for (const l of listeners) l({ matches: on } as MediaQueryListEvent);
      });
    },
  };
}

/** The page's visibility, as the browser reports it, and its event. */
function setVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

/** The viewer's keys on the protected layout's one dispatcher. */
function Keyboard({ children }: { children?: ReactNode }) {
  return (
    <CommandRoleProvider role="editor">
      <CommandDispatcher />
      {children}
    </CommandRoleProvider>
  );
}

/** The viewer's commands, registered as the viewer does. */
function Commands({ hasBaseline = true }: { hasBaseline?: boolean }) {
  useDiffViewerShortcuts({ viewports: [], hasBaseline });
  return null;
}

/** The stage with the viewer's keys. */
function Viewer({
  set,
  request,
  regions = [],
}: {
  set: ImageSetState;
  request: ImageSetRequest;
  regions?: DiffRegion[];
}) {
  return (
    <Keyboard>
      <Commands hasBaseline={request.baseline !== null} />
      <ViewerStage set={set} request={request} regions={regions} />
    </Keyboard>
  );
}

/** The flicker's timer on its own, active, with reduced motion as the page reads it. */
function Timer({ active = true }: { active?: boolean }) {
  const reduced = useReducedMotion();
  useFlickerTimer({ active, reducedMotion: reduced });
  return null;
}

beforeEach(() => {
  counter += 1;
  fake.registry.apps.length = 0;
  fake.registry.created.length = 0;
  fake.registry.holdInit = false;
  fake.registry.textures.length = 0;
  fake.registry.sprites.length = 0;
  fake.registry.uploaded.length = 0;
  fake.registry.maxTextureSize = null;
  useViewerPrefs.setState({
    userId: null,
    prefs: { ...DEFAULT_VIEWER_PREFS, mode: "flicker" },
    previousMode: "side-by-side",
  });
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
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  for (const off of watching.splice(0)) off();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (document as { visibilityState?: string }).visibilityState;
  document.body.innerHTML = "";
});

describe("Flicker draws as flicker", () => {
  test("its own renderer, on one stage, needing both images", () => {
    expect(RENDERERS.flicker).not.toBe(RENDERERS["side-by-side"]);
    expect(RENDERERS.flicker.panes).toBe(1);
    expect(RENDERERS.flicker.needs({ hasBaseline: true })).toEqual([
      "baseline",
      "current",
    ]);
    expect(RENDERERS.flicker.draws).toEqual(["baseline", "current"]);
    // It hatches the frame it shows, and only that one (R17).
    expect(RENDERERS.flicker.hatched({ flickerFrame: "baseline" })).toEqual([
      ["baseline"],
    ]);
    expect(RENDERERS.flicker.hatched({ flickerFrame: "current" })).toEqual([
      ["current"],
    ]);
  });

  test("its layers, bottom to top: the frame, its hatching, the regions, the ignore regions", async () => {
    const { set, request } = flickerStep();
    const r = render(
      <ViewerStage set={set} request={request} regions={REGIONS} />,
    );
    await flush();

    expect(r.getByTestId("single-stage-host").dataset.mode).toBe("flicker");
    const world = stageWorld();
    expect(labels(world)).toEqual([
      "frame",
      "hatch:frame",
      "regions",
      "ignore",
    ]);
    // The frame holds both images, the baseline shown first.
    expect(labels(child(world, "frame"))).toEqual([
      "frame:baseline",
      "frame:current",
    ]);
    expect(visibleIn(child(world, "frame"))).toEqual(["frame:baseline"]);
    expect(shownBitmap(world)).toBe(set.images.baseline!.bitmap);
    expect(fake.registry.sprites).toHaveLength(2);
  });
});

describe("the flicker on the stage", () => {
  test("starts on the baseline, then swaps every 500 ms: 6 in 3 s, never more than 2 in any second", async () => {
    fakeClock();
    const { set, request } = flickerStep();
    render(<ViewerStage set={set} request={request} regions={[]} />);
    await flush();
    const world = stageWorld();
    expect(FLICKER_INTERVAL_MS).toBe(500);
    expect(view().flickerFrame).toBe("baseline");
    expect(shownBitmap(world)).toBe(set.images.baseline!.bitmap);

    const start = Date.now();
    const swaps = recordSwaps();
    for (let t = 0; t < 3000; t += 50) tick(50);

    expect(swaps.map((s) => s.at - start)).toEqual([
      500, 1000, 1500, 2000, 2500, 3000,
    ]);
    // At most 2 in any 1000 ms window: any 3 swaps span a second or more.
    for (let i = 2; i < swaps.length; i++) {
      expect(swaps[i]!.at - swaps[i - 2]!.at).toBeGreaterThanOrEqual(1000);
    }
    expect(swaps.map((s) => s.frame)).toEqual([
      "current",
      "baseline",
      "current",
      "baseline",
      "current",
      "baseline",
    ]);
  });

  test("a swap shows the other bitmap on the mounted sprites: no remount, no new texture", async () => {
    fakeClock();
    const mount = vi.spyOn(RENDERERS.flicker, "mount");
    const { set, request } = flickerStep();
    render(<ViewerStage set={set} request={request} regions={[]} />);
    await flush();
    const world = stageWorld();
    const frame = child(world, "frame");
    const sprites = frame.children.slice();

    tick(500);
    expect(view().flickerFrame).toBe("current");
    expect(shownBitmap(world)).toBe(set.images.current!.bitmap);
    expect(visibleIn(frame)).toEqual(["frame:current"]);
    tick(500);
    expect(shownBitmap(world)).toBe(set.images.baseline!.bitmap);

    expect(mount).toHaveBeenCalledOnce();
    expect(child(world, "frame")).toBe(frame);
    expect(frame.children).toEqual(sprites);
    expect(sprites.every((s) => !s.destroyed)).toBe(true);
    expect(fake.registry.textures).toHaveLength(2);
  });

  test("both images go onto the GPU as Flicker mounts, the hidden one too: the first swap never waits on an upload", async () => {
    fakeClock();
    const { set, request } = flickerStep();
    render(<ViewerStage set={set} request={request} regions={[]} />);
    await flush();
    const frame = child(stageWorld(), "frame");
    // The current frame is hidden, and already uploaded, before any swap.
    expect(visibleIn(frame)).toEqual(["frame:baseline"]);
    const sources = frame.children.map((s) => (s as Sprite).texture.source);
    expect(fake.registry.uploaded).toEqual(expect.arrayContaining(sources));
    expect(view().flickerFrame).toBe("baseline");
  });

  test("a new step starts on the baseline for a full 500 ms, its images already cached (I1)", async () => {
    fakeClock();
    const first = flickerStep();
    const r = render(
      <ViewerStage set={first.set} request={first.request} regions={[]} />,
    );
    await flush();
    tick(400);
    expect(view().flickerFrame).toBe("baseline");

    // The next step, its images already in (no load, so the stage never
    // drops): the viewer resets the view, the frame stays the baseline.
    counter += 1;
    const next = flickerStep();
    act(() => view().resetView({ reducedMotion: false }));
    r.rerender(
      <ViewerStage set={next.set} request={next.request} regions={[]} />,
    );
    await flush();
    tick(100);
    expect(view().flickerFrame).toBe("baseline");
    expect(shownBitmap(stageWorld())).toBe(next.set.images.baseline!.bitmap);
    tick(399);
    expect(view().flickerFrame).toBe("baseline");
    tick(1);
    expect(view().flickerFrame).toBe("current");
  });

  test("a reset from the current frame (a viewport switch) shows the baseline for a full 500 ms too", async () => {
    fakeClock();
    const { set, request } = flickerStep();
    render(<ViewerStage set={set} request={request} regions={[]} />);
    await flush();
    tick(500);
    expect(view().flickerFrame).toBe("current");
    tick(400);
    act(() => view().resetView({ reducedMotion: false }));
    expect(view().flickerFrame).toBe("baseline");
    tick(100);
    expect(view().flickerFrame).toBe("baseline");
    tick(400);
    expect(view().flickerFrame).toBe("current");
  });

  test("the regions and the ignore regions stay on both frames; only the image and its hatching swap (R17)", async () => {
    fakeClock();
    useViewerStore.setState({
      savedRunIgnoreAreas: [
        {
          id: "ig1",
          x: 5,
          y: 5,
          width: 10,
          height: 10,
          viewport: "",
          paddingPx: 0,
          kind: "ignore",
        },
      ],
    });
    const { set, request } = flickerStep();
    render(<ViewerStage set={set} request={request} regions={REGIONS} />);
    await flush();
    const world = stageWorld();
    const regions = child(world, "regions");
    const ignore = child(world, "ignore");

    for (const frame of ["current", "baseline", "current"] as const) {
      tick(500);
      expect(view().flickerFrame).toBe(frame);
      expect(child(world, "regions")).toBe(regions);
      expect(child(world, "ignore")).toBe(ignore);
      expect(regions.destroyed || ignore.destroyed).toBe(false);
      expect(regions.visible && ignore.visible).toBe(true);
      expect(labels(world)).toEqual([
        "frame",
        "hatch:frame",
        "regions",
        "ignore",
      ]);
    }
  });

  test("the hatching and its tooltips follow the frame: each image's missing area, only while it shows (R17)", async () => {
    fakeClock();
    // The baseline is shorter, the current narrower: each misses an area.
    const { set, request } = flickerStep([400, 200], [300, 300]);
    render(<ViewerStage set={set} request={request} regions={[]} />);
    await flush();
    const hatch = child(stageWorld(), "hatch:frame");
    expect(labels(hatch)).toEqual(["hatch:baseline", "hatch:current"]);

    expect(visibleIn(hatch)).toEqual(["hatch:baseline"]);
    expect(tooltipTitles()).toEqual(["Not in the baseline"]);

    tick(500);
    expect(visibleIn(hatch)).toEqual(["hatch:current"]);
    expect(tooltipTitles()).toEqual(["Not in the current screenshot"]);

    tick(500);
    expect(visibleIn(hatch)).toEqual(["hatch:baseline"]);
    expect(tooltipTitles()).toEqual(["Not in the baseline"]);
  });

  test("the canvas label names the frame on screen", async () => {
    fakeClock();
    const { set, request } = flickerStep();
    render(<ViewerStage set={set} request={request} regions={[]} />);
    await flush();
    const label = screen.getByTestId("canvas-mode-label");
    expect(label.textContent).toBe("Baseline");
    tick(500);
    expect(label.textContent).toBe("Current");
    tick(500);
    expect(label.textContent).toBe("Baseline");

    // Not a live region: it changes on every swap and says nothing.
    expect(label.closest("[aria-live],[role=status]")).toBeNull();
  });

  test("the label sits on the canvas, over the card's top-left: nothing moves the card, in Flicker or out of it (R18)", async () => {
    const { set, request } = flickerStep();
    render(<ViewerStage set={set} request={request} regions={[]} />);
    await flush();
    const host = screen.getByTestId("single-stage-host");
    const card = host.parentElement!;
    const root = card.parentElement!;
    const label = screen.getByTestId("canvas-mode-label");

    // Over the card, in the wrapper it shares with the stage's states, out
    // of the flow, letting the pointer through.
    expect(label.parentElement).toBe(card);
    expect(label.className.split(" ")).toEqual(
      expect.arrayContaining([
        "absolute",
        "pointer-events-none",
        "left-3",
        "top-3",
      ]),
    );
    // The card is the wrapper's one child in the flow, and the wrapper the
    // root's: no row above the card, no column wrapper around it.
    const inFlow = (el: Element) =>
      [...el.children].filter(
        (c) => !/\b(absolute|sr-only)\b/.test(c.className),
      );
    expect(inFlow(card)).toEqual([host]);
    expect(inFlow(root)).toEqual([card]);
    expect(card.className.split(" ")).toEqual(
      expect.arrayContaining(["relative", "m-auto", "w-full"]),
    );
    expect(card.className).not.toMatch(/\b(flex|flex-col|gap-\d)\b/);

    // Out of Flicker the card is where it was: the same nodes, the same
    // flow, only the label gone.
    setMode("overlay");
    await flush();
    expect(screen.getByTestId("single-stage-host")).toBe(host);
    expect(host.parentElement).toBe(card);
    expect(card.parentElement).toBe(root);
    expect(inFlow(card)).toEqual([host]);
    expect(inFlow(root)).toEqual([card]);
    expect(screen.queryByTestId("canvas-mode-label")).toBeNull();
    setMode("flicker");
    await flush();
    expect(screen.getByTestId("single-stage-host")).toBe(host);
    expect(screen.getByTestId("canvas-mode-label").parentElement).toBe(card);
  });

  test("no swap before the images are in: the first frame drawn is the baseline", async () => {
    fakeClock();
    const images = flickerStep();
    const r = render(
      <ViewerStage
        set={{ ...images.set, status: "loading", images: {} }}
        request={images.request}
        regions={[]}
      />,
    );
    await flush();
    tick(2000);
    expect(view().flickerFrame).toBe("baseline");
    expect(vi.getTimerCount()).toBe(0);

    r.rerender(
      <ViewerStage set={images.set} request={images.request} regions={[]} />,
    );
    await flush();
    expect(shownBitmap(stageWorld())).toBe(images.set.images.baseline!.bitmap);
    tick(500);
    expect(view().flickerFrame).toBe("current");
  });

  test("leaving Flicker takes its layers with it and stops the timer", async () => {
    fakeClock();
    const { set, request } = flickerStep();
    render(<ViewerStage set={set} request={request} regions={REGIONS} />);
    await flush();
    const world = stageWorld();
    const frame = child(world, "frame");
    const hatch = child(world, "hatch:frame");
    expect(vi.getTimerCount()).toBe(1);

    setMode("overlay");
    await flush();
    expect(frame.destroyed && hatch.destroyed).toBe(true);
    expect(labels(world)).toEqual([
      "baseline",
      "current",
      "hatch:baseline",
      "hatch:current",
      "regions",
      "ignore",
    ]);
    expect(screen.queryByTestId("canvas-mode-label")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    const before = view().flickerFrame;
    tick(2000);
    expect(view().flickerFrame).toBe(before);
  });
});

describe("the flicker's timer", () => {
  test("swaps only while active, and holds the frame it is left on", () => {
    fakeClock();
    const r = render(<Timer active={false} />);
    tick(2000);
    expect(view().flickerFrame).toBe("baseline");
    expect(vi.getTimerCount()).toBe(0);

    r.rerender(<Timer active />);
    tick(500);
    expect(view().flickerFrame).toBe("current");
    r.rerender(<Timer active={false} />);
    tick(2000);
    expect(view().flickerFrame).toBe("current");
  });

  test("each swap is due on the clock: a timeout that fires before 500 ms have passed waits for the rest (the floor)", () => {
    fakeClock();
    // A performance clock that falls 100 ms behind the timers from now on:
    // the timeout fires when only 400 ms have passed on it.
    const clock = performance.now.bind(performance);
    let lag = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock() - lag);
    render(<Timer />);
    lag = 100;
    tick(500);
    expect(view().flickerFrame).toBe("baseline");
    tick(99);
    expect(view().flickerFrame).toBe("baseline");
    tick(1);
    expect(view().flickerFrame).toBe("current");
  });

  test("under reduced motion there is no timer, and the flicker is paused", () => {
    fakeClock();
    reducedMotion(true);
    // The timers pending after the hook's effects, at every commit: not
    // even for one render is an interval started.
    const pending: number[] = [];
    function Probe() {
      useEffect(() => {
        pending.push(vi.getTimerCount());
      });
      return null;
    }
    render(
      <>
        <Timer />
        <Probe />
      </>,
    );
    expect(pending.length).toBeGreaterThan(0);
    expect(pending.every((n) => n === 0)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    tick(3000);
    expect(view()).toMatchObject({
      flickerFrame: "baseline",
      flickerPlaying: false,
    });
  });

  test("a live change to reduced motion stops a running timer, on the frame it shows", () => {
    fakeClock();
    const motion = reducedMotion(false);
    render(<Timer />);
    tick(500);
    expect(view().flickerFrame).toBe("current");
    expect(vi.getTimerCount()).toBe(1);

    motion.set(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(view()).toMatchObject({
      flickerFrame: "current",
      flickerPlaying: false,
    });
    tick(3000);
    expect(view().flickerFrame).toBe("current");
  });

  test("paused, nothing swaps; played again, it swaps", () => {
    fakeClock();
    render(<Timer />);
    act(() => view().setFlicker("baseline", false));
    expect(vi.getTimerCount()).toBe(0);
    tick(2000);
    expect(view().flickerFrame).toBe("baseline");
    act(() => view().setFlicker("baseline", true));
    tick(500);
    expect(view().flickerFrame).toBe("current");
  });

  test("it stops while the page is hidden, and resumes when it is shown", () => {
    fakeClock();
    render(<Timer />);
    tick(500);
    expect(view().flickerFrame).toBe("current");

    setVisibility("hidden");
    expect(vi.getTimerCount()).toBe(0);
    tick(3000);
    expect(view().flickerFrame).toBe("current");

    setVisibility("visible");
    expect(vi.getTimerCount()).toBe(1);
    tick(500);
    expect(view().flickerFrame).toBe("baseline");
  });

  test("it stops in the ignore-region editor, and resumes after", () => {
    fakeClock();
    render(<Timer />);
    act(() => useViewerStore.setState({ ignoreEditMode: "variation" }));
    expect(vi.getTimerCount()).toBe(0);
    tick(3000);
    expect(view().flickerFrame).toBe("baseline");

    act(() => useViewerStore.setState({ ignoreEditMode: "off" }));
    tick(500);
    expect(view().flickerFrame).toBe("current");
  });

  test("it stops under a modal dialog (aria-modal), and resumes when it goes", async () => {
    fakeClock();
    render(<Timer />);
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    await act(async () => {
      document.body.append(dialog);
    });
    expect(vi.getTimerCount()).toBe(0);
    tick(3000);
    expect(view().flickerFrame).toBe("baseline");

    await act(async () => {
      dialog.remove();
    });
    expect(vi.getTimerCount()).toBe(1);
    tick(500);
    expect(view().flickerFrame).toBe("current");
  });

  test("it stops under the app's Radix dialogs (no aria-modal: data-state=open), and resumes when they close", async () => {
    fakeClock();
    function Over({ dialog }: { dialog: "none" | "dialog" | "alert" }) {
      return (
        <>
          <Timer />
          <Dialog open={dialog === "dialog"}>
            <DialogContent>
              <DialogTitle>Command palette</DialogTitle>
            </DialogContent>
          </Dialog>
          <AlertDialog open={dialog === "alert"}>
            <AlertDialogContent>
              <AlertDialogTitle>Approve pending?</AlertDialogTitle>
              <AlertDialogDescription>Sure?</AlertDialogDescription>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
            </AlertDialogContent>
          </AlertDialog>
        </>
      );
    }
    const r = render(<Over dialog="none" />);
    for (const dialog of ["dialog", "alert"] as const) {
      await act(async () => {
        r.rerender(<Over dialog={dialog} />);
      });
      expect(
        document.querySelector('[aria-modal="true"]'),
        "the app's dialogs don't mark themselves modal",
      ).toBeNull();
      const before = view().flickerFrame;
      // Radix's own zero-delay timeouts first; then none is the flicker's.
      tick(0);
      expect(vi.getTimerCount()).toBe(0);
      tick(3000);
      expect(view().flickerFrame).toBe(before);

      await act(async () => {
        r.rerender(<Over dialog="none" />);
      });
      tick(500);
      expect(view().flickerFrame).not.toBe(before);
    }
  });

  test("an open dropdown menu (role=menu, data-state=open) does not stop it", async () => {
    fakeClock();
    render(
      <>
        <Timer />
        <DropdownMenu open>
          <DropdownMenuTrigger>Sensitivity</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem>Strict</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </>,
    );
    await flush();
    // The premise: Radix marks the open menu as the dialogs are, but it is no
    // dialog.
    const menu = screen.getByRole("menu");
    expect(menu.getAttribute("data-state")).toBe("open");
    tick(500);
    expect(view().flickerFrame).toBe("current");
    tick(500);
    expect(view().flickerFrame).toBe("baseline");
  });

  test("an inline dialog that lays nothing over the page (the done card's kind) does not stop it", async () => {
    fakeClock();
    render(<Timer />);
    const card = document.createElement("div");
    card.setAttribute("role", "dialog");
    card.setAttribute("data-non-modal", "");
    await act(async () => {
      document.body.append(card);
    });
    tick(500);
    expect(view().flickerFrame).toBe("current");
  });
});

describe("f: Pause or swap flicker", () => {
  test("while playing, f pauses on the frame it shows; paused, each f swaps it", async () => {
    fakeClock();
    const { set, request } = flickerStep();
    render(<Viewer set={set} request={request} />);
    await flush();
    tick(500);
    expect(view()).toMatchObject({
      flickerFrame: "current",
      flickerPlaying: true,
    });

    expect(press("f").defaultPrevented).toBe(true);
    expect(view()).toMatchObject({
      flickerFrame: "current",
      flickerPlaying: false,
    });
    tick(2000);
    expect(view().flickerFrame).toBe("current");

    press("f");
    expect(view()).toMatchObject({
      flickerFrame: "baseline",
      flickerPlaying: false,
    });
    expect(shownBitmap(stageWorld())).toBe(set.images.baseline!.bitmap);
    press("f");
    expect(view()).toMatchObject({
      flickerFrame: "current",
      flickerPlaying: false,
    });
    expect(shownBitmap(stageWorld())).toBe(set.images.current!.bitmap);
  });

  test("a manual swap while paused says the frame in the polite status; an animated swap never touches it", async () => {
    fakeClock();
    const { set, request } = flickerStep();
    render(<Viewer set={set} request={request} />);
    await flush();
    const region = status();
    expect(region.getAttribute("role")).toBe("status");
    expect(region.textContent).toBe("");

    // The region's DOM, watched: an animated swap must not change it at all.
    const changes: MutationRecord[] = [];
    const observer = new MutationObserver((m) => changes.push(...m));
    observer.observe(region, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    tick(1500);
    await act(async () => {});
    expect(view().flickerFrame).toBe("current");
    expect(changes).toEqual([]);

    // Pausing is not a swap: nothing to say.
    press("f");
    expect(region.textContent).toBe("");
    press("f");
    expect(region.textContent).toBe("Showing baseline");
    press("f");
    expect(region.textContent).toBe("Showing current");

    // Played again, the region empties (so the next manual swap is news),
    // and the animated swaps leave it alone.
    act(() => view().setFlicker(view().flickerFrame, true));
    expect(region.textContent).toBe("");
    await act(async () => {});
    changes.length = 0;
    tick(500);
    await act(async () => {});
    expect(view().flickerFrame).toBe("baseline");
    expect(changes).toEqual([]);
    observer.disconnect();

    // The next manual swap is said, even when it names the frame said last.
    press("f");
    expect(region.textContent).toBe("");
    press("f");
    expect(region.textContent).toBe("Showing current");
    press("f");
    expect(region.textContent).toBe("Showing baseline");
  });

  test("under reduced motion the stage holds the baseline, f swaps it and says so", async () => {
    fakeClock();
    reducedMotion(true);
    act(() => view().resetView({ reducedMotion: true }));
    const { set, request } = flickerStep();
    render(<Viewer set={set} request={request} />);
    await flush();
    tick(3000);
    expect(view().flickerFrame).toBe("baseline");
    expect(screen.getByTestId("canvas-mode-label").textContent).toBe(
      "Baseline",
    );

    press("f");
    expect(view()).toMatchObject({
      flickerFrame: "current",
      flickerPlaying: false,
    });
    expect(status().textContent).toBe("Showing current");
    expect(screen.getByTestId("canvas-mode-label").textContent).toBe("Current");
    press("f");
    expect(status().textContent).toBe("Showing baseline");
  });

  test("leaving Flicker forgets a hand swap: back in Flicker, nothing is said until the next one", async () => {
    fakeClock();
    const { set, request } = flickerStep();
    render(<Viewer set={set} request={request} />);
    await flush();
    press("f");
    press("f");
    expect(status().textContent).toBe("Showing current");

    setMode("overlay");
    await flush();
    expect(status().textContent).toBe("");
    setMode("flicker");
    await flush();
    expect(status().textContent).toBe("");
    press("f");
    expect(status().textContent).toBe("Showing baseline");
  });

  test("outside Flicker, f is disabled: the key is left to the page", async () => {
    setMode("side-by-side");
    const { set, request } = flickerStep();
    render(<Viewer set={set} request={request} />);
    await flush();
    const before = { ...view() };
    expect(press("f").defaultPrevented).toBe(false);
    expect(view()).toMatchObject({
      flickerFrame: before.flickerFrame,
      flickerPlaying: before.flickerPlaying,
    });
    const command = resolveCommands().find(
      (c) => c.command.id === "viewer.flicker.toggle",
    );
    expect(command?.command.enabled?.(command.ctx())).toBe(false);
  });

  test("a stored Flicker on a step with no baseline draws side by side, and f is disabled there (R2)", async () => {
    const { set, request } = step({ current: loaded("c", 100, 100) });
    render(<Viewer set={set} request={request} />);
    await flush();
    expect(screen.queryByTestId("single-stage-host")).toBeNull();
    expect(press("f").defaultPrevented).toBe(false);
    expect(view().flickerPlaying).toBe(true);
  });

  test("with single-key shortcuts off, f does nothing", async () => {
    useSingleKeyStore.setState({ on: false });
    const { set, request } = flickerStep();
    render(<Viewer set={set} request={request} />);
    await flush();
    expect(press("f").defaultPrevented).toBe(false);
    expect(view().flickerPlaying).toBe(true);
  });
});

describe("Play / Pause", () => {
  function Controls() {
    return (
      <Keyboard>
        <Commands />
        <FlickerControls />
      </Keyboard>
    );
  }

  test("Pause pauses on the frame shown, Play plays; the Pause hint names f", () => {
    act(() => view().setFlicker("current", true));
    render(<Controls />);
    const pause = screen.getByRole("button", { name: "Pause" });
    expect(pause.getAttribute("title")).toBe("Pause (F)");
    expect(pause.getAttribute("aria-keyshortcuts")).toBe("F");

    fireEvent.click(pause);
    expect(view()).toMatchObject({
      flickerFrame: "current",
      flickerPlaying: false,
    });
    // `f` swaps while paused: it does not play, so Play names no key.
    const play = screen.getByRole("button", { name: "Play" });
    expect(play.getAttribute("aria-keyshortcuts")).toBeNull();
    fireEvent.click(play);
    expect(view()).toMatchObject({
      flickerFrame: "current",
      flickerPlaying: true,
    });
    expect(screen.getByRole("button", { name: "Pause" })).toBeDefined();
  });

  test("with single-key shortcuts off, Pause names no key", () => {
    useSingleKeyStore.setState({ on: false });
    render(<Controls />);
    const pause = screen.getByRole("button", { name: "Pause" });
    expect(pause.getAttribute("aria-keyshortcuts")).toBeNull();
    // Its name is on screen: no title to give.
    expect(pause.getAttribute("title")).toBeNull();
  });

  test("hidden under reduced motion, and gone on a live change to it", () => {
    const motion = reducedMotion(false);
    render(<Controls />);
    expect(screen.getByRole("button", { name: "Pause" })).toBeDefined();
    motion.set(true);
    expect(screen.queryByRole("button", { name: /^(Play|Pause)$/ })).toBeNull();
  });

  test("hidden under reduced motion from the start", () => {
    reducedMotion(true);
    render(<Controls />);
    expect(screen.queryByRole("button", { name: /^(Play|Pause)$/ })).toBeNull();
  });
});

describe("the command in the sheet and the palette", () => {
  test("the ? sheet lists Pause or swap flicker under the viewer's page, with F", () => {
    render(
      <CommandRoleProvider role="editor">
        <GlobalCommands />
        <Commands />
        <ShortcutsSheet />
      </CommandRoleProvider>,
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
    const row = within(page!)
      .getAllByRole("listitem")
      .find(
        (li) => li.firstElementChild?.textContent === "Pause or swap flicker",
      );
    expect(row).toBeDefined();
    expect(within(row!).getByText("F")).toBeDefined();
  });

  test("the sheet notes it is off with single-key shortcuts off", () => {
    useSingleKeyStore.setState({ on: false });
    render(
      <CommandRoleProvider role="editor">
        <Commands />
        <ShortcutsSheet />
      </CommandRoleProvider>,
    );
    act(() => useShortcutsSheet.getState().setOpen(true));
    const sheet = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
    const row = within(sheet)
      .getAllByRole("listitem")
      .find(
        (li) => li.firstElementChild?.textContent === "Pause or swap flicker",
      );
    expect(row?.textContent).toContain("(single-key shortcuts are off)");
  });

  describe("the palette", () => {
    const backend = createBackend();
    function Shell({ children }: { children?: ReactNode }) {
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
              <CommandPalette userRole="editor" userId="user-a" />
            </CurrentProjectProvider>
          </CommandRoleProvider>
        </TrpcBackend>
      );
    }
    async function actions(): Promise<HTMLElement[]> {
      act(() => usePaletteStore.getState().setOpen(true));
      const palette = await screen.findByTestId("command-palette");
      const group = within(palette).queryByRole("group", { name: "Actions" });
      return group ? within(group).queryAllByRole("option") : [];
    }
    const named = (options: HTMLElement[]) =>
      options.find(
        (o) => o.firstElementChild?.textContent === "Pause or swap flicker",
      );

    test("in Flicker it is an action, with F, and running it pauses the flicker", async () => {
      render(
        <Shell>
          <Commands />
        </Shell>,
      );
      const option = named(await actions());
      expect(option).toBeDefined();
      expect(option!.getAttribute("aria-keyshortcuts")).toBe("F");

      fireEvent.click(option!);
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
      expect(usePaletteStore.getState().open).toBe(false);
      expect(view()).toMatchObject({
        flickerFrame: "baseline",
        flickerPlaying: false,
      });
    });

    test("outside Flicker it is not an action", async () => {
      setMode("overlay");
      render(
        <Shell>
          <Commands />
        </Shell>,
      );
      expect(named(await actions())).toBeUndefined();
    });
  });
});
