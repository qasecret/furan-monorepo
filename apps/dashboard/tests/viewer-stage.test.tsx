import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The compositor with pixi faked: every display object a renderer or the
 * host adds carries a label, so the stacking order is the world's children's
 * labels, in order. Textures and sprites are recorded so a test can tell
 * which bitmaps were ever drawn and what became of their textures.
 */
const fake = vi.hoisted(() => {
  class Point {
    constructor(
      public x = 0,
      public y = 0,
    ) {}
    set(x: number, y: number = x) {
      this.x = x;
      this.y = y;
    }
  }

  class Node {
    label = "";
    parent: Box | null = null;
    destroyed = false;
    alpha = 1;
    visible = true;
    eventMode = "passive";
    cursor = "";
    x = 0;
    y = 0;
    position = new Point();
    scale = new Point(1, 1);
    on() {
      return this;
    }
    removeFromParent() {
      this.parent?.removeChild(this);
    }
    destroy(_options?: unknown) {
      this.destroyed = true;
      this.removeFromParent();
    }
  }

  class Box extends Node {
    children: Node[] = [];
    addChild<T extends Node>(child: T): T {
      // pixi re-appends a child it already holds.
      if (child.parent === this) {
        this.children.splice(this.children.indexOf(child), 1);
        this.children.push(child);
        return child;
      }
      child.parent?.removeChild(child);
      this.children.push(child);
      child.parent = this;
      return child;
    }
    removeChild<T extends Node>(child: T): T {
      const i = this.children.indexOf(child);
      if (i >= 0) this.children.splice(i, 1);
      child.parent = null;
      return child;
    }
    override destroy(options?: unknown) {
      const kids = this.children.slice();
      for (const kid of kids) this.removeChild(kid);
      super.destroy(options);
      const deep =
        options === true ||
        (typeof options === "object" &&
          options !== null &&
          (options as { children?: boolean }).children === true);
      if (deep) for (const kid of kids) kid.destroy(options);
    }
  }

  type Op = [string, ...number[]];
  class Graphics extends Box {
    ops: Op[] = [];
    strokes: Array<Record<string, unknown>> = [];
    rect(x: number, y: number, w: number, h: number) {
      this.ops.push(["rect", x, y, w, h]);
      return this;
    }
    circle(x: number, y: number, r: number) {
      this.ops.push(["circle", x, y, r]);
      return this;
    }
    moveTo(x: number, y: number) {
      this.ops.push(["moveTo", x, y]);
      return this;
    }
    lineTo(x: number, y: number) {
      this.ops.push(["lineTo", x, y]);
      return this;
    }
    fill() {
      return this;
    }
    stroke(style: Record<string, unknown> = {}) {
      this.strokes.push(style);
      return this;
    }
    clear() {
      this.ops = [];
      this.strokes = [];
      return this;
    }
    /** The hatch's line ends, as drawn. */
    points(): Array<{ x: number; y: number }> {
      return this.ops
        .filter(([op]) => op === "moveTo" || op === "lineTo")
        .map(([, x, y]) => ({ x: x!, y: y! }));
    }
  }

  class Text extends Box {
    width = 60;
    height = 12;
  }

  interface BitmapLike {
    width: number;
    height: number;
  }

  class TextureSource {
    destroyed = false;
    constructor(public resource: BitmapLike | null) {}
    destroy() {
      this.destroyed = true;
      this.resource = null;
    }
  }

  class Texture {
    source: TextureSource;
    destroyed = false;
    skipCache: unknown;
    width: number;
    height: number;
    constructor(public bitmap: BitmapLike) {
      this.source = new TextureSource(bitmap);
      this.width = bitmap.width;
      this.height = bitmap.height;
    }
    static from(bitmap: BitmapLike, skipCache?: boolean) {
      const t = new Texture(bitmap);
      t.skipCache = skipCache;
      registry.textures.push(t);
      return t;
    }
    destroy(destroySource?: boolean) {
      this.destroyed = true;
      if (destroySource) this.source.destroy();
    }
  }

  class Sprite extends Box {
    constructor(public texture: Texture) {
      super();
      registry.sprites.push(this);
    }
    override destroy(options?: unknown) {
      super.destroy(options);
      const o = options as { texture?: boolean; textureSource?: boolean };
      if (o?.texture) this.texture.destroy(o.textureSource);
    }
  }

  class Application {
    canvas = document.createElement("canvas");
    stage = new Box();
    screen = { width: 0, height: 0 };
    ticker = { add: () => {}, remove: () => {} };
    renderer = {
      background: { color: 0 },
      resize: (w: number, h: number) => {
        this.screen = { width: w, height: h };
      },
    };
    destroyed = false;
    async init(opts: { width: number; height: number }) {
      this.screen = { width: opts.width, height: opts.height };
      this.canvas.getBoundingClientRect = () =>
        ({
          left: 0,
          top: 0,
          right: opts.width,
          bottom: opts.height,
          width: opts.width,
          height: opts.height,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }) as DOMRect;
      registry.apps.push(this);
    }
    destroy() {
      this.destroyed = true;
      this.canvas.remove();
    }
  }

  const registry = {
    apps: [] as Application[],
    textures: [] as Texture[],
    sprites: [] as Sprite[],
  };

  return { Box, Graphics, Sprite, Texture, Text, Application, registry };
});

