import { act, cleanup, render, waitFor } from "@testing-library/react";
import { useTheme } from "next-themes";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Every Application the component creates, so the test can read the colour
// pixi would actually paint with.
interface FakeApp {
  renderer: { background: { color: number } };
}
const apps: FakeApp[] = [];

vi.mock("pixi.js/unsafe-eval", () => ({}));
vi.mock("pixi.js", () => ({
  Application: class {
    canvas = document.createElement("canvas");
    stage = { addChild: () => {} };
    screen = { width: 600, height: 400 };
    ticker = { add: () => {}, remove: () => {} };
    renderer: { background: { color: number }; resize: () => void } = {
      background: { color: 0 },
      resize: () => {},
    };
    async init(opts: { backgroundColor: number }) {
      this.renderer.background.color = opts.backgroundColor;
      apps.push(this as unknown as FakeApp);
    }
    destroy() {}
  },
  Assets: { load: async () => ({}) },
  Sprite: class {},
  Container: class {
    children: unknown[] = [];
    addChild(c: unknown) {
      this.children.push(c);
    }
  },
  Graphics: class {},
}));

import { useViewerStore } from "../src/components/diff-viewer/useViewerStore";
import { ViewerCanvas } from "../src/components/diff-viewer/ViewerCanvas";
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
  apps.length = 0;
  localStorage.clear();
  document.documentElement.className = "";
  // Same shape as tokens.css: light on :root, dark under .dark.
  styleEl = document.createElement("style");
  styleEl.textContent = ":root{--sunken:#fafafa}:root.dark{--sunken:#08080a}";
  document.head.appendChild(styleEl);
});

afterEach(() => {
  cleanup();
  styleEl.remove();
  localStorage.clear();
  document.documentElement.className = "";
  useViewerStore.setState({ mode: "side-by-side" });
});

function renderCanvas() {
  return render(
    <ThemeProvider>
      <Probe />
      <ViewerCanvas
        baselineUrl={null}
        candidateUrl={null}
        diffOverlayUrl={null}
        regions={[]}
      />
    </ThemeProvider>,
  );
}

describe("ViewerCanvas follows the theme", () => {
  test("side-by-side: both apps repaint to the new --sunken when the theme flips", async () => {
    localStorage.setItem("furan-theme", "light");
    renderCanvas();
    await waitFor(() => expect(apps).toHaveLength(2));
    expect(apps.map((a) => a.renderer.background.color)).toEqual([
      0xfafafa, 0xfafafa,
    ]);

    act(() => setTheme("dark"));
    await waitFor(() =>
      expect(apps.map((a) => a.renderer.background.color)).toEqual([
        0x08080a, 0x08080a,
      ]),
    );

    act(() => setTheme("light"));
    await waitFor(() =>
      expect(apps.map((a) => a.renderer.background.color)).toEqual([
        0xfafafa, 0xfafafa,
      ]),
    );
  });

  test("single-stage mode: the app repaints when the theme flips", async () => {
    useViewerStore.setState({ mode: "overlay" });
    localStorage.setItem("furan-theme", "light");
    renderCanvas();
    await waitFor(() => expect(apps).toHaveLength(1));
    expect(apps[0]!.renderer.background.color).toBe(0xfafafa);

    act(() => setTheme("dark"));
    await waitFor(() =>
      expect(apps[0]!.renderer.background.color).toBe(0x08080a),
    );
  });
});
