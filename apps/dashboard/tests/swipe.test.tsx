import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useState, type ReactNode } from "react";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";

import { fake } from "./pixi-fake";

vi.mock("pixi.js/unsafe-eval", () => ({}));
vi.mock("pixi.js", async () => (await import("./pixi-fake")).pixiModule);

import { FALLBACK_CANVAS_DIVIDER } from "@/components/diff-viewer/canvas-theme";
import type {
  ImageRole,
  ImageSetRequest,
  ImageSetState,
  LoadedImage,
} from "@/components/diff-viewer/image-set";
import type { DiffRegion } from "@/components/diff-viewer/layers/regionTypes";
import { RENDERERS } from "@/components/diff-viewer/modes/types";
import { SwipeHandle } from "@/components/diff-viewer/SwipeHandle";
import { useDiffViewerShortcuts } from "@/components/diff-viewer/useDiffViewerShortcuts";
import { useViewerStore } from "@/components/diff-viewer/useViewerStore";
import { useViewState } from "@/components/diff-viewer/view-state";
import {
  canvasToWorld,
  transformFor,
  type Size,
} from "@/components/diff-viewer/viewer-geometry";
import {
  DEFAULT_VIEWER_PREFS,
  drawnMode,
  useViewerPrefs,
  type ViewerMode,
} from "@/components/diff-viewer/viewer-prefs";
import { ViewerStage } from "@/components/diff-viewer/ViewerStage";
import { CommandDispatcher } from "@/lib/commands/dispatcher";
import { CommandRoleProvider } from "@/lib/commands/registry";

/**
 * Swipe (spec §4.2): one stage, the baseline left of a vertical divider and
 * the current screenshot right of it. The divider is a fraction of the
 * canvas, so zoom, pan and resizes keep it where the reviewer put it; its
 * handle is a slider whose keys are its own.
 */

type Box = InstanceType<typeof fake.Box>;
type Graphics = InstanceType<typeof fake.Graphics>;

// jsdom lays nothing out: a host given a size here reports it (by test id),
// every other one reports 0, and the stage falls back to 800×600.
const VIEWPORT: Size = { w: 800, h: 600 };
const laidOut = new Map<string, Size>();
beforeAll(() => {
  for (const [prop, axis] of [
    ["clientWidth", "w"],
    ["clientHeight", "h"],
  ] as const) {
    Object.defineProperty(HTMLElement.prototype, prop, {
      configurable: true,
      get(this: HTMLElement) {
        return laidOut.get(this.dataset.testid ?? "")?.[axis] ?? 0;
      },
    });
  }
});
afterAll(() => {
  delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
  delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
});

/** Resize observers, fired by `resizeHost`. */
const observed: Array<{
  target: Element;
  observer: ResizeObserver;
  callback: ResizeObserverCallback;
}> = [];
class FakeResizeObserver {
  constructor(private callback: ResizeObserverCallback) {}
  observe(target: Element) {
    observed.push({
      target,
      observer: this as unknown as ResizeObserver,
      callback: this.callback,
    });
  }
  unobserve() {}
  disconnect() {
    for (let i = observed.length - 1; i >= 0; i--) {
      if (observed[i]!.observer === (this as unknown)) observed.splice(i, 1);
    }
  }
}
/** Gives a host a new size and tells its observers, as the browser would. */
function resizeHost(testId: string, w: number, h: number): void {
  laidOut.set(testId, { w, h });
  for (const o of observed.slice()) {
    if ((o.target as HTMLElement).dataset.testid === testId) {
      o.callback([], o.observer);
    }
  }
}

let counter = 0;
/** A key no other test uses: the image loader's cache is module-wide. */
const k = (name: string): string => `sw${counter}-${name}`;

function loaded(name: string, w: number, h: number): LoadedImage {
  const key = k(name);
  const bitmap = { width: w, height: h, close: vi.fn() };
  return { key, bitmap: bitmap as unknown as ImageBitmap, size: { w, h } };
}

