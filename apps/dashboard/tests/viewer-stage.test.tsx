import {
  act,
  cleanup,
  fireEvent,
  render,
  within,
} from "@testing-library/react";
import { useCallback, useState } from "react";
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

import type { ViewerMode } from "@/components/diff-viewer/comparison-modes";
import {
  __viewerBitmapCache,
  useImageSet,
  type ImageRole,
  type ImageSetRequest,
  type ImageSetState,
  type LoadedImage,
} from "@/components/diff-viewer/image-set";
import type { DiffRegion } from "@/components/diff-viewer/layers/regionTypes";
import { DIFF_CURRENT_ALPHA } from "@/components/diff-viewer/modes/diff";
import { RENDERERS } from "@/components/diff-viewer/modes/types";
import type { ElementMap } from "@/components/diff-viewer/useElementMap";
import { useViewerStore } from "@/components/diff-viewer/useViewerStore";
import { useViewState } from "@/components/diff-viewer/view-state";
import {
  transformFor,
  worldToCanvas,
} from "@/components/diff-viewer/viewer-geometry";
import {
  DEFAULT_VIEWER_PREFS,
  useViewerPrefs,
} from "@/components/diff-viewer/viewer-prefs";
import { ViewerStage } from "@/components/diff-viewer/ViewerStage";

type Box = InstanceType<typeof fake.Box>;
type Graphics = InstanceType<typeof fake.Graphics>;
type FakeBitmap = ImageBitmap & {
  close: ReturnType<typeof vi.fn>;
  name: string;
};

// jsdom lays nothing out, so every host is the stage's fallback size.
const VIEWPORT = { w: 800, h: 600 };

let counter = 0;
/** A key no other test uses: the image loader's cache is module-wide. */
const k = (name: string): string => `vs${counter}-${name}`;

function fakeBitmap(w: number, h: number, name: string): FakeBitmap {
  return { width: w, height: h, close: vi.fn(), name } as unknown as FakeBitmap;
}

function loaded(
  name: string,
  w: number,
  h: number,
): LoadedImage & { bitmap: FakeBitmap } {
  const key = k(name);
  return { key, bitmap: fakeBitmap(w, h, key), size: { w, h } };
}

/** A settled image set, and the request it answers. */
function step(
  images: Partial<Record<ImageRole, LoadedImage>>,
  failed: Partial<Record<ImageRole, true>> = {},
): { set: ImageSetState; request: ImageSetRequest } {
  const keyOf = (role: ImageRole) =>
    images[role]?.key ?? (failed[role] ? k(`failed-${role}`) : null);
  return {
    set: { status: "ready", images, failed, retry: () => {} },
    request: {
      baseline: keyOf("baseline"),
      current: keyOf("current"),
      diff: keyOf("diff"),
    },
  };
}

function fullStep(w = 100, h = 100) {
  return step({
    baseline: loaded("b", w, h),
    current: loaded("c", w, h),
    diff: loaded("d", w, h),
  });
}

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

function liveApps() {
  return fake.registry.apps.filter((a) => !a.destroyed);
}

/** The world container drawn in the host with this test id. */
function worldIn(testId: string): Box {
  const app = liveApps().find(
    (a) => a.canvas.parentElement?.getAttribute("data-testid") === testId,
  );
  if (!app) throw new Error(`no live pixi app in ${testId}`);
  return app.stage.children[0] as Box;
}

const labels = (world: Box): string[] => world.children.map((c) => c.label);

const layer = (world: Box, label: string): Graphics => {
  const found = world.children.find((c) => c.label === label);
  if (!found) throw new Error(`no ${label} layer`);
  return found as Graphics;
};

const editorOn = () =>
  act(() =>
    useViewerStore.setState({ ignoreEditMode: "run", viewport: "1280x720" }),
  );

/** Where a world point lands on the canvas, under this world's transform. */
const onCanvas = (w: Box, p: { x: number; y: number }) => ({
  x: p.x * w.scale.x + w.position.x,
  y: p.y * w.scale.y + w.position.y,
});

// jsdom lays nothing out: a host given a size here reports it (by test id),
// every other one reports 0, and the stage falls back to 800×600.
const laidOut = new Map<string, { w: number; h: number }>();
const sizeHost = (testId: string, w: number, h: number) =>
  laidOut.set(testId, { w, h });
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
  sizeHost(testId, w, h);
  for (const o of observed.slice()) {
    if ((o.target as HTMLElement).dataset.testid === testId) {
      o.callback([], o.observer);
    }
  }
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
    prefs: DEFAULT_VIEWER_PREFS,
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

describe("each mode stacks its layers in its declared order", () => {
  test("side by side: the baseline in pane A; the current, then the host's layers, in pane B", async () => {
    editorOn();
    const { set, request } = fullStep();
    render(<ViewerStage set={set} request={request} regions={REGIONS} />);
    await flush();

    expect(labels(worldIn("baseline-canvas-host"))).toEqual([
      "baseline",
      "hatch:baseline",
    ]);
    expect(labels(worldIn("candidate-canvas-host"))).toEqual([
      "current",
      "hatch:current",
      "shading",
      "regions",
      "ignore",
    ]);
  });

  test("overlay: both images, their hatching, then the regions and the editor", async () => {
    setMode("overlay");
    editorOn();
    const { set, request } = fullStep();
    render(<ViewerStage set={set} request={request} regions={REGIONS} />);
    await flush();

    expect(labels(worldIn("single-stage-host"))).toEqual([
      "baseline",
      "current",
      "hatch:baseline",
      "hatch:current",
      "regions",
      "ignore",
    ]);
  });

  test("diff: the current image, the diff image, the hatching, then the regions and the editor", async () => {
    setMode("diff");
    editorOn();
    const { set, request } = fullStep();
    render(<ViewerStage set={set} request={request} regions={REGIONS} />);
    await flush();

    expect(labels(worldIn("single-stage-host"))).toEqual([
      "current",
      "diff",
      "hatch:current",
      "regions",
      "ignore",
    ]);
  });

  test("shading shows only with highlight on, in its place; the ignore regions show outside the editor too (R9)", async () => {
    act(() =>
      useViewerPrefs.setState((s) => ({
        prefs: { ...s.prefs, highlight: false },
      })),
    );
    const { set, request } = fullStep();
    render(<ViewerStage set={set} request={request} regions={REGIONS} />);
    await flush();
    const paneB = () => labels(worldIn("candidate-canvas-host"));
    expect(paneB()).toEqual(["current", "hatch:current", "regions", "ignore"]);

    // Mounted after the regions, still stacked under them.
    act(() =>
      useViewerPrefs.setState((s) => ({
        prefs: { ...s.prefs, highlight: true },
      })),
    );
    await flush();
    expect(paneB()).toEqual([
      "current",
      "hatch:current",
      "shading",
      "regions",
      "ignore",
    ]);

    // Opening the editor changes no layer: it only makes them interactive.
    editorOn();
    await flush();
    expect(paneB()).toEqual([
      "current",
      "hatch:current",
      "shading",
      "regions",
      "ignore",
    ]);

    // A layer that remounts (a new selection) keeps its place.
    act(() => useViewState.getState().setSelected("r1"));
    await flush();
    expect(paneB()).toEqual([
      "current",
      "hatch:current",
      "shading",
      "regions",
      "ignore",
    ]);
  });

  test("a mode change on the same stage keeps the host's layers on top", async () => {
    setMode("overlay");
    editorOn();
    const { set, request } = fullStep();
    render(<ViewerStage set={set} request={request} regions={REGIONS} />);
    await flush();
    setMode("diff");
    await flush();

    expect(labels(worldIn("single-stage-host"))).toEqual([
      "current",
      "diff",
      "hatch:current",
      "regions",
      "ignore",
    ]);
  });

  test("a renderer that mounts again under unchanged host layers stays below them", async () => {
    setMode("overlay");
    editorOn();
    const first = fullStep();
    const r = render(
      <ViewerStage set={first.set} request={first.request} regions={REGIONS} />,
    );
    await flush();
    // New images (a retry, a step with the same regions): only the renderer
    // mounts again; the regions and the editor's layer stay as they were.
    const second = fullStep();
    r.rerender(
      <ViewerStage
        set={second.set}
        request={second.request}
        regions={REGIONS}
      />,
    );
    await flush();

    expect(labels(worldIn("single-stage-host"))).toEqual([
      "baseline",
      "current",
      "hatch:baseline",
      "hatch:current",
      "regions",
      "ignore",
    ]);
  });

  test("every mode but side by side has a renderer of its own, on one stage", () => {
    for (const mode of ["swipe", "flicker", "overlay", "diff"] as const) {
      expect(RENDERERS[mode]).not.toBe(RENDERERS["side-by-side"]);
      expect(RENDERERS[mode].panes).toBe(1);
    }
  });
});