vi.mock("pixi.js/unsafe-eval", () => ({}));
vi.mock("pixi.js", () => ({
  Application: fake.Application,
  Container: fake.Box,
  Graphics: fake.Graphics,
  Sprite: fake.Sprite,
  Text: fake.Text,
  Texture: fake.Texture,
}));

import {
  useImageSet,
  type ImageRole,
  type ImageSetRequest,
  type ImageSetState,
  type LoadedImage,
} from "@/components/diff-viewer/image-set";
import type { DiffRegion } from "@/components/diff-viewer/layers/regionTypes";
import { RENDERERS } from "@/components/diff-viewer/modes/types";
import type { ElementMap } from "@/components/diff-viewer/useElementMap";
import { useViewerStore } from "@/components/diff-viewer/useViewerStore";
import { useViewState } from "@/components/diff-viewer/view-state";
import { transformFor } from "@/components/diff-viewer/viewer-geometry";
import {
  DEFAULT_VIEWER_PREFS,
  useViewerPrefs,
  type ViewerMode,
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

beforeEach(() => {
  counter += 1;
  fake.registry.apps.length = 0;
  fake.registry.textures.length = 0;
  fake.registry.sprites.length = 0;
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

  test("shading shows only with highlight on, the editor's layer only while editing, each in its place", async () => {
    act(() =>
      useViewerPrefs.setState((s) => ({
        prefs: { ...s.prefs, highlight: false },
      })),
    );
    const { set, request } = fullStep();
    render(<ViewerStage set={set} request={request} regions={REGIONS} />);
    await flush();
    const paneB = () => labels(worldIn("candidate-canvas-host"));
    expect(paneB()).toEqual(["current", "hatch:current", "regions"]);

    // Mounted after the regions, still stacked under them.
    act(() =>
      useViewerPrefs.setState((s) => ({
        prefs: { ...s.prefs, highlight: true },
      })),
    );
    await flush();
    expect(paneB()).toEqual(["current", "hatch:current", "shading", "regions"]);

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

  test("swipe and flicker draw as side by side until they have renderers (R1)", () => {
    expect(RENDERERS.swipe).toBe(RENDERERS["side-by-side"]);
    expect(RENDERERS.flicker).toBe(RENDERERS["side-by-side"]);
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
      order: ["current", "hatch:current"],
    },
    {
      mode: "overlay" as const,
      host: "single-stage-host",
      order: ["baseline", "current", "hatch:baseline", "hatch:current"],
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
    ]);
  });

  test("in Diff, a baseline arriving after the drawn images reshapes the world without a second mount", async () => {
    setMode("diff");
    const diffMount = vi.spyOn(RENDERERS.diff, "mount");
    const req = stepReq("L");
    // A taller baseline: the world grows below the current image.
    sizes.set(req.baseline!, { w: 100, h: 200 });
    render(<Loaded req={req} />);
    await flush();

    await respond(req.current!, req.diff!);
    expect(diffMount).toHaveBeenCalledTimes(1);
    const single = worldIn("single-stage-host");
    expect(layer(single, "hatch:current").points()).toEqual([]);

    await respond(req.baseline!);
    expect(diffMount).toHaveBeenCalledTimes(1);
    const hatch = layer(single, "hatch:current").points();
    expect(hatch.length).toBeGreaterThan(0);
    for (const p of hatch) {
      expect(p.y).toBeGreaterThanOrEqual(100);
      expect(p.y).toBeLessThanOrEqual(200);
    }
    // The world is taller, so its fit (and the transform) follows.
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