/** A settled image set, and the request it answers. */
function step(images: Partial<Record<ImageRole, LoadedImage>>): {
  set: ImageSetState;
  request: ImageSetRequest;
} {
  return {
    set: { status: "ready", images, failed: {}, retry: () => {} },
    request: {
      baseline: images.baseline?.key ?? null,
      current: images.current?.key ?? null,
      diff: images.diff?.key ?? null,
    },
  };
}

/** A 400×300 world: fit is 2× in the 800×600 canvas, at the origin. */
const WORLD: Size = { w: 400, h: 300 };
const swipeStep = () =>
  step({
    baseline: loaded("b", WORLD.w, WORLD.h),
    current: loaded("c", WORLD.w, WORLD.h),
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

/** Let pixi's init, promise chains and React effects run to a standstill. */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

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

/** The first rect a Graphics drew, as { x, y, w, h }. */
function rectOf(g: Graphics) {
  const op = g.ops.find(([name]) => name === "rect");
  if (!op) throw new Error(`${g.label} drew no rect`);
  const [, x, y, w, h] = op;
  return { x: x!, y: y!, w: w!, h: h! };
}

/** Where the current image's clip starts, in world px. */
const maskX = (w: Box): number =>
  rectOf(child(w, "current").mask as Graphics).x;

/** The divider's centre, in canvas px, under the world's own placement. */
function dividerOnCanvas(w: Box): number {
  const r = rectOf(child(w, "divider") as Graphics);
  return (r.x + r.w / 2) * w.scale.x + w.position.x;
}

/** The world transform for the current view, in a canvas of `size`. */
const transformNow = (size: Size = VIEWPORT) =>
  transformFor(WORLD, size, useViewState.getState());

/** Where the divider must be in world px: its fraction of the canvas. */
const splitAt = (fraction: number, size: Size = VIEWPORT) =>
  canvasToWorld(transformNow(size), { x: fraction * size.w, y: 0 }).x;

const slider = () => screen.getByRole("slider", { name: "Swipe position" });

/** A pointer event as the browser sends it (jsdom has no PointerEvent). */
function pointer(type: string, x: number, y = 100): MouseEvent {
  const e = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
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

/** Lays `el` out at `left`, `width` px wide, for the pointer maths. */
function placeAt(el: Element, left: number, width: number) {
  el.getBoundingClientRect = () =>
    ({
      left,
      top: 0,
      right: left + width,
      bottom: 600,
      width,
      height: 600,
      x: left,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
}

beforeEach(() => {
  laidOut.clear();
  observed.length = 0;
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  counter += 1;
  fake.registry.apps.length = 0;
  fake.registry.created.length = 0;
  fake.registry.holdInit = false;
  fake.registry.textures.length = 0;
  fake.registry.sprites.length = 0;
  fake.registry.maxTextureSize = null;
  useViewerPrefs.setState({
    userId: null,
    prefs: { ...DEFAULT_VIEWER_PREFS, mode: "swipe" },
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
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Swipe draws as swipe", () => {
  test("its own renderer, on one stage; flicker still draws as side by side until it has one (R1)", () => {
    expect(RENDERERS.swipe).not.toBe(RENDERERS["side-by-side"]);
    expect(RENDERERS.swipe.panes).toBe(1);
    expect(RENDERERS.swipe.needs({ hasBaseline: true })).toEqual([
      "baseline",
      "current",
    ]);
    expect(drawnMode("swipe")).toBe("swipe");
    expect(RENDERERS.flicker).toBe(RENDERERS["side-by-side"]);
    expect(drawnMode("flicker")).toBe("side-by-side");
  });
});

describe("Swipe on the stage", () => {
  async function swipeStage(regions: DiffRegion[] = []) {
    const { set, request } = swipeStep();
    const r = render(
      <ViewerStage set={set} request={request} regions={regions} />,
    );
    await flush();
    return r;
  }

  test("its layers, bottom to top: both images, both hatchings, the divider, then the regions and the ignore regions (R9)", async () => {
    const { set, request } = step({
      baseline: loaded("b", 400, 300),
      current: loaded("c", 400, 250),
    });
    const r = render(
      <ViewerStage set={set} request={request} regions={REGIONS} />,
    );
    await flush();

    expect(r.getByTestId("single-stage-host").dataset.mode).toBe("swipe");
    const world = stageWorld();
    expect(labels(world)).toEqual([
      "baseline",
      "current",
      "hatch:baseline",
      "hatch:current",
      "divider",
      "regions",
      "ignore",
    ]);
    // The current image and the clip that keeps it right of the divider.
    const current = child(world, "current");
    expect(labels(current)).toEqual(["current:image", "current:mask"]);
    expect(current.mask).toBe(child(current, "current:mask"));
    // Each image drawn once, the current one inside its clip.
    expect(fake.registry.sprites.map((s) => s.label).sort()).toEqual([
      "baseline",
      "current:image",
    ]);
  });

  test("the current image shows right of the divider: its clip starts at the divider's canvas fraction, in world px", async () => {
    await swipeStage();
    const world = stageWorld();
    // At 50% of an 800 px canvas, under fit: the middle of the world.
    expect(maskX(world)).toBeCloseTo(splitAt(0.5), 9);
    expect(maskX(world)).toBeCloseTo(200, 9);
    const clip = rectOf(child(world, "current").mask as Graphics);
    expect(clip).toMatchObject({ y: 0, h: WORLD.h });
    expect(clip.x + clip.w).toBeCloseTo(WORLD.w, 9);

    // Panned, the same canvas fraction is another world point.
    act(() => useViewState.getState().setView({ zoom: 1, panX: 30, panY: 0 }));
    await flush();
    expect(maskX(world)).toBeCloseTo(splitAt(0.5), 9);
    expect(maskX(world)).toBeCloseTo(170, 9);
  });

  test("the divider is a 2 px line in --ring, across the whole canvas, at the swipe", async () => {
    await swipeStage();
    const world = stageWorld();
    const divider = child(world, "divider") as Graphics;
    const t = transformNow();
    const line = rectOf(divider);
    expect(line.w * t.scale).toBeCloseTo(2, 9);
    expect(line.x + line.w / 2).toBeCloseTo(splitAt(0.5), 9);
    expect(line.y).toBeCloseTo(canvasToWorld(t, { x: 0, y: 0 }).y, 9);
    expect(line.h * t.scale).toBeCloseTo(VIEWPORT.h, 9);
    // jsdom has no tokens: the light theme's --ring.
    expect(divider.fills).toEqual([{ color: FALLBACK_CANVAS_DIVIDER }]);
    expect(dividerOnCanvas(world)).toBeCloseTo(400, 9);
  });

  test("the handle is a slider at the divider: 50% to start", async () => {
    await swipeStage();
    expect(slider().getAttribute("aria-valuenow")).toBe("50");
    expect(slider().getAttribute("aria-valuetext")).toBe("50% baseline");
    expect(screen.getByTestId("swipe-divider").style.left).toBe("50%");
  });

  test("the handle's keys move the divider on the canvas", async () => {
    await swipeStage();
    act(() => slider().focus());
    fireEvent.keyDown(slider(), { key: "ArrowLeft", shiftKey: true });
    fireEvent.keyDown(slider(), { key: "ArrowLeft", shiftKey: true });
    await flush();

    expect(useViewState.getState().swipe).toBeCloseTo(0.3, 9);
    const left = screen.getByTestId("swipe-divider").style.left;
    expect(left.endsWith("%")).toBe(true);
    expect(parseFloat(left)).toBeCloseTo(30, 9);
    expect(maskX(stageWorld())).toBeCloseTo(splitAt(0.3), 9);
    expect(dividerOnCanvas(stageWorld())).toBeCloseTo(240, 9);
  });

  test("zoom keeps the divider where it is on the canvas: the handle's value holds, and the clip follows", async () => {
    await swipeStage();
    act(() => useViewState.getState().setSwipe(0.3));
    await flush();
    const before = maskX(stageWorld());

    act(() => useViewState.getState().zoomBy(2));
    await flush();

    expect(slider().getAttribute("aria-valuenow")).toBe("30");
    expect(maskX(stageWorld())).toBeCloseTo(splitAt(0.3), 9);
    expect(maskX(stageWorld())).not.toBeCloseTo(before, 3);
    expect(dividerOnCanvas(stageWorld())).toBeCloseTo(0.3 * VIEWPORT.w, 9);
    // Still 2 px on screen at the new scale.
    const line = rectOf(child(stageWorld(), "divider") as Graphics);
    expect(line.w * transformNow().scale).toBeCloseTo(2, 9);
  });

  test("a resize or a browser zoom keeps the fraction (Review Focus 5): the handle at 50%, the divider at half the new width", async () => {
    await swipeStage();
    const size = { w: 1000, h: 600 };
    act(() => resizeHost("single-stage-host", size.w, size.h));
    await flush();

    expect(slider().getAttribute("aria-valuenow")).toBe("50");
    // The handle is placed in % of the stage, so it is at 0.5 × 1000.
    expect(screen.getByTestId("swipe-divider").style.left).toBe("50%");
    expect(dividerOnCanvas(stageWorld())).toBeCloseTo(0.5 * size.w, 9);
    expect(maskX(stageWorld())).toBeCloseTo(splitAt(0.5, size), 9);

    // Off-centre, the same fraction is another world point after a resize.
    act(() => useViewState.getState().setSwipe(0.3));
    await flush();
    expect(dividerOnCanvas(stageWorld())).toBeCloseTo(300, 9);
    expect(maskX(stageWorld())).toBeCloseTo(splitAt(0.3, size), 9);
    expect(maskX(stageWorld())).toBeCloseTo(100, 9);
  });

  test("a resize moves the divider in the observer's callback, before React renders (M2)", async () => {
    await swipeStage();
    act(() => useViewState.getState().setSwipe(0.3));
    await flush();
    expect(maskX(stageWorld())).toBeCloseTo(120, 9);

    let placed: number[] = [];
    act(() => {
      resizeHost("single-stage-host", 1000, 600);
      // Read before act lets React render: only the callback has run.
      const w = stageWorld();
      placed = [maskX(w), dividerOnCanvas(w)];
    });
    expect(placed[0]).toBeCloseTo(100, 9);
    expect(placed[1]).toBeCloseTo(300, 9);
  });

  test("a click on the canvas does not move the divider; a drag on it pans", async () => {
    const r = await swipeStage(REGIONS);
    const host = r.getByTestId("single-stage-host");
    gesture(host, ["pointerdown", 100], ["pointerup", 100]);
    fireEvent.click(host, { clientX: 100, clientY: 100 });
    await flush();
    expect(useViewState.getState().swipe).toBe(0.5);
    expect(slider().getAttribute("aria-valuenow")).toBe("50");

    gesture(
      host,
      ["pointerdown", 100],
      ["pointermove", 160],
      ["pointerup", 160],
    );
    await flush();
    expect(useViewState.getState().swipe).toBe(0.5);
    expect(useViewState.getState().panX).toBeCloseTo(30, 9);
    // The divider stays put on the canvas while the world moves under it.
    expect(dividerOnCanvas(stageWorld())).toBeCloseTo(400, 9);
  });

  test("dragging the handle moves the divider, captured, and never pans the canvas", async () => {
    const r = await swipeStage();
    placeAt(r.getByTestId("single-stage-host"), 0, VIEWPORT.w);
    const capture = vi.spyOn(HTMLElement.prototype, "setPointerCapture");

    // Taken 4 px right of the divider, dragged 200 px: the divider moves 200.
    gesture(
      slider(),
      ["pointerdown", 404],
      ["pointermove", 604],
      ["pointerup", 604],
    );
    await flush();

    expect(capture).toHaveBeenCalledWith(1);
    expect(capture.mock.contexts[0]).toBe(screen.getByTestId("swipe-divider"));
    expect(useViewState.getState().swipe).toBeCloseTo(0.75, 9);
    expect(useViewState.getState()).toMatchObject({ panX: 0, panY: 0 });
    expect(maskX(stageWorld())).toBeCloseTo(splitAt(0.75), 9);
    expect(document.activeElement).toBe(slider());
  });

  test("a step change puts it back at 50% (resetView)", async () => {
    const first = swipeStep();
    const r = render(
      <ViewerStage set={first.set} request={first.request} regions={[]} />,
    );
    await flush();
    act(() => slider().focus());
    fireEvent.keyDown(slider(), { key: "End" });
    await flush();
    expect(slider().getAttribute("aria-valuenow")).toBe("100");

    // What the viewer does on every step change.
    act(() => useViewState.getState().resetView({ reducedMotion: false }));
    counter += 1;
    const next = swipeStep();
    r.rerender(
      <ViewerStage set={next.set} request={next.request} regions={[]} />,
    );
    await flush();

    expect(slider().getAttribute("aria-valuenow")).toBe("50");
    expect(maskX(stageWorld())).toBeCloseTo(splitAt(0.5), 9);
  });

  test("no handle until the images are in, and none in another mode; leaving Swipe takes its layers with it", async () => {
    const images = swipeStep();
    const r = render(
      <ViewerStage
        set={{ ...images.set, status: "loading", images: {} }}
        request={images.request}
        regions={[]}
      />,
    );
    await flush();
    expect(screen.queryByRole("slider")).toBeNull();

    r.rerender(
      <ViewerStage set={images.set} request={images.request} regions={[]} />,
    );
    await flush();
    expect(screen.getByRole("slider")).toBeDefined();
    const world = stageWorld();
    const current = child(world, "current");
    const clip = child(current, "current:mask");
    const divider = child(world, "divider");

    setMode("overlay");
    await flush();
    expect(screen.queryByRole("slider")).toBeNull();
    expect(labels(world)).toEqual([
      "baseline",
      "current",
      "hatch:baseline",
      "hatch:current",
      "ignore",
    ]);
    expect(current.destroyed).toBe(true);
    expect(current.mask).toBeNull();
    expect(clip.destroyed).toBe(true);
    expect(divider.destroyed).toBe(true);
  });
});

/** The handle on its own, over a stage `width` px wide at `left`. */
function Controlled({
  initial = 0.5,
  onChange,
}: {
  initial?: number;
  onChange?: (v: number) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <div data-testid="stage" className="relative">
      <SwipeHandle
        value={value}
        onChange={(v) => {
          onChange?.(v);
          setValue(v);
        }}
      />
    </div>
  );
}

describe("SwipeHandle", () => {
  test("a slider named Swipe position, 0 to 100, its value the share of baseline", () => {
    render(<Controlled initial={0.3} />);
    const s = slider();
    expect(s.getAttribute("aria-valuemin")).toBe("0");
    expect(s.getAttribute("aria-valuemax")).toBe("100");
    expect(s.getAttribute("aria-valuenow")).toBe("30");
    expect(s.getAttribute("aria-valuetext")).toBe("30% baseline");
    expect(s.tabIndex).toBe(0);
  });

  test("← → move it 2%, Shift+← → 10%, Home and End to 0 and 100; clamped at both ends", () => {
    render(<Controlled />);
    const s = slider();
    act(() => s.focus());
    const press = (key: string, shiftKey = false) => {
      // Each is the handle's own: taken (prevented), so nothing else acts on it.
      expect(fireEvent.keyDown(s, { key, shiftKey })).toBe(false);
      return Number(s.getAttribute("aria-valuenow"));
    };
    expect(press("ArrowRight")).toBe(52);
    expect(press("ArrowRight", true)).toBe(62);
    expect(press("ArrowLeft")).toBe(60);
    expect(press("ArrowLeft", true)).toBe(50);
    expect(press("End")).toBe(100);
    expect(press("ArrowRight")).toBe(100);
    expect(press("ArrowRight", true)).toBe(100);
    expect(press("Home")).toBe(0);
    expect(press("ArrowLeft")).toBe(0);
    expect(press("ArrowLeft", true)).toBe(0);
    expect(s.getAttribute("aria-valuetext")).toBe("0% baseline");
  });

  test("other keys and chords are left alone (Alt+← is the browser's back)", () => {
    const onChange = vi.fn();
    render(<Controlled onChange={onChange} />);
    const s = slider();
    act(() => s.focus());
    expect(fireEvent.keyDown(s, { key: "ArrowLeft", altKey: true })).toBe(true);
    expect(fireEvent.keyDown(s, { key: "ArrowRight", metaKey: true })).toBe(
      true,
    );
    expect(fireEvent.keyDown(s, { key: "Home", ctrlKey: true })).toBe(true);
    expect(fireEvent.keyDown(s, { key: "a" })).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
  });

  test("a press alone moves nothing and never reaches the stage below", () => {
    const onChange = vi.fn();
    render(<Controlled onChange={onChange} />);
    const stage = screen.getByTestId("stage");
    placeAt(stage, 100, 800);
    const stagePress = vi.fn();
    stage.addEventListener("pointerdown", stagePress);

    gesture(slider(), ["pointerdown", 510], ["pointerup", 510]);

    expect(onChange).not.toHaveBeenCalled();
    expect(stagePress).not.toHaveBeenCalled();
  });

  test("a drag moves it by the pointer's travel over the stage's width", () => {
    const onChange = vi.fn();
    render(<Controlled onChange={onChange} />);
    placeAt(screen.getByTestId("stage"), 100, 800);

    // The divider is at 100 + 400; taken 10 px right of it.
    gesture(slider(), ["pointerdown", 510], ["pointermove", 610]);
    expect(onChange).toHaveBeenLastCalledWith(0.625);
    // Past the stage's edge it stops at the edge.
    gesture(slider(), ["pointermove", 2000]);
    expect(onChange).toHaveBeenLastCalledWith(1);
    gesture(slider(), ["pointerup", 2000], ["pointermove", 300]);
    // Let go, the pointer moves nothing.
    expect(onChange).toHaveBeenLastCalledWith(1);
    expect(slider().getAttribute("aria-valuenow")).toBe("100");
  });
});

describe("the handle's keys are its own", () => {
  function Viewer({
    onNextStep,
    onPrevStep,
  }: {
    onNextStep: () => void;
    onPrevStep: () => void;
  }) {
    useDiffViewerShortcuts({ viewports: [], onNextStep, onPrevStep });
    const swipe = useViewState((s) => s.swipe);
    const setSwipe = useViewState((s) => s.setSwipe);
    return (
      <div className="relative">
        <SwipeHandle value={swipe} onChange={setSwipe} />
      </div>
    );
  }
  function Keyboard({ children }: { children: ReactNode }) {
    return (
      <CommandRoleProvider role="editor">
        <CommandDispatcher />
        {children}
      </CommandRoleProvider>
    );
  }

  test("← → on the handle move the divider, and never step the viewer", () => {
    const onNextStep = vi.fn();
    const onPrevStep = vi.fn();
    render(
      <Keyboard>
        <Viewer onNextStep={onNextStep} onPrevStep={onPrevStep} />
      </Keyboard>,
    );
    act(() => slider().focus());

    fireEvent.keyDown(slider(), { key: "ArrowRight" });
    fireEvent.keyDown(slider(), { key: "ArrowLeft", shiftKey: true });
    // At the end there is nowhere to go, and still no step.
    fireEvent.keyDown(slider(), { key: "End" });
    fireEvent.keyDown(slider(), { key: "ArrowRight" });

    expect(onNextStep).not.toHaveBeenCalled();
    expect(onPrevStep).not.toHaveBeenCalled();
    expect(useViewState.getState().swipe).toBe(1);

    // Away from the handle, → is the viewer's next step again.
    act(() => slider().blur());
    fireEvent.keyDown(document.body, { key: "ArrowRight" });
    expect(onNextStep).toHaveBeenCalledOnce();
    expect(useViewState.getState().swipe).toBe(1);
  });
});
