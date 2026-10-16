import { act, cleanup, render, waitFor } from "@testing-library/react";
import { useTheme } from "next-themes";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Every Application the stage creates, so the test can read the colour pixi
// would actually paint with. A theme flip must repaint these same apps: a new
// app (or a destroyed one) would mean the canvas re-mounted, which drops the
// reviewer's zoom and pan. Graphics record their strokes, for the hatching.
const fake = vi.hoisted(() => {
  const point = () => ({
    x: 0,
    y: 0,
    set(x: number, y: number = x) {
      this.x = x;
      this.y = y;
    },
  });
  class Container {
    label = "";
    parent: Container | null = null;
    children: Container[] = [];
    alpha = 1;
    position = point();
    scale = point();
    addChild<T extends Container>(c: T): T {
      if (c.parent === this) this.children.splice(this.children.indexOf(c), 1);
      this.children.push(c);
      c.parent = this;
      return c;
    }
    removeChild<T extends Container>(c: T): T {
      this.children = this.children.filter((x) => x !== c);
      c.parent = null;
      return c;
    }
    destroy() {
      this.parent?.removeChild(this);
    }
  }
  class Graphics extends Container {
    strokes: Array<{ color?: number }> = [];
    fills: Array<{ color?: number }> = [];
    moveTo() {
      return this;
    }
    lineTo() {
      return this;
    }
    rect() {
      return this;
    }
    stroke(s: { color?: number }) {
      this.strokes.push(s);
      return this;
    }
    fill(s: { color?: number }) {
      this.fills.push(s);
      return this;
    }
    clear() {
      this.strokes = [];
      this.fills = [];
      return this;
    }
  }
  class Texture {
    source = { destroy() {} };
    static from() {
      return new Texture();
    }
    destroy() {}
  }
  class Sprite extends Container {
    constructor(public texture: Texture) {
      super();
    }
  }
  class Application {
    canvas = document.createElement("canvas");
    stage = new Container();
    screen = { width: 600, height: 400 };
    ticker = { add: () => {}, remove: () => {} };
    renderer = { background: { color: 0 }, resize: () => {} };
    async init(opts: { backgroundColor: number }) {
      this.renderer.background.color = opts.backgroundColor;
      registry.apps.push(this);
    }
    destroy() {
      registry.destroyed++;
    }
  }
  const registry = { apps: [] as Application[], destroyed: 0 };
  return { Container, Graphics, Sprite, Texture, Application, registry };
});

vi.mock("pixi.js/unsafe-eval", () => ({}));
vi.mock("pixi.js", () => ({
  Application: fake.Application,
  Container: fake.Container,
  Graphics: fake.Graphics,
  Sprite: fake.Sprite,
  Texture: fake.Texture,
}));

import type {
  ImageSetRequest,
  ImageSetState,
} from "../src/components/diff-viewer/image-set";
import {
  DEFAULT_VIEWER_PREFS,
  useViewerPrefs,
} from "../src/components/diff-viewer/viewer-prefs";
import { ViewerStage } from "../src/components/diff-viewer/ViewerStage";
import { ThemeProvider } from "../src/components/ui/theme-provider";

// next-themes calls window.matchMedia internally; jsdom doesn't implement it.
class MockMatchMedia {
  matches = false;
  addEventListener() {}
  removeEventListener() {}
  addListener() {}
  removeListener() {}
  dispatchEvent() {
    return false;
  }
}
// @ts-expect-error -- jsdom doesn't have matchMedia
global.matchMedia = () => new MockMatchMedia();

let setTheme: (t: string) => void = () => {};
function Probe() {
  setTheme = useTheme().setTheme;
  return null;
}

let styleEl: HTMLStyleElement;

beforeEach(() => {
  fake.registry.apps.length = 0;
  fake.registry.destroyed = 0;
  localStorage.clear();
  document.documentElement.className = "";
  // Same shape as tokens.css: light on :root, dark under .dark.
  styleEl = document.createElement("style");
  styleEl.textContent =
    ":root{--hover:#f4f4f5;--fg-muted:#6a6a73;--ring:#4d7c0f}" +
    ":root.dark{--hover:#1d1d21;--fg-muted:#8b8b94;--ring:#a8ff53}";
  document.head.appendChild(styleEl);
});

afterEach(() => {
  cleanup();
  styleEl.remove();
  localStorage.clear();
  document.documentElement.className = "";
  useViewerPrefs.setState({ prefs: DEFAULT_VIEWER_PREFS });
});

const NOTHING: { set: ImageSetState; request: ImageSetRequest } = {
  set: { status: "ready", images: {}, failed: {}, retry: () => {} },
  request: { baseline: null, current: null, diff: null },
};

