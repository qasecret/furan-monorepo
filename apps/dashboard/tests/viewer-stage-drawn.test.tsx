/**
 * The stage's `data-stage-drawn` test hook: the scale harness times a step
 * change by waiting for the stage root to carry the new step's checkpoint id.
 * The hook says one thing, that the renderer put the step's images on the
 * stage and a frame has gone by since.
 */
import { act, cleanup, render } from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
  type MockInstance,
} from "vitest";

import { fake } from "./pixi-fake";

vi.mock("pixi.js/unsafe-eval", () => ({}));
vi.mock("pixi.js", async () => (await import("./pixi-fake")).pixiModule);

import type { ViewerMode } from "@/components/diff-viewer/comparison-modes";
import {
  type ImageRole,
  type ImageSetRequest,
  type ImageSetState,
  type LoadedImage,
} from "@/components/diff-viewer/image-set";
import { RENDERERS } from "@/components/diff-viewer/modes/types";
import { useViewerStore } from "@/components/diff-viewer/useViewerStore";
import { useViewState } from "@/components/diff-viewer/view-state";
import {
  DEFAULT_VIEWER_PREFS,
  useViewerPrefs,
} from "@/components/diff-viewer/viewer-prefs";
import { ViewerStage } from "@/components/diff-viewer/ViewerStage";

const ATTR = "data-stage-drawn";

let counter = 0;
/** A key no other test uses: the image loader's cache is module-wide. */
const k = (name: string): string => `sd${counter}-${name}`;