describe("the stage's pixi apps", () => {
  test("a mode change keeps the app when the pane count is the same, and replaces it when not", async () => {
    setMode("overlay");
    const { set, request } = fullStep();
    render(<ViewerStage set={set} request={request} regions={[]} />);
    await flush();
    const [app] = liveApps();
    expect(liveApps()).toHaveLength(1);

    setMode("diff");
    await flush();
    expect(liveApps()).toEqual([app]);
    expect(app!.destroyed).toBe(false);

    setMode("side-by-side");
    await flush();
    expect(app!.destroyed).toBe(true);
    expect(liveApps()).toHaveLength(2);
  });

  test("a mode change keeps the zoom and the pan (R8)", async () => {
    setMode("overlay");
    const { set, request } = fullStep(400, 300);
    render(<ViewerStage set={set} request={request} regions={[]} />);
    await flush();
    act(() => useViewState.getState().setView({ zoom: 2, panX: 15, panY: -5 }));
    await flush();

    setMode("diff");
    await flush();
    expect(useViewState.getState()).toMatchObject({
      zoom: 2,
      panX: 15,
      panY: -5,
    });
    const t = transformFor({ w: 400, h: 300 }, VIEWPORT, {
      zoom: 2,
      panX: 15,
      panY: -5,
    });
    const single = worldIn("single-stage-host");
    expect([single.scale.x, single.position.x, single.position.y]).toEqual([
      t.scale,
      t.x,
      t.y,
    ]);

    setMode("side-by-side");
    await flush();
    expect(useViewState.getState()).toMatchObject({ zoom: 2, panX: 15 });
    const paneB = worldIn("candidate-canvas-host");
    expect([paneB.scale.x, paneB.position.x, paneB.position.y]).toEqual([
      t.scale,
      t.x,
      t.y,
    ]);
  });
});

describe("side by side shares one world", () => {
  test("both panes take the one transform, and the shorter image's missing area is hatched", async () => {
    const { set, request } = step({
      baseline: loaded("b", 100, 200),
      current: loaded("c", 100, 300),
    });
    render(<ViewerStage set={set} request={request} regions={[]} />);
    await flush();

    const paneA = worldIn("baseline-canvas-host");
    const paneB = worldIn("candidate-canvas-host");
    const placed = (w: Box) => [w.scale.x, w.position.x, w.position.y];
    const fit = transformFor({ w: 100, h: 300 }, VIEWPORT, {
      zoom: 1,
      panX: 0,
      panY: 0,
    });
    expect(placed(paneA)).toEqual([fit.scale, fit.x, fit.y]);
    expect(placed(paneB)).toEqual([fit.scale, fit.x, fit.y]);

    act(() =>
      useViewState.getState().setView({ zoom: 1.5, panX: 12, panY: -4 }),
    );
    await flush();
    const zoomed = transformFor({ w: 100, h: 300 }, VIEWPORT, {
      zoom: 1.5,
      panX: 12,
      panY: -4,
    });
    expect(placed(paneA)).toEqual([zoomed.scale, zoomed.x, zoomed.y]);
    expect(placed(paneB)).toEqual([zoomed.scale, zoomed.x, zoomed.y]);

    // The baseline lacks y 200–300: its hatch spans that strip, and only it.
    const hatch = layer(paneA, "hatch:baseline").points();
    expect(hatch.length).toBeGreaterThan(0);
    for (const p of hatch) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(100);
      expect(p.y).toBeGreaterThanOrEqual(200);
      expect(p.y).toBeLessThanOrEqual(300);
    }
    expect(Math.min(...hatch.map((p) => p.y))).toBeLessThanOrEqual(208);
    expect(Math.max(...hatch.map((p) => p.y))).toBeGreaterThanOrEqual(292);
    // The current image covers the whole world.
    expect(layer(paneB, "hatch:current").points()).toEqual([]);
  });
});

describe("the stage never closes a bitmap", () => {
  test("mode changes, a step change and an unmount destroy textures, never bitmaps", async () => {
    const first = fullStep();
    const second = fullStep(120, 80);
    const bitmaps = [first, second].flatMap(({ set }) =>
      Object.values(set.images).map((img) => img.bitmap as FakeBitmap),
    );
    const r = render(
      <ViewerStage set={first.set} request={first.request} regions={[]} />,
    );
    await flush();
    setMode("overlay");
    await flush();
    setMode("diff");
    await flush();
    r.rerender(
      <ViewerStage set={second.set} request={second.request} regions={[]} />,
    );
    await flush();
    r.unmount();
    await flush();

    expect(fake.registry.textures.length).toBeGreaterThan(0);
    for (const bitmap of bitmaps) expect(bitmap.close).not.toHaveBeenCalled();
    for (const t of fake.registry.textures) {
      // Its own texture, out of pixi's cache, and gone with its mount.
      expect(t.skipCache).toBe(true);
      expect(t.destroyed).toBe(true);
      expect(t.source.destroyed).toBe(true);
    }
  });
});

