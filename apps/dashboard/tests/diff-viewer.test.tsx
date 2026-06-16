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
    circle() {
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
  // ContextualHeader → SetBreadcrumbs reads usePathname to tag the trail.
  usePathname: () => "/projects/p1/runs/r1/checkpoints/c1",
}));

// ADR-032: tests override fields on this object (e.g., autoApproved)
// per-test via mockGetByIdData = { ...defaultMockData, autoApproved: true }.
type RunStatusLite = "unresolved" | "empty" | "passed" | "failed" | "running";
interface MockData {
  id: string;
  projectId: string;
  buildId: string;
  screenshots: unknown[];
  diffRegions: unknown[];
  baselineScreenshot: unknown;
  baselineSource: unknown;
  diffName: string | null;
  comment: string | null;
  ignoreAreas: unknown;
  variationIgnoreAreas: unknown;
  autoApproved: boolean;
  status: RunStatusLite;
  prevRunId: string | null;
  nextRunId: string | null;
}
const defaultMockData: MockData = {
  id: "00000000-0000-0000-0000-000000000000",
  projectId: "test-project-id",
  buildId: "test-build-id",
  screenshots: [],
  diffRegions: [],
  baselineScreenshot: null,
  baselineSource: null,
  diffName: null,
  comment: null,
  ignoreAreas: null,
  variationIgnoreAreas: null,
  autoApproved: false,
  // Task 3 (run-status enum): ApprovalBar reads `status` from this query
  // to drive its enabled-state + status pill. Default `unresolved` so the
  // embedded ApprovalBar is in its canonical reviewable state.
  status: "unresolved",
  prevRunId: null,
  nextRunId: null,
};
let mockGetByIdData: MockData = { ...defaultMockData };

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
            data: mockGetByIdData,
            isLoading: false,
            error: null,
          }),
        },
        // ADR-038: checkpoint list — returns empty items so the rail doesn't render
        listCheckpoints: {
          useQuery: () => ({
            data: { items: [] },
            isLoading: false,
            error: null,
          }),
        },
        approve: { useMutation: noopMutation },
        reject: { useMutation: noopMutation },
        overrideStatus: { useMutation: noopMutation },
        setComment: { useMutation: noopMutation },
        setIgnoreAreas: { useMutation: noopMutation },
        setTempIgnoreAreas: { useMutation: noopMutation },
        setDiffThresholdOverride: { useMutation: noopMutation },
        bulkApproveByVariation: { useMutation: noopMutation },
        approveCheckpoint: { useMutation: noopMutation },
        approveAllCheckpoints: { useMutation: noopMutation },
      },
      projects: {
        getById: {
          useQuery: () => ({
            data: { dynamicTextEnabled: false },
            isLoading: false,
            error: null,
          }),
        },
      },
      baselines: {
        listForVariation: {
          useQuery: () => ({ data: { items: [] }, isLoading: false }),
        },
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
    mockGetByIdData = { ...defaultMockData };
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

  test("renders the toolbar with all 3 mode tabs", () => {
    const r = render(
      <DiffViewer runId="00000000-0000-0000-0000-000000000000" diffId="d1" />,
    );
    // ADR-038: RegionKindTabs adds a second tablist (region kinds); use
    // getAllByRole and check there's at least one tablist rendered.
    expect(r.getAllByRole("tablist").length).toBeGreaterThanOrEqual(1);
    expect(r.getByRole("tab", { name: /side by side/i })).toBeDefined();
    expect(r.getByRole("tab", { name: /^overlay$/i })).toBeDefined();
    expect(r.getByRole("tab", { name: /^difference$/i })).toBeDefined();
  });

  test("clicking a tab updates useViewerStore.mode", () => {
    const r = render(
      <DiffViewer runId="00000000-0000-0000-0000-000000000000" diffId="d1" />,
    );
    fireEvent.mouseDown(r.getByRole("tab", { name: /^overlay$/i }));
    expect(useViewerStore.getState().mode).toBe("overlay");

    fireEvent.mouseDown(r.getByRole("tab", { name: /^difference$/i }));
    expect(useViewerStore.getState().mode).toBe("difference");
  });

  test("renders the Auto-approved badge when data.autoApproved is true", () => {
    mockGetByIdData = { ...defaultMockData, autoApproved: true };
    const r = render(
      <DiffViewer runId="00000000-0000-0000-0000-000000000000" diffId="d1" />,
    );
    expect(r.getByTestId("auto-approved-badge")).toBeDefined();
  });

  test("does not render the Auto-approved badge when data.autoApproved is false", () => {
    mockGetByIdData = { ...defaultMockData, autoApproved: false };
    const r = render(
      <DiffViewer runId="00000000-0000-0000-0000-000000000000" diffId="d1" />,
    );
    expect(r.queryByTestId("auto-approved-badge")).toBeNull();
  });

  test("status='empty' renders EmptyRunCard instead of viewer + region list", () => {
    mockGetByIdData = {
      ...defaultMockData,
      status: "empty" as const,
      projectId: "test-project-id",
      buildId: "test-build-id",
      diffRegions: [],
      screenshots: [],
    };
    const r = render(<DiffViewer runId="r1" diffId="d1" />);
    expect(r.getByTestId("empty-run-card")).toBeDefined();
    expect(r.queryByTestId("region-list-panel")).toBeNull();
  });

  test("non-empty status (e.g. unresolved) renders viewer + region list normally", () => {
    mockGetByIdData = { ...defaultMockData, status: "unresolved" as const };
    const r = render(<DiffViewer runId="r1" diffId="d1" />);
    expect(r.queryByTestId("empty-run-card")).toBeNull();
  });

  test("diff stepper renders counter and advances on next click", () => {
    mockGetByIdData = {
      ...defaultMockData,
      status: "unresolved" as const,
      diffRegions: [
        {
          id: "region-1",
          severity: "major",
          category: "visual",
          bbox: { x: 10, y: 20, width: 100, height: 50 },
          description: "First diff region",
          source: "l2_dom",
        },
        {
          id: "region-2",
          severity: "minor",
          category: "visual",
          bbox: { x: 200, y: 300, width: 80, height: 40 },
          description: "Second diff region",
          source: "l2_dom",
        },
      ],
    };
    const r = render(
      <DiffViewer runId="00000000-0000-0000-0000-000000000000" diffId="d1" />,
    );
    // Nothing selected yet → index is -1 → displayed as 0
    const counter = r.getByTestId("diff-counter");
    expect(counter.textContent).toContain("Diff 0 / 2");
    // Click next → selects region-1 (index 0) → displayed as "Diff 1 / 2"
    fireEvent.click(r.getByTestId("diff-next"));
    expect(r.getByTestId("diff-counter").textContent).toContain("Diff 1 / 2");
  });
});