function loaded(name: string, w: number, h: number): LoadedImage {
  const key = k(name);
  const bitmap = {
    width: w,
    height: h,
    close: vi.fn(),
  } as unknown as ImageBitmap;
  return { key, bitmap, size: { w, h } };
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

/** A step with all three images, under names no other step shares. */
function fullStep(tag: string, w = 100, h = 100) {
  return step({
    baseline: loaded(`${tag}-b`, w, h),
    current: loaded(`${tag}-c`, w, h),
    diff: loaded(`${tag}-d`, w, h),
  });
}

/** Let pixi's init, promise chains and React effects run to a standstill. */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

function setMode(mode: ViewerMode): void {
  act(() => useViewerPrefs.setState((s) => ({ prefs: { ...s.prefs, mode } })));
}

// The frames the stage asks for, held until a test lets one go by.
let frames = new Map<number, FrameRequestCallback>();
let nextFrame = 1;
const frameRequests = { requested: 0, cancelled: 0 };

/** One animation frame: every callback asked for so far runs once. */
function runFrame(): void {
  const due = [...frames.entries()];
  frames = new Map();
  for (const [, callback] of due) callback(0);
}

beforeEach(() => {
  counter += 1;
  frames = new Map();
  nextFrame = 1;
  frameRequests.requested = 0;
  frameRequests.cancelled = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = nextFrame++;
    frames.set(id, callback);
    frameRequests.requested += 1;
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    if (frames.delete(id)) frameRequests.cancelled += 1;
  });
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

/** The stage's root element: the one the hook is on. */
function stageRoot(container: HTMLElement): HTMLElement {
  const root = container.firstElementChild;
  if (!(root instanceof HTMLElement))
    throw new Error("the stage rendered nothing");
  return root;
}

const drawnOf = (root: HTMLElement): string | null => root.getAttribute(ATTR);

/** How many images are on a stage right now. */
const spritesOnStage = () =>
  fake.registry.sprites.filter((s) => !s.destroyed).length;

describe("data-stage-drawn", () => {
  test("sets data-stage-drawn only after the active step is drawn", async () => {
    const { set, request } = fullStep("one");
    const { container } = render(
      <ViewerStage
        set={set}
        request={request}
        regions={[]}
        checkpointId="cp-1"
      />,
    );
    const root = stageRoot(container);
    // Before the stage is up, and before pixi has anything to draw.
    expect(drawnOf(root)).toBeNull();

    await flush();
    // The renderer has mounted and put the images up, but no frame has gone
    // by: the step is not yet drawn.
    expect(spritesOnStage()).toBeGreaterThan(0);
    expect(drawnOf(root)).toBeNull();
    expect(frameRequests.requested).toBe(1);

    runFrame();
    expect(drawnOf(root)).toBe("cp-1");
  });

  test("moves it on a step change", async () => {
    const first = fullStep("one");
    const second = fullStep("two", 120, 80);
    const r = render(
      <ViewerStage
        set={first.set}
        request={first.request}
        regions={[]}
        checkpointId="cp-1"
      />,
    );
    await flush();
    runFrame();
    const root = stageRoot(r.container);
    expect(drawnOf(root)).toBe("cp-1");

    r.rerender(
      <ViewerStage
        set={second.set}
        request={second.request}
        regions={[]}
        checkpointId="cp-2"
      />,
    );
    await flush();
    // The old step's mark is gone as soon as the step changes, and the new
    // one waits for its own frame.
    expect(drawnOf(root)).toBeNull();

    runFrame();
    expect(drawnOf(root)).toBe("cp-2");
  });

  test("a frame still pending when the step changes never marks the old step", async () => {
    const first = fullStep("one");
    const second = fullStep("two", 120, 80);
    const r = render(
      <ViewerStage
        set={first.set}
        request={first.request}
        regions={[]}
        checkpointId="cp-1"
      />,
    );
    await flush();
    // The first step's frame has not gone by yet.
    r.rerender(
      <ViewerStage
        set={second.set}
        request={second.request}
        regions={[]}
        checkpointId="cp-2"
      />,
    );
    await flush();
    const root = stageRoot(r.container);

    runFrame();
    expect(drawnOf(root)).toBe("cp-2");
    expect(frameRequests.cancelled).toBeGreaterThan(0);
  });

  test("never names the next step while the previous one is on the stage", async () => {
    // What the harness's D5.next rests on: the stage can name step B only
    // once B's own images are mounted and a frame has gone by, never while
    // A's are still up and B's are on their way.
    const a = fullStep("a");
    const b = {
      baseline: loaded("b-b", 120, 80),
      current: loaded("b-c", 120, 80),
      diff: loaded("b-d", 120, 80),
    };
    const bRequest: ImageSetRequest = {
      baseline: b.baseline.key,
      current: b.current.key,
      diff: b.diff.key,
    };
    const loading = (
      images: Partial<Record<ImageRole, LoadedImage>>,
    ): ImageSetState => ({
      status: "loading",
      images,
      failed: {},
      retry: () => {},
    });

    // One ordered log of mounts, disposals and every write to the hook.
    const events: string[] = [];
    let mounts = 0;
    const renderer = RENDERERS["side-by-side"];
    const real = renderer.mount;
    vi.spyOn(renderer, "mount").mockImplementation(
      (...args: Parameters<typeof real>) => {
        const n = ++mounts;
        events.push(`mount ${n}`);
        const handle = real(...args);
        return {
          update: (input) => handle.update(input),
          dispose: () => {
            events.push(`dispose ${n}`);
            handle.dispose();
          },
        };
      },
    );

    const r = render(
      <ViewerStage
        set={a.set}
        request={a.request}
        regions={[]}
        checkpointId="cp-a"
      />,
    );
    const root = stageRoot(r.container);
    const setAttribute = root.setAttribute.bind(root);
    vi.spyOn(root, "setAttribute").mockImplementation((name, value) => {
      if (name === ATTR) events.push(`set ${value}`);
      setAttribute(name, value);
    });
    const removeAttribute = root.removeAttribute.bind(root);
    vi.spyOn(root, "removeAttribute").mockImplementation((name) => {
      if (name === ATTR) events.push("remove");
      removeAttribute(name);
    });
    await flush();
    runFrame();
    expect(drawnOf(root)).toBe("cp-a");

    // The step moves to B while A is mounted; none of B's images is in yet.
    r.rerender(
      <ViewerStage
        set={loading({})}
        request={bRequest}
        regions={[]}
        checkpointId="cp-b"
      />,
    );
    await flush();
    runFrame();
    runFrame();
    expect(drawnOf(root)).toBeNull();

    // One of B's images is in, the others are still on their way.
    r.rerender(
      <ViewerStage
        set={loading({ baseline: b.baseline })}
        request={bRequest}
        regions={[]}
        checkpointId="cp-b"
      />,
    );
    await flush();
    runFrame();
    runFrame();
    expect(drawnOf(root)).toBeNull();

    // All of B's images are in: B mounts, and is named one frame later.
    r.rerender(
      <ViewerStage
        set={{ status: "ready", images: b, failed: {}, retry: () => {} }}
        request={bRequest}
        regions={[]}
        checkpointId="cp-b"
      />,
    );
    await flush();
    expect(drawnOf(root)).toBeNull();
    runFrame();
    expect(drawnOf(root)).toBe("cp-b");

    // B is named once, after its own mount; A's mark went with A, in the
    // commit that took A off the stage, while B was still loading.
    expect(events).toEqual([
      "mount 1",
      "set cp-a",
      "dispose 1",
      "remove",
      "mount 2",
      "set cp-b",
    ]);
  });

  test("a mode change clears it before the new renderer mounts, and sets it again after a frame", async () => {
    setMode("overlay");
    const { set, request } = fullStep("one");
    const { container } = render(
      <ViewerStage
        set={set}
        request={request}
        regions={[]}
        checkpointId="cp-1"
      />,
    );
    await flush();
    runFrame();
    const root = stageRoot(container);
    expect(drawnOf(root)).toBe("cp-1");

    let atMount: string | null | undefined;
    const real = RENDERERS.diff.mount;
    const spy: MockInstance = vi
      .spyOn(RENDERERS.diff, "mount")
      .mockImplementation((...args: Parameters<typeof real>) => {
        atMount = drawnOf(root);
        return real(...args);
      });
    setMode("diff");
    await flush();

    expect(spy).toHaveBeenCalledOnce();
    expect(atMount).toBeNull();
    expect(drawnOf(root)).toBeNull();
    runFrame();
    expect(drawnOf(root)).toBe("cp-1");
  });

  test("a step id that arrives after the stage drew is marked without a remount", async () => {
    const { set, request } = fullStep("one");
    const r = render(<ViewerStage set={set} request={request} regions={[]} />);
    await flush();
    runFrame();
    const root = stageRoot(r.container);
    // No step id yet: nothing to say the stage drew.
    expect(drawnOf(root)).toBeNull();
    const spritesBefore = fake.registry.sprites.length;

    r.rerender(
      <ViewerStage
        set={set}
        request={request}
        regions={[]}
        checkpointId="cp-1"
      />,
    );
    await flush();
    expect(drawnOf(root)).toBeNull();
    runFrame();
    expect(drawnOf(root)).toBe("cp-1");
    // The images stayed where they were.
    expect(fake.registry.sprites.length).toBe(spritesBefore);
  });

  test("unmounting cancels the pending frame", async () => {
    const { set, request } = fullStep("one");
    const r = render(
      <ViewerStage
        set={set}
        request={request}
        regions={[]}
        checkpointId="cp-1"
      />,
    );
    await flush();
    expect(frames.size).toBe(1);

    r.unmount();
    expect(frames.size).toBe(0);
  });
});

describe("data-stage-drawn is never set for a stage that draws nothing", () => {
  test("an image that failed to load: the step is not drawn", async () => {
    const { set, request } = step(
      { baseline: loaded("b", 100, 100) },
      { current: true },
    );
    const { container } = render(
      <ViewerStage
        set={set}
        request={request}
        regions={[]}
        checkpointId="cp-1"
      />,
    );
    await flush();
    runFrame();
    expect(drawnOf(stageRoot(container))).toBeNull();
  });

  test("an image the GPU can't hold: the step is not drawn", async () => {
    fake.registry.maxTextureSize = 16384;
    const { set, request } = step({
      baseline: loaded("b", 1440, 900),
      current: loaded("c", 1440, 20000),
    });
    const { container } = render(
      <ViewerStage
        set={set}
        request={request}
        regions={[]}
        checkpointId="cp-1"
      />,
    );
    await flush();
    runFrame();
    expect(drawnOf(stageRoot(container))).toBeNull();
  });

  test("nothing the mode draws fits the GPU: nothing mounts and nothing is marked", async () => {
    fake.registry.maxTextureSize = 50;
    const { set, request } = fullStep("one");
    const { container } = render(
      <ViewerStage
        set={set}
        request={request}
        regions={[]}
        checkpointId="cp-1"
      />,
    );
    await flush();
    runFrame();
    expect(spritesOnStage()).toBe(0);
    expect(drawnOf(stageRoot(container))).toBeNull();
  });

  test("an image still on its way: not drawn until it is in", async () => {
    const baseline = loaded("b", 100, 100);
    const current = loaded("c", 100, 100);
    const loading: ImageSetState = {
      status: "loading",
      images: { baseline },
      failed: {},
      retry: () => {},
    };
    const request: ImageSetRequest = {
      baseline: baseline.key,
      current: current.key,
      diff: null,
    };
    const r = render(
      <ViewerStage
        set={loading}
        request={request}
        regions={[]}
        checkpointId="cp-1"
      />,
    );
    await flush();
    runFrame();
    const root = stageRoot(r.container);
    expect(drawnOf(root)).toBeNull();

    const ready: ImageSetState = {
      status: "ready",
      images: { baseline, current },
      failed: {},
      retry: () => {},
    };
    r.rerender(
      <ViewerStage
        set={ready}
        request={request}
        regions={[]}
        checkpointId="cp-1"
      />,
    );
    await flush();
    expect(drawnOf(root)).toBeNull();
    runFrame();
    expect(drawnOf(root)).toBe("cp-1");
  });

  test("a new test with no baseline still draws its current image, and is marked", async () => {
    const { set, request } = step({ current: loaded("c", 100, 100) });
    const { container } = render(
      <ViewerStage
        set={set}
        request={request}
        regions={[]}
        checkpointId="cp-1"
      />,
    );
    await flush();
    runFrame();
    expect(drawnOf(stageRoot(container))).toBe("cp-1");
  });
});