/** A 100×200 baseline beside a 100×300 current: the baseline is hatched. */
function mismatched(): { set: ImageSetState; request: ImageSetRequest } {
  const bitmap = (w: number, h: number) =>
    ({ width: w, height: h, close: () => {} }) as unknown as ImageBitmap;
  return {
    set: {
      status: "ready",
      images: {
        baseline: {
          key: "b",
          bitmap: bitmap(100, 200),
          size: { w: 100, h: 200 },
        },
        current: {
          key: "c",
          bitmap: bitmap(100, 300),
          size: { w: 100, h: 300 },
        },
      },
      failed: {},
      retry: () => {},
    },
    request: { baseline: "b", current: "c", diff: null },
  };
}

function renderStage(step = NOTHING) {
  return render(
    <ThemeProvider>
      <Probe />
      <ViewerStage set={step.set} request={step.request} regions={[]} />
    </ThemeProvider>,
  );
}

describe("ViewerStage follows the theme", () => {
  test("side-by-side: both apps repaint to the new --hover when the theme flips", async () => {
    localStorage.setItem("furan-theme", "light");
    renderStage();
    await waitFor(() => expect(fake.registry.apps).toHaveLength(2));
    const colours = () =>
      fake.registry.apps.map((a) => a.renderer.background.color);
    expect(colours()).toEqual([0xf4f4f5, 0xf4f4f5]);

    act(() => setTheme("dark"));
    await waitFor(() => expect(colours()).toEqual([0x1d1d21, 0x1d1d21]));

    act(() => setTheme("light"));
    await waitFor(() => expect(colours()).toEqual([0xf4f4f5, 0xf4f4f5]));

    // Repainted in place: still the original two apps, none torn down.
    expect(fake.registry.apps).toHaveLength(2);
    expect(fake.registry.destroyed).toBe(0);
  });

  test("single-stage mode: the app repaints when the theme flips", async () => {
    useViewerPrefs.setState({
      prefs: { ...DEFAULT_VIEWER_PREFS, mode: "overlay" },
    });
    localStorage.setItem("furan-theme", "light");
    // A step with a baseline: without one, overlay draws as side by side.
    renderStage(mismatched());
    await waitFor(() => expect(fake.registry.apps).toHaveLength(1));
    expect(fake.registry.apps[0]!.renderer.background.color).toBe(0xf4f4f5);

    act(() => setTheme("dark"));
    await waitFor(() =>
      expect(fake.registry.apps[0]!.renderer.background.color).toBe(0x1d1d21),
    );

    expect(fake.registry.apps).toHaveLength(1);
    expect(fake.registry.destroyed).toBe(0);
  });

  test("the hatching is drawn in --fg-muted and follows the theme, without a remount", async () => {
    localStorage.setItem("furan-theme", "light");
    renderStage(mismatched());
    await waitFor(() => expect(fake.registry.apps).toHaveLength(2));
    const hatch = () => {
      for (const app of fake.registry.apps) {
        const world = app.stage.children[0]!;
        const found = world.children.find((c) => c.label === "hatch:baseline");
        if (found) return found as InstanceType<typeof fake.Graphics>;
      }
      return undefined;
    };
    await waitFor(() =>
      expect(hatch()?.strokes.map((s) => s.color)).toEqual([0x6a6a73]),
    );
    const drawn = hatch();

    act(() => setTheme("dark"));
    await waitFor(() =>
      expect(hatch()?.strokes.map((s) => s.color)).toEqual([0x8b8b94]),
    );
    // The same layer, redrawn: the mount was kept.
    expect(hatch()).toBe(drawn);
    expect(fake.registry.destroyed).toBe(0);
  });

  test("Swipe's divider is drawn in --ring and follows the theme, without a remount", async () => {
    useViewerPrefs.setState({
      prefs: { ...DEFAULT_VIEWER_PREFS, mode: "swipe" },
    });
    localStorage.setItem("furan-theme", "light");
    renderStage(mismatched());
    await waitFor(() => expect(fake.registry.apps).toHaveLength(1));
    const divider = () =>
      fake.registry.apps[0]!.stage.children[0]!.children.find(
        (c) => c.label === "divider",
      ) as InstanceType<typeof fake.Graphics> | undefined;
    await waitFor(() =>
      expect(divider()?.fills.map((f) => f.color)).toEqual([0x4d7c0f]),
    );
    const drawn = divider();

    act(() => setTheme("dark"));
    await waitFor(() =>
      expect(divider()?.fills.map((f) => f.color)).toEqual([0xa8ff53]),
    );
    expect(divider()).toBe(drawn);
    expect(fake.registry.destroyed).toBe(0);
  });
});
