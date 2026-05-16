import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Mock pixi.js — we test toolbar/store behavior, not WebGL.
vi.mock("pixi.js", () => ({
  Application: class {
    canvas = document.createElement("canvas");
    stage = { addChild: () => {} };
    screen = { width: 600, height: 400 };
    async init() {}
    destroy() {}
  },
  Assets: { load: async () => ({}) },
  Sprite: class {
    width = 0;
    height = 0;
    alpha = 1;
  },
  Container: class {
    children: unknown[] = [];
    addChild(c: unknown) {
      this.children.push(c);
    }
  },
  Graphics: class {
    rect() {
      return this;
    }
    fill() {
      return this;
    }
    stroke() {
      return this;
    }
  },
}));

// Mock the tRPC client. The DiffViewer only uses runs.getById.useQuery.
// T9: response now includes baselineScreenshot + diffName.
vi.mock("../src/lib/trpc", () => ({
  trpc: {
    runs: {
      getById: {
        useQuery: () => ({
          data: {
            id: "00000000-0000-0000-0000-000000000000",
            screenshots: [],
            diffRegions: [],
            baselineScreenshot: null,
            baselineSource: null,
            diffName: null,
          },
          isLoading: false,
          error: null,
        }),
      },
    },
  },
}));

import { DiffViewer } from "../src/components/diff-viewer/DiffViewer";
import { useViewerStore } from "../src/components/diff-viewer/useViewerStore";

describe("DiffViewer", () => {
  beforeEach(() => {
    useViewerStore.setState({
      mode: "side-by-side",
      opacity: 0.5,
      selectedRegionId: null,
      viewport: "",
    });
  });
  afterEach(() => {
    cleanup();
  });

  test("renders the toolbar with all 4 mode tabs", () => {
    const r = render(
      <DiffViewer runId="00000000-0000-0000-0000-000000000000" diffId="d1" />,
    );
    expect(r.getByRole("tablist")).toBeDefined();
    expect(r.getByRole("tab", { name: /side-by-side/i })).toBeDefined();
    expect(r.getByRole("tab", { name: /^overlay$/i })).toBeDefined();
    expect(r.getByRole("tab", { name: /onion-skin/i })).toBeDefined();
    expect(r.getByRole("tab", { name: /diff heatmap/i })).toBeDefined();
  });

  test("clicking a tab updates useViewerStore.mode", () => {
    const r = render(
      <DiffViewer runId="00000000-0000-0000-0000-000000000000" diffId="d1" />,
    );
    fireEvent.mouseDown(r.getByRole("tab", { name: /^overlay$/i }));
    expect(useViewerStore.getState().mode).toBe("overlay");

    fireEvent.mouseDown(r.getByRole("tab", { name: /onion-skin/i }));
    expect(useViewerStore.getState().mode).toBe("onion-skin");
  });
});
