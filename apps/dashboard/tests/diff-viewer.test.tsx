import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Tracks how many times a Pixi Application has been initialized. Module-level
// so the regression test can read it without any reference to the mock class.
let pixiInitCount = 0;

// Mock pixi.js — we test toolbar/store behavior, not WebGL.
vi.mock("pixi.js", () => ({
  Application: class {
    canvas = document.createElement("canvas");
    stage = { addChild: () => {} };
    screen = { width: 600, height: 400 };
    ticker = { add: () => {}, remove: () => {} };
    async init() {
      pixiInitCount++;
    }
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
        runs: {
          getById: { invalidate: () => undefined },
          listCheckpoints: { invalidate: () => undefined },
        },
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
        // ADR-042: group-approval callout — data:undefined fires null-guard → renders nothing
        getCheckpointGroup: {
          useQuery: () => ({ data: undefined, isLoading: false, error: null }),
        },
        approveCheckpointGroup: { useMutation: noopMutation },
        rejectCheckpointGroup: {
          useMutation: () => ({ mutate: () => undefined, isPending: false }),
        },
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
      // INFO sidebar reads runByName off the build sibling query.
      builds: {
        getById: {
          useQuery: () => ({
            data: { runByName: null },
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
    pixiInitCount = 0;
    mockGetByIdData = { ...defaultMockData };
    useViewerStore.setState({
      mode: "side-by-side",
      opacity: 0.5,
      selectedRegionId: null,
      viewport: "",
      highlightActive: false,
      hideDisplacement: false,
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
    expect(r.getByRole("tab", { name: /^diff only$/i })).toBeDefined();
  });

  test("clicking a tab updates useViewerStore.mode", () => {
    const r = render(
      <DiffViewer runId="00000000-0000-0000-0000-000000000000" diffId="d1" />,
    );
    fireEvent.click(r.getByRole("tab", { name: /^overlay$/i }));
    expect(useViewerStore.getState().mode).toBe("overlay");

    fireEvent.click(r.getByRole("tab", { name: /^diff only$/i }));
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

  test("hides the whole metadata strip for a nominal run (no signal to show)", () => {
    // Default mock: single/no extra viewport, matching sizes, this-branch
    // baseline, not auto-approved → the strip carries nothing, so it's gone
    // (viewport already lives in the INFO sidebar).
    mockGetByIdData = { ...defaultMockData, autoApproved: false };
    const r = render(
      <DiffViewer runId="00000000-0000-0000-0000-000000000000" diffId="d1" />,
    );
    expect(r.queryByTestId("diff-viewer-meta-strip")).toBeNull();
  });

  test("shows the metadata strip when there is a signal (e.g. auto-approved)", () => {
    mockGetByIdData = { ...defaultMockData, autoApproved: true };
    const r = render(
      <DiffViewer runId="00000000-0000-0000-0000-000000000000" diffId="d1" />,
    );
    expect(r.getByTestId("diff-viewer-meta-strip")).toBeDefined();
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

  test("highlight-toggle button toggles highlightActive in the store", () => {
    const r = render(
      <DiffViewer runId="00000000-0000-0000-0000-000000000000" diffId="d1" />,
    );
    expect(useViewerStore.getState().highlightActive).toBe(false);

    // First click: activates highlight
    fireEvent.click(r.getByTestId("highlight-toggle"));
    expect(useViewerStore.getState().highlightActive).toBe(true);

    // Second click: deactivates highlight
    fireEvent.click(r.getByTestId("highlight-toggle"));
    expect(useViewerStore.getState().highlightActive).toBe(false);
  });

  test("toggling highlightActive does NOT re-initialize the Pixi canvas (new Application + init must not re-run)", async () => {
    // Render with regions so the shading layer has something to mount.
    mockGetByIdData = {
      ...defaultMockData,
      status: "unresolved" as const,
      diffRegions: [
        {
          id: "region-1",
          severity: "major",
          category: "visual",
          bbox: { x: 10, y: 20, width: 100, height: 50 },
          description: "A diff region",
          source: "l2_dom",
        },
      ],
    };
    const r = render(
      <DiffViewer runId="00000000-0000-0000-0000-000000000000" diffId="d1" />,
    );

    // Drain the async Pixi init path (two Application.init() calls for
    // side-by-side mode). The mock init() is synchronous under the async
    // wrapper, but React needs a tick to process state updates triggered by
    // the effect (setCanvasEpoch). A single act flush is sufficient here.
    await act(async () => {});

    // Record how many Application instances were initialized at this point.
    // In side-by-side mode: 2 (baseline + candidate).
    const countAfterMount = pixiInitCount;
    // Sanity: at least one init happened (if pixi.js mock isn't wired up,
    // the rest of the assertion is vacuous — this guards that).
    expect(countAfterMount).toBeGreaterThan(0);

    // Toggle the highlight on.
    fireEvent.click(r.getByTestId("highlight-toggle"));
    await act(async () => {});

    // Toggle the highlight off.
    fireEvent.click(r.getByTestId("highlight-toggle"));
    await act(async () => {});

    // The canvas mount effect dep array is now [mode, baselineUrl, candidateUrl].
    // Neither changed → Application.init() must NOT have been called again.
    expect(pixiInitCount).toBe(countAfterMount);
  });

  test("hide-displacement-toggle reduces stepper count when layout regions present", () => {
    mockGetByIdData = {
      ...defaultMockData,
      status: "unresolved" as const,
      diffRegions: [
        {
          id: "region-visual",
          severity: "major",
          category: "visual",
          bbox: { x: 10, y: 20, width: 100, height: 50 },
          description: "Visual diff region",
          source: "l2_dom",
        },
        {
          id: "region-layout",
          severity: "major",
          category: "layout",
          bbox: { x: 200, y: 300, width: 80, height: 40 },
          description: "Layout (displacement) diff region",
          source: "l2_dom",
        },
      ],
    };
    const r = render(
      <DiffViewer runId="00000000-0000-0000-0000-000000000000" diffId="d1" />,
    );

    // Both regions visible: counter shows "Diff 0 / 2"
    expect(r.getByTestId("diff-counter").textContent).toContain("0 / 2");

    // Toggle hide-displacement on
    fireEvent.click(r.getByTestId("hide-displacement-toggle"));
    expect(useViewerStore.getState().hideDisplacement).toBe(true);

    // Layout region filtered: counter drops to "Diff 0 / 1"
    expect(r.getByTestId("diff-counter").textContent).toContain("0 / 1");

    // Toggle hide-displacement off
    fireEvent.click(r.getByTestId("hide-displacement-toggle"));
    expect(useViewerStore.getState().hideDisplacement).toBe(false);

    // Layout region restored: counter back to "Diff 0 / 2"
    expect(r.getByTestId("diff-counter").textContent).toContain("0 / 2");
  });
});
