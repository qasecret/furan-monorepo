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

// Mock next/navigation — DiffViewer now invokes useDiffViewerShortcuts
// which calls useRouter at render time.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

// Mock the tRPC client.
// T9: getById response includes baselineScreenshot + diffName.
// T11: DiffViewer now also calls runs.approve / runs.reject mutations
// (used for keyboard shortcuts and via the embedded <ApprovalBar>) and
// trpc.useUtils() for query invalidation.
vi.mock("../src/lib/trpc", () => {
  const noopMutation = () => ({ mutate: () => undefined, isPending: false });
  return {
    trpc: {
      useUtils: () => ({
        runs: { getById: { invalidate: () => undefined } },
      }),
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
        approve: { useMutation: noopMutation },
        reject: { useMutation: noopMutation },
        setComment: { useMutation: noopMutation },
      },
    },
  };
});

// T11: DiffViewer mounts useRunEvents which opens an EventSource. jsdom
// has no EventSource — stub it so the hook is a no-op for these tests.
class StubEventSource {
  url: string;
  withCredentials: boolean;
  constructor(url: string, init?: EventSourceInit) {
    this.url = url;
    this.withCredentials = init?.withCredentials ?? false;
  }
  addEventListener(): void {
    /* noop */
  }
  removeEventListener(): void {
    /* noop */
  }
  close(): void {
    /* noop */
  }
}
(globalThis as unknown as { EventSource: typeof StubEventSource }).EventSource =
  StubEventSource;

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