describe("with the image loader", () => {
  interface Call {
    key: string;
    respond(): void;
  }
  let calls: Call[];
  let honourAbort: boolean;
  /** Decoded sizes by key; 100×100 when unset. */
  let sizes: Map<string, { w: number; h: number }>;
  const keyOfBlob = new WeakMap<Blob, string>();

  beforeEach(() => {
    calls = [];
    honourAbort = true;
    sizes = new Map();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (input: string, init: RequestInit) =>
          new Promise<Response>((resolve, reject) => {
            const key = decodeURIComponent(input.split("/").pop() ?? "");
            calls.push({
              key,
              respond: () => {
                const blob = new Blob([key]);
                keyOfBlob.set(blob, key);
                resolve({
                  ok: true,
                  status: 200,
                  blob: () => Promise.resolve(blob),
                } as unknown as Response);
              },
            });
            init.signal?.addEventListener("abort", () => {
              if (honourAbort) {
                reject(new DOMException("Aborted", "AbortError"));
              }
            });
          }),
      ),
    );
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn((blob: Blob) => {
        const key = keyOfBlob.get(blob) ?? "?";
        const { w, h } = sizes.get(key) ?? { w: 100, h: 100 };
        return Promise.resolve(fakeBitmap(w, h, key));
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  /** Answer every fetch of these keys. */
  async function respond(...keys: string[]): Promise<void> {
    await act(async () => {
      for (const c of calls) if (keys.includes(c.key)) c.respond();
      await new Promise((r) => setTimeout(r, 0));
    });
    await flush();
  }

  function Loaded({ req }: { req: ImageSetRequest }) {
    const set = useImageSet(req);
    return <ViewerStage set={set} request={req} regions={[]} />;
  }

  const stepReq = (id: string): ImageSetRequest => ({
    baseline: k(`${id}-b`),
    current: k(`${id}-c`),
    diff: k(`${id}-d`),
  });
  const keysOf = (req: ImageSetRequest): string[] =>
    [req.baseline, req.current, req.diff].filter((x): x is string => !!x);
  /** The bitmaps that were ever put on a texture, by key. */
  const drawn = () =>
    fake.registry.textures.map((t) => (t.bitmap as unknown as FakeBitmap).name);

  test.each([
    {
      mode: "side-by-side" as const,
      host: "candidate-canvas-host",
      order: ["current", "hatch:current", "ignore"],
    },
    {
      mode: "overlay" as const,
      host: "single-stage-host",
      order: [
        "baseline",
        "current",
        "hatch:baseline",
        "hatch:current",
        "ignore",
      ],
    },
  ])(
    "$mode: the current image arriving first changes nothing until the baseline is in, then the order is the declared one",
    async ({ mode, host, order }) => {
      setMode(mode);
      const req: ImageSetRequest = {
        baseline: k("b"),
        current: k("c"),
        diff: null,
      };
      render(<Loaded req={req} />);
      await flush();

      await respond(k("c"));
      expect(fake.registry.sprites).toHaveLength(0);

      await respond(k("b"));
      expect(labels(worldIn(host))).toEqual(order);
    },
  );

  test("holding → through steps draws only the final step, whatever order the answers come in", async () => {
    // Answers that come back after their step was left still arrive.
    honourAbort = false;
    const [a, b, c] = [stepReq("A"), stepReq("B"), stepReq("C")];
    const r = render(<Loaded req={a} />);
    await flush();
    r.rerender(<Loaded req={b} />);
    await flush();
    r.rerender(<Loaded req={c} />);
    await flush();

    await respond(...keysOf(c));
    const afterC = drawn();
    expect(afterC.length).toBeGreaterThan(0);
    expect(afterC.every((name) => name.startsWith(k("C-")))).toBe(true);

    await respond(...keysOf(a));
    await respond(...keysOf(b));
    expect(drawn()).toEqual(afterC);
    expect(labels(worldIn("candidate-canvas-host"))).toEqual([
      "current",
      "hatch:current",
      "ignore",
    ]);
  });

  test("Diff waits for the baseline too, so its first draw is in the final world (M5)", async () => {
    setMode("diff");
    const diffMount = vi.spyOn(RENDERERS.diff, "mount");
    const req = stepReq("L");
    // A taller baseline: the world is taller than the current image.
    sizes.set(req.baseline!, { w: 100, h: 200 });
    render(<Loaded req={req} />);
    await flush();

    await respond(req.current!, req.diff!);
    expect(diffMount).not.toHaveBeenCalled();
    expect(fake.registry.sprites).toHaveLength(0);

    await respond(req.baseline!);
    expect(diffMount).toHaveBeenCalledTimes(1);
    const single = worldIn("single-stage-host");
    // Hatched below the current image from the first draw.
    const hatch = layer(single, "hatch:current").points();
    expect(hatch.length).toBeGreaterThan(0);
    for (const p of hatch) {
      expect(p.y).toBeGreaterThanOrEqual(100);
      expect(p.y).toBeLessThanOrEqual(200);
    }
    const fit = transformFor({ w: 100, h: 200 }, VIEWPORT, {
      zoom: 1,
      panX: 0,
      panY: 0,
    });
    expect([single.scale.x, single.position.x, single.position.y]).toEqual([
      fit.scale,
      fit.x,
      fit.y,
    ]);
  });

  test("an image a mode does not draw, arriving late, reshapes the world without a second mount", async () => {
    // Side by side draws the baseline and the current image, not the diff.
    const mount = vi.spyOn(RENDERERS["side-by-side"], "mount");
    const req = stepReq("U");
    sizes.set(req.diff!, { w: 100, h: 200 });
    render(<Loaded req={req} />);
    await flush();

    await respond(req.baseline!, req.current!);
    expect(mount).toHaveBeenCalledTimes(1);
    const paneB = worldIn("candidate-canvas-host");
    expect(layer(paneB, "hatch:current").points()).toEqual([]);

    await respond(req.diff!);
    expect(mount).toHaveBeenCalledTimes(1);
    const hatch = layer(paneB, "hatch:current").points();
    expect(hatch.length).toBeGreaterThan(0);
    for (const p of hatch) expect(p.y).toBeGreaterThanOrEqual(100);
  });

  test("a mode changed while the images load draws once, when they are in", async () => {
    const sideBySide = vi.spyOn(RENDERERS["side-by-side"], "mount");
    const overlay = vi.spyOn(RENDERERS.overlay, "mount");
    const diff = vi.spyOn(RENDERERS.diff, "mount");
    const req = stepReq("M");
    render(<Loaded req={req} />);
    await flush();
    setMode("overlay");
    await flush();
    setMode("diff");
    await flush();

    await respond(...keysOf(req));

    expect(sideBySide).not.toHaveBeenCalled();
    expect(overlay).not.toHaveBeenCalled();
    expect(diff).toHaveBeenCalledTimes(1);
    expect(
      fake.registry.sprites.filter((s) => s.label === "current"),
    ).toHaveLength(1);
    expect(labels(worldIn("single-stage-host"))).toEqual([
      "current",
      "diff",
      "hatch:current",
      "ignore",
    ]);
  });
});

/** A pointer event as the browser sends it (jsdom has no PointerEvent). */
function pointer(type: string, x: number, y: number): MouseEvent {
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

function gesture(el: Element, ...points: Array<[string, number, number]>) {
  for (const [type, x, y] of points) {
    act(() => {
      el.dispatchEvent(pointer(type, x, y));
    });
  }
}

describe("the ignore-region editor, re-hosted", () => {
  // A 400×300 world in an 800×600 canvas: fit is 2×, at the origin, so a
  // canvas point is twice its image point.
  async function editing(mode: ViewerMode = "overlay") {
    setMode(mode);
    editorOn();
    const { set, request } = fullStep(400, 300);
    const r = render(
      <ViewerStage
        set={set}
        request={request}
        regions={REGIONS}
        elementMap={ELEMENTS}
      />,
    );
    await flush();
    return r.getByTestId("ignore-region-overlay");
  }

  const ELEMENTS: ElementMap = {
    v: 1,
    elements: { "#card": { x: 20, y: 20, width: 40, height: 40 } },
    capturedAt: 0,
  };

  test.each(["overlay", "side-by-side"] as const)(
    "%s: a drag draws a draft in image pixels",
    async (mode) => {
      const overlay = await editing(mode);
      gesture(
        overlay,
        ["pointerdown", 100, 60],
        ["pointermove", 300, 260],
        ["pointerup", 300, 260],
      );
      expect(useViewerStore.getState().draftIgnoreAreas).toEqual([
        expect.objectContaining({
          x: 50,
          y: 30,
          width: 100,
          height: 100,
          viewport: "1280x720",
          kind: "ignore",
          paddingPx: 0,
        }),
      ]);
    },
  );

  test("a click selects the saved region under it, and a click on nothing clears it", async () => {
    act(() =>
      useViewerStore.setState({
        savedRunIgnoreAreas: [
          {
            id: "s1",
            x: 10,
            y: 10,
            width: 50,
            height: 50,
            viewport: "1280x720",
            paddingPx: 0,
            kind: "ignore",
          },
        ],
      }),
    );
    const overlay = await editing();
    gesture(overlay, ["pointerdown", 60, 60], ["pointerup", 61, 61]);
    expect(useViewerStore.getState().selectedIgnoreId).toBe("s1");

    gesture(overlay, ["pointerdown", 600, 500], ["pointerup", 600, 500]);
    expect(useViewerStore.getState().selectedIgnoreId).toBeNull();
  });

  test("a drag on the selected region's corner handle resizes it", async () => {
    act(() =>
      useViewerStore.setState({
        draftIgnoreAreas: [
          {
            id: "d1",
            x: 50,
            y: 50,
            width: 100,
            height: 100,
            viewport: "1280x720",
            paddingPx: 0,
            kind: "ignore",
          },
        ],
        selectedIgnoreId: "d1",
      }),
    );
    const overlay = await editing();
    // The south-east handle sits at image (150, 150): canvas (300, 300).
    gesture(
      overlay,
      ["pointerdown", 300, 300],
      ["pointermove", 400, 360],
      ["pointerup", 400, 360],
    );
    expect(useViewerStore.getState().draftIgnoreAreas[0]).toMatchObject({
      x: 50,
      y: 50,
      width: 150,
      height: 130,
    });
  });

  test("pick mode turns a click into a draft on the element under it, anchored by its selector", async () => {
    act(() => useViewerStore.setState({ regionInputMode: "pick" }));
    const overlay = await editing();
    expect(overlay.dataset.inputMode).toBe("pick");
    gesture(overlay, ["pointermove", 80, 80], ["pointerup", 80, 80]);
    expect(useViewerStore.getState().draftIgnoreAreas).toEqual([
      expect.objectContaining({
        x: 20,
        y: 20,
        width: 40,
        height: 40,
        selector: "#card",
      }),
    ]);
  });

  test("in Diff, a click selects the diff region under it", async () => {
    setMode("diff");
    const { set, request } = fullStep(400, 300);
    const r = render(
      <ViewerStage set={set} request={request} regions={REGIONS} />,
    );
    await flush();
    // r1 spans image 10–30: canvas 20–60.
    gesture(r.getByTestId("single-stage-host"), ["pointerup", 40, 40]);
    expect(useViewState.getState().selectedRegionId).toBe("r1");
  });
});

/** Every rect drawn under `node`, as [x, y, w, h], depth first. */
function rectsUnder(node: Box): number[][] {
  const out: number[][] = [];
  for (const child of node.children) {
    if (child instanceof fake.Graphics) {
      for (const [op, ...args] of child.ops) if (op === "rect") out.push(args);
    }
    if (child instanceof fake.Box) out.push(...rectsUnder(child));
  }
  return out;
}
const hasRect = (node: Box, [x, y, w, h]: number[]) =>
  rectsUnder(node).some((r) => r.join() === [x, y, w, h].join());

/** The world point under a canvas point, through a world's transform. */
const underCanvas = (w: Box, p: { x: number; y: number }) => ({
  x: (p.x - w.position.x) / w.scale.x,
  y: (p.y - w.position.y) / w.scale.y,
});

describe("the area on screen holds across modes and resizes (R12)", () => {
  test("zoomed on one spot, overlay → side by side → a resize keep that spot at the centre", async () => {
    // A 1440×900 world: a 1000px stage, or two 488px panes.
    sizeHost("single-stage-host", 1000, 625);
    sizeHost("baseline-canvas-host", 488, 305);
    sizeHost("candidate-canvas-host", 488, 305);
    setMode("overlay");
    const { set, request } = fullStep(1440, 900);
    render(<ViewerStage set={set} request={request} regions={[]} />);
    await flush();
    // Zoom 4, framed on world (1200, 450): the pan is in world px.
    act(() =>
      useViewState.getState().setView({ zoom: 4, panX: 720 - 1200, panY: 0 }),
    );
    await flush();
    const spot = { x: 1200, y: 450 };
    const expectAt = (w: Box, x: number, y: number) => {
      const c = onCanvas(w, spot);
      expect(c.x).toBeCloseTo(x, 6);
      expect(c.y).toBeCloseTo(y, 6);
    };
    expectAt(worldIn("single-stage-host"), 500, 312.5);

    setMode("side-by-side");
    await flush();
    expectAt(worldIn("baseline-canvas-host"), 244, 152.5);
    expectAt(worldIn("candidate-canvas-host"), 244, 152.5);

    act(() => {
      resizeHost("baseline-canvas-host", 600, 375);
      resizeHost("candidate-canvas-host", 600, 375);
    });
    await flush();
    expectAt(worldIn("baseline-canvas-host"), 300, 187.5);
    expectAt(worldIn("candidate-canvas-host"), 300, 187.5);
  });

  test("a resize refits in the observer's callback, before React renders (M2)", async () => {
    setMode("overlay");
    const { set, request } = fullStep(400, 300);
    render(<ViewerStage set={set} request={request} regions={[]} />);
    await flush();
    expect(worldIn("single-stage-host").scale.x).toBe(2);

    let placed: number[] = [];
    act(() => {
      resizeHost("single-stage-host", 400, 300);
      // Read before act lets React render: only the callback has run.
      const w = worldIn("single-stage-host");
      placed = [w.scale.x, w.position.x, w.position.y];
    });
    expect(placed).toEqual([1, 0, 0]);
  });

  test("a drag pans by exactly the drag, kept in world px", async () => {
    setMode("overlay");
    const { set, request } = fullStep(400, 300);
    const r = render(<ViewerStage set={set} request={request} regions={[]} />);
    await flush();
    const w = worldIn("single-stage-host");
    const before = { x: w.position.x, y: w.position.y };
    gesture(
      r.getByTestId("single-stage-host"),
      ["pointerdown", 100, 100],
      ["pointermove", 130, 80],
      ["pointerup", 130, 80],
    );
    await flush();
    expect(w.position.x - before.x).toBeCloseTo(30, 9);
    expect(w.position.y - before.y).toBeCloseTo(-20, 9);
    // At 2 canvas px per world px.
    expect(useViewState.getState()).toMatchObject({ panX: 15, panY: -10 });
  });

  test("the wheel zooms about the cursor in the world, where only the baseline reaches too", async () => {
    setMode("overlay");
    // The world (400×400) is taller than the current image (400×300).
    const { set, request } = step({
      baseline: loaded("b", 400, 400),
      current: loaded("c", 400, 300),
    });
    const r = render(<ViewerStage set={set} request={request} regions={[]} />);
    await flush();
    const w = worldIn("single-stage-host");
    const cursor = { x: 520, y: 470 };
    const before = underCanvas(w, cursor);
    act(() => {
      r.getByTestId("single-stage-host").dispatchEvent(
        new WheelEvent("wheel", {
          clientX: cursor.x,
          clientY: cursor.y,
          deltaY: -100,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await flush();
    expect(useViewState.getState().zoom).toBe(1.25);
    const after = underCanvas(w, cursor);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
  });
});

describe("the hatching is spaced on screen (M3)", () => {
  /** The gaps between neighbouring hatch lines, in world px. */
  function gaps(g: Graphics): number[] {
    const sums = [
      ...new Set(
        g.ops.filter(([op]) => op === "moveTo").map(([, x, y]) => x! + y!),
      ),
    ].sort((a, b) => a - b);
    return sums.slice(1).map((v, i) => v - sums[i]!);
  }

  test("8 screen px apart at fit and when zoomed, redrawn in place", async () => {
    const { set, request } = step({
      baseline: loaded("b", 100, 200),
      current: loaded("c", 100, 300),
    });
    render(<ViewerStage set={set} request={request} regions={[]} />);
    await flush();
    const paneA = worldIn("baseline-canvas-host");
    const hatch = layer(paneA, "hatch:baseline");
    // Fit is 2 canvas px per world px: 4 world px apart.
    expect(paneA.scale.x).toBe(2);
    for (const gap of gaps(hatch)) expect(gap).toBeCloseTo(4, 9);

    act(() => useViewState.getState().setZoom(2));
    await flush();
    expect(paneA.scale.x).toBe(4);
    expect(layer(paneA, "hatch:baseline")).toBe(hatch);
    for (const gap of gaps(hatch)) expect(gap).toBeCloseTo(2, 9);
  });
});

describe("saved ignore regions show read-only (R9)", () => {
  const SAVED = {
    id: "s1",
    x: 10,
    y: 10,
    width: 50,
    height: 50,
    viewport: "1280x720",
    paddingPx: 0,
    kind: "ignore" as const,
  };

  test.each([
    ["side-by-side", "candidate-canvas-host"],
    ["overlay", "single-stage-host"],
    ["diff", "single-stage-host"],
  ] as const)(
    "%s: drawn outside the editor, read-only; the editor makes them interactive",
    async (mode, host) => {
      setMode(mode);
      act(() =>
        useViewerStore.setState({
          savedRunIgnoreAreas: [SAVED],
          viewport: "1280x720",
        }),
      );
      const { set, request } = fullStep(400, 300);
      render(<ViewerStage set={set} request={request} regions={[]} />);
      await flush();
      // The saved region's shape in the ignore regions' layer.
      const shape = () =>
        (layer(worldIn(host), "ignore") as Box).children.find(
          (c) =>
            c instanceof fake.Graphics &&
            c.ops.some(
              ([op, ...xywh]) => op === "rect" && xywh.join() === "10,10,50,50",
            ),
        );
      expect(shape()).toBeDefined();
      expect(shape()!.eventMode).not.toBe("static");

      editorOn();
      await flush();
      expect(shape()!.eventMode).toBe("static");
    },
  );

  test("a pick preview the editor left behind is not drawn once it is closed (M7)", async () => {
    setMode("overlay");
    act(() => useViewerStore.setState({ regionInputMode: "pick" }));
    editorOn();
    const { set, request } = fullStep(400, 300);
    const r = render(
      <ViewerStage
        set={set}
        request={request}
        regions={[]}
        elementMap={{
          v: 1,
          elements: { "#card": { x: 20, y: 20, width: 40, height: 40 } },
          capturedAt: 0,
        }}
      />,
    );
    await flush();
    gesture(r.getByTestId("ignore-region-overlay"), ["pointermove", 80, 80]);
    await flush();
    const ignore = () => layer(worldIn("single-stage-host"), "ignore") as Box;
    expect(hasRect(ignore(), [20, 20, 40, 40])).toBe(true);

    // Closed with the pointer still over it (no pointerleave), in pick mode.
    act(() => useViewerStore.setState({ ignoreEditMode: "off" }));
    await flush();
    expect(hasRect(ignore(), [20, 20, 40, 40])).toBe(false);
  });
});

describe("every region surface follows the list's visibility (R10)", () => {
  const region = (
    id: string,
    x: number,
    over: Partial<DiffRegion> = {},
  ): DiffRegion => ({
    id,
    severity: "major",
    category: "visual",
    bbox: { x, y: 10, width: 20, height: 20 },
    description: "",
    source: "l1_pixel",
    ...over,
  });
  const SHOWN = region("shown", 10);
  const AUDIT = region("audit", 40, { source: "dynamic_text" });
  const MOVED = region("moved", 70, { category: "layout" });
  const at = (x: number) => [x, 10, 20, 20];

  test("the rectangles and the shading show what the list shows", async () => {
    const { set, request } = fullStep(400, 300);
    render(
      <ViewerStage
        set={set}
        request={request}
        regions={[SHOWN, AUDIT, MOVED]}
      />,
    );
    await flush();
    const paneB = () => worldIn("candidate-canvas-host");
    const shows = (label: string, x: number) =>
      hasRect(layer(paneB(), label) as Box, at(x));
    expect([10, 40, 70].map((x) => shows("regions", x))).toEqual([
      true,
      false,
      true,
    ]);
    expect([10, 40, 70].map((x) => shows("shading", x))).toEqual([
      true,
      false,
      true,
    ]);

    act(() => useViewState.getState().setShowSuppressed(true));
    await flush();
    expect(shows("regions", 40)).toBe(true);
    expect(shows("shading", 40)).toBe(true);

    act(() => useViewerPrefs.getState().set("hideDisplacement", true));
    await flush();
    expect(shows("regions", 70)).toBe(false);
    expect(shows("shading", 70)).toBe(false);
  });

  test("a click in Diff can't select a region the list hides", async () => {
    setMode("diff");
    const { set, request } = fullStep(400, 300);
    const r = render(
      <ViewerStage set={set} request={request} regions={[SHOWN, AUDIT]} />,
    );
    await flush();
    // The audit row spans image x 40–60: canvas 80–120.
    gesture(r.getByTestId("single-stage-host"), ["pointerup", 100, 40]);
    expect(useViewState.getState().selectedRegionId).toBeNull();

    act(() => useViewState.getState().setShowSuppressed(true));
    await flush();
    gesture(r.getByTestId("single-stage-host"), ["pointerup", 100, 40]);
    expect(useViewState.getState().selectedRegionId).toBe("audit");
  });

  test("the has-differences badge counts only what shows", async () => {
    const { set, request } = fullStep(400, 300);
    const r = render(
      <ViewerStage set={set} request={request} regions={[AUDIT]} />,
    );
    await flush();
    expect(r.queryAllByTestId("diff-badge")).toHaveLength(0);
    act(() => useViewState.getState().setShowSuppressed(true));
    expect(r.queryAllByTestId("diff-badge")).toHaveLength(2);
  });
});

describe("what the stage keeps", () => {
  test("it pins what it draws: a cache trim while it is mounted closes nothing it holds (M1)", async () => {
    const baseline = loaded("pin-b", 100, 100);
    const current = loaded("pin-c", 100, 100);
    __viewerBitmapCache.set(baseline);
    __viewerBitmapCache.set(current);
    const { set, request } = step({ baseline, current });
    const r = render(<ViewerStage set={set} request={request} regions={[]} />);
    await flush();

    // No one else pins them; a release elsewhere trims the cache.
    __viewerBitmapCache.retain([k("elsewhere")])();
    await flush();
    expect(baseline.bitmap.close).not.toHaveBeenCalled();
    expect(current.bitmap.close).not.toHaveBeenCalled();

    // Unmounted, the stage lets go, and only after its texture is gone.
    const textureOf = (b: FakeBitmap) =>
      fake.registry.textures.find((t) => t.bitmap === b)!;
    let textureGoneFirst: boolean | null = null;
    current.bitmap.close.mockImplementation(() => {
      textureGoneFirst = textureOf(current.bitmap).destroyed;
    });
    r.unmount();
    await flush();
    expect(current.bitmap.close).toHaveBeenCalledOnce();
    expect(textureGoneFirst).toBe(true);
  });

  test("a retry keeps what is mounted until the retried image settles (M4)", async () => {
    const mount = vi.spyOn(RENDERERS["side-by-side"], "mount");
    const current = loaded("c", 100, 100);
    const baseline = loaded("b", 100, 100);
    const request: ImageSetRequest = {
      baseline: baseline.key,
      current: current.key,
      diff: null,
    };
    const asSet = (
      images: ImageSetState["images"],
      failed: ImageSetState["failed"],
    ): ImageSetState => ({ status: "ready", images, failed, retry: () => {} });
    const r = render(
      <ViewerStage
        set={asSet({ current }, { baseline: true })}
        request={request}
        regions={[]}
      />,
    );
    await flush();
    expect(mount).toHaveBeenCalledTimes(1);
    const sprite = fake.registry.sprites.find((s) => s.label === "current")!;

    // Retry: the baseline is loading again.
    r.rerender(
      <ViewerStage
        set={{ ...asSet({ current }, {}), status: "loading" }}
        request={request}
        regions={[]}
      />,
    );
    await flush();
    expect(sprite.destroyed).toBe(false);
    expect(labels(worldIn("candidate-canvas-host"))).toContain("current");

    // The retried baseline is in: drawn with the current image.
    r.rerender(
      <ViewerStage
        set={asSet({ baseline, current }, {})}
        request={request}
        regions={[]}
      />,
    );
    await flush();
    expect(mount).toHaveBeenCalledTimes(2);
    expect(labels(worldIn("baseline-canvas-host"))).toContain("baseline");
  });

  test("overlay ↔ diff keeps the regions and the ignore regions mounted (N3)", async () => {
    setMode("overlay");
    const { set, request } = fullStep();
    render(<ViewerStage set={set} request={request} regions={REGIONS} />);
    await flush();
    const before = worldIn("single-stage-host");
    const kept = ["regions", "ignore"].map((l) => layer(before, l));
    setMode("diff");
    await flush();
    const after = worldIn("single-stage-host");
    expect(["regions", "ignore"].map((l) => layer(after, l))).toEqual(kept);
    for (const l of kept) expect(l.destroyed).toBe(false);
  });
});

describe("pixi's init, held (M6b, N2)", () => {
  test("an init that finishes after its stage was replaced is dropped, and nothing is destroyed mid-init", async () => {
    fake.registry.holdInit = true;
    setMode("overlay");
    const { set, request } = fullStep();
    render(<ViewerStage set={set} request={request} regions={[]} />);
    await flush();
    const [single] = fake.registry.created;
    setMode("side-by-side");
    await flush();
    const [paneA, paneB] = fake.registry.created.slice(1);

    // The side-by-side apps come up first; the replaced one after them.
    act(() => {
      paneA!.finishInit();
      paneB!.finishInit();
    });
    await flush();
    act(() => single!.finishInit());
    await flush();

    expect(labels(worldIn("candidate-canvas-host"))).toEqual([
      "current",
      "hatch:current",
      "ignore",
    ]);
    expect(single!.stage.children).toEqual([]);
    expect(single!.destroyed).toBe(true);
    expect(fake.registry.created.some((a) => a.destroyedMidInit)).toBe(false);
  });

  test("a failed init is reported, and the stage draws nothing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fake.registry.holdInit = true;
    const { set, request } = fullStep();
    render(<ViewerStage set={set} request={request} regions={[]} />);
    await flush();
    const [paneA, paneB] = fake.registry.created;
    act(() => {
      paneA!.finishInit(true);
      paneB!.finishInit();
    });
    await flush();
    expect(warn).toHaveBeenCalledWith(
      "viewer stage init failed",
      expect.any(Error),
    );
    expect(paneB!.stage.children).toEqual([]);
    expect(fake.registry.sprites).toEqual([]);
  });

  test("one pane's init failing destroys no app before its own init has settled", async () => {
    fake.registry.holdInit = true;
    const { set, request } = fullStep();
    const r = render(<ViewerStage set={set} request={request} regions={[]} />);
    await flush();
    const [paneA, paneB] = fake.registry.created;
    act(() => paneA!.finishInit(true));
    await flush();
    r.unmount();
    await flush();
    expect(paneB!.destroyed).toBe(false);

    act(() => paneB!.finishInit());
    await flush();
    expect(paneB!.destroyed).toBe(true);
    expect(fake.registry.created.some((a) => a.destroyedMidInit)).toBe(false);
  });
});

describe("the editor under a zoom, a pan and a taller baseline (M6a)", () => {
  // A 400×400 world (the baseline) over a 400×300 current image, fit 1.5 in
  // 800×600, zoomed 2× and panned (20, −10) world px: 3 canvas px per image
  // px, with the image's origin at canvas (−140, −330).
  async function editing() {
    setMode("overlay");
    editorOn();
    const { set, request } = step({
      baseline: loaded("b", 400, 400),
      current: loaded("c", 400, 300),
    });
    const r = render(<ViewerStage set={set} request={request} regions={[]} />);
    await flush();
    act(() =>
      useViewState.getState().setView({ zoom: 2, panX: 20, panY: -10 }),
    );
    await flush();
    const w = worldIn("single-stage-host");
    expect([w.scale.x, w.position.x, w.position.y]).toEqual([3, -140, -330]);
    return r.getByTestId("ignore-region-overlay");
  }
  const canvas = (x: number, y: number) => [3 * x - 140, 3 * y - 330] as const;
  const drafts = () => useViewerStore.getState().draftIgnoreAreas;

  test("a drag maps to image px; a drag from the hatched strip draws nothing", async () => {
    const overlay = await editing();
    gesture(
      overlay,
      ["pointerdown", ...canvas(60, 120)],
      ["pointermove", ...canvas(160, 220)],
      ["pointerup", ...canvas(160, 220)],
    );
    expect(drafts()).toEqual([
      expect.objectContaining({ x: 60, y: 120, width: 100, height: 100 }),
    ]);

    // Image y 305 is world, but below the current image: off it.
    gesture(
      overlay,
      ["pointerdown", ...canvas(100, 305)],
      ["pointermove", ...canvas(200, 310)],
      ["pointerup", ...canvas(200, 310)],
    );
    expect(drafts()).toHaveLength(1);
  });

  test("the handles' grab radius is in screen px", async () => {
    act(() =>
      useViewerStore.setState({
        draftIgnoreAreas: [
          {
            id: "d1",
            x: 60,
            y: 120,
            width: 100,
            height: 100,
            viewport: "1280x720",
            paddingPx: 0,
            kind: "ignore",
          },
        ],
        selectedIgnoreId: "d1",
      }),
    );
    const overlay = await editing();
    const d1 = () => drafts().find((d) => d.id === "d1")!;
    // 10 screen px off the south-east handle (image (160, 220)) grabs it.
    const [hx, hy] = canvas(160, 220);
    gesture(
      overlay,
      ["pointerdown", hx + 10, hy + 10],
      ["pointermove", ...canvas(200, 250)],
      ["pointerup", ...canvas(200, 250)],
    );
    expect(d1()).toMatchObject({ x: 60, y: 120, width: 140, height: 130 });

    // 12 screen px off misses it (11 is the radius), whatever the zoom.
    const [sx, sy] = canvas(200, 250);
    gesture(
      overlay,
      ["pointerdown", sx + 12, sy + 12],
      ["pointermove", sx + 40, sy + 40],
      ["pointerup", sx + 40, sy + 40],
    );
    expect(d1()).toMatchObject({ x: 60, y: 120, width: 140, height: 130 });
  });
});

// The document's queries. (Not `screen`: the fake pixi Application has a
// `screen` field, which the mock hoisting would read as the import.)
const page = () => within(document.body);

/** A host's pane: the host and the states shown over it. */
const paneOf = (testId: string): HTMLElement =>
  page().getByTestId(testId).parentElement!;

/** An image set as `useImageSet` hands it over. */
function imageSet(
  images: ImageSetState["images"],
  over: Partial<ImageSetState> = {},
): ImageSetState {
  return { status: "ready", images, failed: {}, retry: () => {}, ...over };
}

describe("what the stage can't show (spec §3.4)", () => {
  test("a failed baseline: side by side still draws the current image, and says so over pane A, with Retry", async () => {
    const retry = vi.fn();
    const current = loaded("c", 100, 100);
    render(
      <ViewerStage
        set={imageSet({ current }, { failed: { baseline: true }, retry })}
        request={{ baseline: k("failed-b"), current: current.key, diff: null }}
        regions={[]}
      />,
    );
    await flush();

    expect(labels(worldIn("candidate-canvas-host"))).toEqual([
      "current",
      "hatch:current",
      "ignore",
    ]);
    expect(labels(worldIn("baseline-canvas-host"))).toEqual([]);
    const paneA = within(paneOf("baseline-canvas-host"));
    expect(paneA.getByText("Couldn't load the baseline.")).toBeDefined();
    expect(
      within(paneOf("candidate-canvas-host")).queryByText(/Couldn't load/),
    ).toBeNull();
    fireEvent.click(paneA.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledOnce();
    expect(retry).toHaveBeenCalledWith("baseline");
  });

  test.each(["overlay", "diff"] as const)(
    "%s: a failed current image is said on the stage, with Retry",
    async (mode) => {
      setMode(mode);
      const retry = vi.fn();
      const baseline = loaded("b", 100, 100);
      const diff = loaded("d", 100, 100);
      render(
        <ViewerStage
          set={imageSet(
            { baseline, diff },
            { failed: { current: true }, retry },
          )}
          request={{
            baseline: baseline.key,
            current: k("failed-c"),
            diff: diff.key,
          }}
          regions={[]}
        />,
      );
      await flush();

      const stage = within(paneOf("single-stage-host"));
      expect(
        stage.getByText("Couldn't load the current screenshot."),
      ).toBeDefined();
      fireEvent.click(stage.getByRole("button", { name: "Retry" }));
      expect(retry).toHaveBeenCalledWith("current");
    },
  );

  test("no baseline: the current image in pane B, pane A empty and labelled No baseline, with the message", async () => {
    const { set, request } = step({ current: loaded("c", 100, 100) });
    render(<ViewerStage set={set} request={request} regions={[]} />);
    await flush();

    expect(labels(worldIn("candidate-canvas-host"))).toEqual([
      "current",
      "hatch:current",
      "ignore",
    ]);
    expect(labels(worldIn("baseline-canvas-host"))).toEqual([]);
    expect(page().getByText("No baseline")).toBeDefined();
    expect(page().queryByText("Baseline")).toBeNull();
    expect(
      within(paneOf("baseline-canvas-host")).getByText(
        "No baseline yet. Approve this step to make it the baseline.",
      ),
    ).toBeDefined();
  });

  test.each(["swipe", "flicker", "overlay", "diff"] as const)(
    "no baseline, with %s stored: drawn as side by side, and the mode is kept",
    async (mode) => {
      setMode(mode);
      const { set, request } = step({ current: loaded("c", 100, 100) });
      render(<ViewerStage set={set} request={request} regions={[]} />);
      await flush();

      expect(page().queryByTestId("single-stage-host")).toBeNull();
      expect(labels(worldIn("candidate-canvas-host"))).toContain("current");
      expect(page().queryByText(/No pixel changes/)).toBeNull();
      expect(useViewerPrefs.getState().prefs.mode).toBe(mode);
    },
  );

  test("loading: the canvas skeleton, busy, with no message; done once the images are in", async () => {
    const current = loaded("c", 100, 100);
    const baseline = loaded("b", 100, 100);
    const request: ImageSetRequest = {
      baseline: baseline.key,
      current: current.key,
      diff: null,
    };
    const r = render(
      <ViewerStage
        set={imageSet({ current }, { status: "loading" })}
        request={request}
        regions={[]}
      />,
    );
    await flush();
    const hosts = ["baseline-canvas-host", "candidate-canvas-host"];
    for (const id of hosts) {
      expect(page().getByTestId(id).getAttribute("aria-busy")).toBe("true");
    }
    // The live regions are there, and say nothing.
    for (const region of page().getAllByTestId("stage-states")) {
      expect(region.textContent).toBe("");
    }
    expect(fake.registry.sprites).toHaveLength(0);

    r.rerender(
      <ViewerStage
        set={imageSet({ baseline, current })}
        request={request}
        regions={[]}
      />,
    );
    await flush();
    for (const id of hosts) {
      expect(page().getByTestId(id).hasAttribute("aria-busy")).toBe(false);
    }
  });

  test("Diff, sizes that differ: the faded current image, its hatching and the message", async () => {
    setMode("diff");
    const { set, request } = step({
      baseline: loaded("b", 100, 200),
      current: loaded("c", 100, 300),
    });
    render(<ViewerStage set={set} request={request} regions={[]} />);
    await flush();

    expect(labels(worldIn("single-stage-host"))).toEqual([
      "current",
      "hatch:current",
      "ignore",
    ]);
    expect(
      within(paneOf("single-stage-host")).getByText(
        "The screenshots are different sizes (100×200 and 100×300), so there's no pixel diff. Compare them with Side by side, Swipe or Flicker.",
      ),
    ).toBeDefined();
  });

  test("Diff, a legacy step with a diff and no kept image: the faded current image and the rectangles, with the message (R4)", async () => {
    setMode("diff");
    const { set, request } = step({
      baseline: loaded("b", 100, 100),
      current: loaded("c", 100, 100),
    });
    render(
      <ViewerStage
        set={set}
        request={request}
        regions={REGIONS}
        legacyMissing
        stepHasDiff
      />,
    );
    await flush();

    expect(labels(worldIn("single-stage-host"))).toEqual([
      "current",
      "hatch:current",
      "regions",
      "ignore",
    ]);
    expect(
      page().getByText("No diff image was kept for this step."),
    ).toBeDefined();
  });

  test("Diff, no diff on the step: no pixel changes, whatever legacyMissing says (R4)", async () => {
    setMode("diff");
    const { set, request } = step({
      baseline: loaded("b", 100, 100),
      current: loaded("c", 100, 100),
    });
    render(
      <ViewerStage
        set={set}
        request={request}
        regions={[]}
        legacyMissing
        stepHasDiff={false}
      />,
    );
    await flush();

    expect(
      page().getByText(
        "No pixel changes between the baseline and the current screenshot.",
      ),
    ).toBeDefined();
    expect(page().queryByText(/No diff image was kept/)).toBeNull();
  });

  test("Diff, with no word on the step's diff: a region of the step counts as one", async () => {
    setMode("diff");
    const { set, request } = step({
      baseline: loaded("b", 100, 100),
      current: loaded("c", 100, 100),
    });
    render(
      <ViewerStage
        set={set}
        request={request}
        regions={REGIONS}
        legacyMissing
      />,
    );
    await flush();

    expect(
      page().getByText("No diff image was kept for this step."),
    ).toBeDefined();
    expect(page().queryByText(/No pixel changes/)).toBeNull();
  });

  /** The labels of the sprites still on a stage. */
  const sprites = () =>
    fake.registry.sprites.filter((s) => !s.destroyed).map((s) => s.label);
  const TOO_LARGE = /too large to draw on this device/;

  test("too large: a current image past the GL context's limit is left out, the baseline drawn, and pane B says so (Review Focus 1, I2)", async () => {
    fake.registry.maxTextureSize = 16384;
    const mount = vi.spyOn(RENDERERS["side-by-side"], "mount");
    const { set, request } = step({
      baseline: loaded("b", 1440, 900),
      current: loaded("c", 1440, 20000),
    });
    render(<ViewerStage set={set} request={request} regions={REGIONS} />);
    await flush();

    expect(mount).toHaveBeenCalledOnce();
    expect(sprites()).toEqual(["baseline"]);
    // Never a texture of it.
    expect(fake.registry.textures.map((t) => t.width * t.height)).not.toContain(
      1440 * 20000,
    );
    expect(labels(worldIn("baseline-canvas-host"))).toContain("baseline");
    expect(
      within(paneOf("candidate-canvas-host")).getByText(
        "This screenshot is too large to draw on this device (1440×20000; the limit is 16384 px).",
      ),
    ).toBeDefined();
    expect(
      within(paneOf("baseline-canvas-host")).queryByText(TOO_LARGE),
    ).toBeNull();
  });

  test("too large: a baseline past the limit still lets side by side draw the current image, and pane A says so (I2)", async () => {
    fake.registry.maxTextureSize = 16384;
    const { set, request } = step({
      baseline: loaded("b", 1440, 20000),
      current: loaded("c", 1440, 900),
    });
    render(<ViewerStage set={set} request={request} regions={[]} />);
    await flush();

    expect(sprites()).toEqual(["current"]);
    expect(labels(worldIn("candidate-canvas-host"))).toContain("current");
    // Its size still makes the world: the current image is hatched below.
    expect(
      layer(worldIn("candidate-canvas-host"), "hatch:current").points().length,
    ).toBeGreaterThan(0);
    expect(
      within(paneOf("baseline-canvas-host")).getByText(
        "This screenshot is too large to draw on this device (1440×20000; the limit is 16384 px).",
      ),
    ).toBeDefined();
    expect(
      within(paneOf("candidate-canvas-host")).queryByText(TOO_LARGE),
    ).toBeNull();
    // No tooltip over a strip of an image that is not drawn.
    expect(
      paneOf("baseline-canvas-host").querySelector(
        '[data-testid="hatch-tooltip"]',
      ),
    ).toBeNull();
  });

  test("too large: Diff never draws the baseline, so a baseline past the limit blocks nothing (I2)", async () => {
    fake.registry.maxTextureSize = 16384;
    setMode("diff");
    const diffMount = vi.spyOn(RENDERERS.diff, "mount");
    const { set, request } = step({
      baseline: loaded("b", 1440, 20000),
      current: loaded("c", 1440, 900),
      diff: loaded("d", 1440, 900),
    });
    render(<ViewerStage set={set} request={request} regions={[]} />);
    await flush();

    expect(diffMount).toHaveBeenCalledOnce();
    expect(sprites()).toEqual(["current", "diff"]);
    expect(page().queryByText(TOO_LARGE)).toBeNull();
  });

  test("too large: with nothing left to draw the renderer is not mounted, in any mode", async () => {
    fake.registry.maxTextureSize = 16384;
    const mounts = (["side-by-side", "overlay", "diff"] as const).map((m) =>
      vi.spyOn(RENDERERS[m], "mount"),
    );
    const { set, request } = step({
      baseline: loaded("b", 1440, 20000),
      current: loaded("c", 1440, 20000),
      diff: loaded("d", 1440, 20000),
    });
    render(<ViewerStage set={set} request={request} regions={REGIONS} />);
    await flush();
    expect(labels(worldIn("candidate-canvas-host"))).toEqual([]);
    expect(
      within(paneOf("baseline-canvas-host")).getByText(TOO_LARGE),
    ).toBeDefined();
    expect(
      within(paneOf("candidate-canvas-host")).getByText(TOO_LARGE),
    ).toBeDefined();

    for (const mode of ["overlay", "diff"] as const) {
      setMode(mode);
      await flush();
      expect(labels(worldIn("single-stage-host"))).toEqual([]);
      expect(
        within(paneOf("single-stage-host")).getAllByText(TOO_LARGE).length,
      ).toBeGreaterThan(0);
    }
    for (const mount of mounts) expect(mount).not.toHaveBeenCalled();
    expect(fake.registry.sprites).toHaveLength(0);
  });

  test("too large is the GL context's limit, not the fallback's", async () => {
    fake.registry.maxTextureSize = 16384;
    const mount = vi.spyOn(RENDERERS["side-by-side"], "mount");
    const { set, request } = step({
      baseline: loaded("b", 1440, 9000),
      current: loaded("c", 1440, 9000),
    });
    render(<ViewerStage set={set} request={request} regions={[]} />);
    await flush();

    expect(mount).toHaveBeenCalledOnce();
    expect(sprites()).toEqual(["baseline", "current"]);
    expect(page().queryByText(TOO_LARGE)).toBeNull();
  });

  test("too large, with no GL context to ask: the 8192 fallback", async () => {
    const mount = vi.spyOn(RENDERERS["side-by-side"], "mount");
    const { set, request } = step({
      baseline: loaded("b", 1440, 900),
      current: loaded("c", 1440, 9000),
    });
    render(<ViewerStage set={set} request={request} regions={[]} />);
    await flush();

    expect(mount).toHaveBeenCalledOnce();
    expect(sprites()).toEqual(["baseline"]);
    expect(
      within(paneOf("candidate-canvas-host")).getByText(
        "This screenshot is too large to draw on this device (1440×9000; the limit is 8192 px).",
      ),
    ).toBeDefined();
  });

  test("Diff, a failed diff image: the faded current image, a Retry for the diff image, and no claim of no changes (M6)", async () => {
    setMode("diff");
    const retry = vi.fn();
    const baseline = loaded("b", 100, 100);
    const current = loaded("c", 100, 100);
    render(
      <ViewerStage
        set={imageSet({ baseline, current }, { failed: { diff: true }, retry })}
        request={{
          baseline: baseline.key,
          current: current.key,
          diff: k("failed-d"),
        }}
        regions={[]}
        stepHasDiff={false}
      />,
    );
    await flush();

    expect(labels(worldIn("single-stage-host"))).toEqual([
      "current",
      "hatch:current",
      "ignore",
    ]);
    expect(
      fake.registry.sprites.find((s) => s.label === "current")!.alpha,
    ).toBe(DIFF_CURRENT_ALPHA);
    const stage = within(paneOf("single-stage-host"));
    expect(stage.getByText("Couldn't load the diff image.")).toBeDefined();
    fireEvent.click(stage.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledWith("diff");
    expect(page().queryByText(/No pixel changes/)).toBeNull();
  });

  test("Diff, with no word on the step's diff: an audit row is no pixel diff (I1)", async () => {
    setMode("diff");
    const { set, request } = step({
      baseline: loaded("b", 100, 100),
      current: loaded("c", 100, 100),
    });
    const audit = (source: string, id: string): DiffRegion => ({
      ...REGIONS[0]!,
      id,
      source,
    });
    render(
      <ViewerStage
        set={set}
        request={request}
        regions={[audit("dynamic_text", "t1"), audit("axe", "a1")]}
        legacyMissing
      />,
    );
    await flush();

    expect(
      page().getByText(
        "No pixel changes between the baseline and the current screenshot.",
      ),
    ).toBeDefined();
    expect(page().queryByText(/No diff image was kept/)).toBeNull();
  });

  describe("Retry keeps the keyboard's place (M2)", () => {
    /**
     * The stage under an image set that does what `useImageSet` does on a
     * Retry: the role is on its way again at once, in the same update.
     */
    const control: {
      settle?: (
        images: ImageSetState["images"],
        failed?: ImageSetState["failed"],
      ) => void;
    } = {};
    function Retrying({
      initial,
      request,
      onRetry,
    }: {
      initial: ImageSetState;
      request: ImageSetRequest;
      onRetry: (role: ImageRole) => void;
    }) {
      const [set, setSet] = useState(initial);
      control.settle = (images, failed = {}) =>
        setSet((s) => ({ ...s, status: "ready", images, failed }));
      const retry = useCallback(
        (role: ImageRole) => {
          onRetry(role);
          setSet((s) => {
            const failed = { ...s.failed };
            delete failed[role];
            return { ...s, status: "loading", failed };
          });
        },
        [onRetry],
      );
      return (
        <ViewerStage set={{ ...set, retry }} request={request} regions={[]} />
      );
    }

    async function failedBaseline() {
      const onRetry = vi.fn();
      const current = loaded("c", 100, 100);
      const baseline = loaded("b", 100, 100);
      const request: ImageSetRequest = {
        baseline: baseline.key,
        current: current.key,
        diff: null,
      };
      render(
        <Retrying
          initial={imageSet({ current }, { failed: { baseline: true } })}
          request={request}
          onRetry={onRetry}
        />,
      );
      await flush();
      const paneA = within(paneOf("baseline-canvas-host"));
      const button = paneA.getByRole("button", { name: "Retry" });
      act(() => button.focus());
      fireEvent.click(button);
      await flush();
      return { onRetry, button, paneA, baseline, current };
    }

    test("the card stays while the image loads again, its Retry focused, busy and inert", async () => {
      const { onRetry, button, paneA } = await failedBaseline();
      expect(onRetry).toHaveBeenCalledOnce();
      expect(onRetry).toHaveBeenCalledWith("baseline");
      expect(document.activeElement).toBe(button);
      expect(document.activeElement).not.toBe(document.body);
      expect(paneA.getByText("Couldn't load the baseline.")).toBeDefined();
      expect(button.getAttribute("aria-disabled")).toBe("true");
      expect(button.getAttribute("aria-busy")).toBe("true");
      fireEvent.click(button);
      expect(onRetry).toHaveBeenCalledOnce();
    });

    test("failed again: the same Retry, focused, takes a press again", async () => {
      const { onRetry, button, current } = await failedBaseline();
      act(() => control.settle!({ current }, { baseline: true }));
      await flush();
      expect(document.activeElement).toBe(button);
      expect(button.hasAttribute("aria-disabled")).toBe(false);
      fireEvent.click(button);
      expect(onRetry).toHaveBeenCalledTimes(2);
    });

    test("in: the card goes, and the focus goes to its pane, not the page", async () => {
      const { baseline, current } = await failedBaseline();
      act(() => control.settle!({ baseline, current }));
      await flush();
      expect(
        within(paneOf("baseline-canvas-host")).queryByRole("button"),
      ).toBeNull();
      expect(document.activeElement).toBe(
        page().getByTestId("baseline-canvas-host"),
      );
    });
  });

  test("back on a step before the one in between settled: it mounts again only once all its images are in (NB1)", async () => {
    const mount = vi.spyOn(RENDERERS["side-by-side"], "mount");
    const a = {
      baseline: loaded("A-b", 100, 100),
      current: loaded("A-c", 100, 100),
    };
    const reqA: ImageSetRequest = {
      baseline: a.baseline.key,
      current: a.current.key,
      diff: null,
    };
    const reqB: ImageSetRequest = {
      baseline: k("B-b"),
      current: k("B-c"),
      diff: null,
    };
    const r = render(
      <ViewerStage set={imageSet(a)} request={reqA} regions={[]} />,
    );
    await flush();
    expect(mount).toHaveBeenCalledTimes(1);

    // On to B, still loading; back to A while its baseline loads again.
    r.rerender(
      <ViewerStage
        set={imageSet({}, { status: "loading" })}
        request={reqB}
        regions={[]}
      />,
    );
    await flush();
    r.rerender(
      <ViewerStage
        set={imageSet({ current: a.current }, { status: "loading" })}
        request={reqA}
        regions={[]}
      />,
    );
    await flush();
    expect(mount).toHaveBeenCalledTimes(1);
    expect(fake.registry.sprites.filter((s) => !s.destroyed)).toEqual([]);

    r.rerender(<ViewerStage set={imageSet(a)} request={reqA} regions={[]} />);
    await flush();
    expect(mount).toHaveBeenCalledTimes(2);
    expect(labels(worldIn("baseline-canvas-host"))).toEqual([
      "baseline",
      "hatch:baseline",
    ]);
  });
});

describe("the hatching's tooltips (spec §3.1)", () => {
  // A taller baseline and a wider current image: a 150×200 world, fit 2 in
  // 800×600 at canvas (250, 100). The baseline misses the right strip
  // (x 100–150), the current image the bottom one (y 100–200).
  const BASELINE_STRIP = { x: 100, y: 0, w: 50, h: 200 };
  const CURRENT_STRIP = { x: 0, y: 100, w: 150, h: 100 };
  const WORLD = { w: 150, h: 200 };
  const mismatched = () =>
    step({
      baseline: loaded("b", 100, 200),
      current: loaded("c", 150, 100),
      diff: loaded("d", 150, 100),
    });

  const tips = (testId: string): HTMLElement[] =>
    Array.from(
      page()
        .getByTestId(testId)
        .querySelectorAll<HTMLElement>('[data-testid="hatch-tooltip"]'),
    );
  const box = (el: HTMLElement) =>
    [el.style.left, el.style.top, el.style.width, el.style.height].map(
      parseFloat,
    );
  const onScreen = (
    view: { zoom: number; panX: number; panY: number },
    r: { x: number; y: number; w: number; h: number },
  ) => {
    const t = transformFor(WORLD, VIEWPORT, view);
    const a = worldToCanvas(t, { x: r.x, y: r.y });
    const b = worldToCanvas(t, { x: r.x + r.w, y: r.y + r.h });
    return [a.x, a.y, b.x - a.x, b.y - a.y];
  };

  test("side by side: each pane's strip says which screenshot it is not in, under the world's transform", async () => {
    const { set, request } = mismatched();
    render(<ViewerStage set={set} request={request} regions={[]} />);
    await flush();
    const fit = { zoom: 1, panX: 0, panY: 0 };

    const [a, ...moreA] = tips("baseline-canvas-host");
    expect(moreA).toEqual([]);
    expect(a!.title).toBe("Not in the baseline");
    expect(box(a!)).toEqual(onScreen(fit, BASELINE_STRIP));
    expect(box(a!)).toEqual([450, 100, 100, 400]);

    const [b, ...moreB] = tips("candidate-canvas-host");
    expect(moreB).toEqual([]);
    expect(b!.title).toBe("Not in the current screenshot");
    expect(box(b!)).toEqual(onScreen(fit, CURRENT_STRIP));

    // They follow the zoom and the pan.
    const view = { zoom: 2, panX: 10, panY: -5 };
    act(() => useViewState.getState().setView(view));
    await flush();
    expect(box(tips("baseline-canvas-host")[0]!)).toEqual(
      onScreen(view, BASELINE_STRIP),
    );
    expect(box(tips("candidate-canvas-host")[0]!)).toEqual(
      onScreen(view, CURRENT_STRIP),
    );
  });

  test.each([
    {
      mode: "overlay" as const,
      titles: ["Not in the baseline", "Not in the current screenshot"],
      hatches: ["hatch:baseline", "hatch:current"],
    },
    {
      mode: "diff" as const,
      titles: ["Not in the current screenshot"],
      hatches: ["hatch:current"],
    },
  ])(
    "$mode: a tooltip for each hatching it draws",
    async ({ mode, titles, hatches }) => {
      setMode(mode);
      const { set, request } = mismatched();
      render(<ViewerStage set={set} request={request} regions={[]} />);
      await flush();

      expect(tips("single-stage-host").map((t) => t.title)).toEqual(titles);
      const world = worldIn("single-stage-host");
      expect(
        labels(world).filter(
          (l) => l.startsWith("hatch:") && layer(world, l).points().length > 0,
        ),
      ).toEqual(hatches);
    },
  );

  test("none where the images cover the world, and none before they are drawn", async () => {
    const same = fullStep();
    const r = render(
      <ViewerStage set={same.set} request={same.request} regions={[]} />,
    );
    await flush();
    expect(tips("baseline-canvas-host")).toEqual([]);
    expect(tips("candidate-canvas-host")).toEqual([]);

    const { set, request } = mismatched();
    r.rerender(
      <ViewerStage
        set={{
          ...set,
          status: "loading",
          images: { current: set.images.current! },
        }}
        request={request}
        regions={[]}
      />,
    );
    await flush();
    expect(tips("baseline-canvas-host")).toEqual([]);
    expect(tips("candidate-canvas-host")).toEqual([]);
  });
});
