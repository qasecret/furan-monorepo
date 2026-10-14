import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Review-action spies: the keyboard shortcuts and the ApprovalBar buttons
// must reach the server through the SAME call (see the hotkey parity block at
// the bottom of this file). The review hook is mocked: its own suite covers
// what a decision does to the caches and the server.
const { reviewSpies, routerSpies } = vi.hoisted(() => ({
  reviewSpies: {
    decide: vi.fn(),
    undo: vi.fn(),
    isInFlight: vi.fn((_id: string) => false),
  },
  // One router object for every render, so effects that depend on it don't
  // re-run each time.
  routerSpies: { push: vi.fn(), replace: vi.fn() },
}));
vi.mock("@/lib/review/use-review-mutations", () => ({
  useReviewMutations: () => reviewSpies,
}));

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
  useRouter: () => routerSpies,
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
  statusOverride?: "passed" | "failed" | null;
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
// ADR-038 checkpoint list — configurable per-test so the side step-arrows
// (which need total > 1) can be exercised. Empty by default.
let mockCheckpoints: { items: unknown[] } = { items: [] };

// Mock the tRPC client.
// T9: getById response includes baselineScreenshot + diffName.
// T11: DiffViewer uses trpc.useUtils() for query invalidation; its review
// actions (keyboard shortcuts and the embedded <ApprovalBar>) read the same
// two queries and make their decisions through the mocked review hook.
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
        // ADR-038: checkpoint list — configurable via mockCheckpoints.
        listCheckpoints: {
          useQuery: () => ({
            data: mockCheckpoints,
            isLoading: false,
            error: null,
          }),
        },
        overrideStatus: { useMutation: noopMutation },
        setComment: { useMutation: noopMutation },
        setIgnoreAreas: { useMutation: noopMutation },
        setTempIgnoreAreas: { useMutation: noopMutation },
        setDiffThresholdOverride: { useMutation: noopMutation },
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
import { useUndoStore } from "../src/lib/review/use-undo-store";

describe("DiffViewer", () => {
  beforeEach(() => {
    pixiInitCount = 0;
    mockGetByIdData = { ...defaultMockData };
    mockCheckpoints = { items: [] };
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

  test("initializes the editor viewport from the run's screenshots (single-viewport run)", () => {
    // Regression: the store viewport is stamped onto every drawn ignore
    // region, and the API requires it non-empty. The ViewportSwitcher only
    // renders for multi-viewport runs, so without the init effect a single-
    // viewport run would leave viewport "" and "Save regions" would 400.
    mockGetByIdData = {
      ...defaultMockData,
      screenshots: [{ id: "cp1", viewport: "1280x720" }],
    };
    render(
      <DiffViewer runId="00000000-0000-0000-0000-000000000000" diffId="d1" />,
    );
    expect(useViewerStore.getState().viewport).toBe("1280x720");
  });

  test("does not clobber an explicit viewport selection valid for the run", () => {
    mockGetByIdData = {
      ...defaultMockData,
      screenshots: [
        { id: "cp1", viewport: "1280x720" },
        { id: "cp2", viewport: "375x812" },
      ],
    };
    // Simulate the user having picked the second viewport via the switcher.
    useViewerStore.setState({ viewport: "375x812" });
    render(
      <DiffViewer runId="00000000-0000-0000-0000-000000000000" diffId="d1" />,
    );
    expect(useViewerStore.getState().viewport).toBe("375x812");
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

  test("renders large side step-arrows for a multi-checkpoint run", () => {
    mockCheckpoints = {
      items: [
        { id: "c1", name: "Home", state: "unresolved" },
        { id: "c2", name: "Search", state: "unresolved" },
      ],
    };
    const r = render(
      <DiffViewer
        runId="00000000-0000-0000-0000-000000000000"
        projectId="p1"
        initialCheckpointId="c1"
      />,
    );
    const prev = r.getByTestId("diff-viewer-step-prev") as HTMLButtonElement;
    const next = r.getByTestId("diff-viewer-step-next") as HTMLButtonElement;
    // At the first checkpoint: prev disabled, next enabled.
    expect(prev.disabled).toBe(true);
    expect(next.disabled).toBe(false);
  });

  test("hides the side step-arrows for a single-checkpoint run", () => {
    mockCheckpoints = {
      items: [{ id: "c1", name: "Home", state: "unresolved" }],
    };
    const r = render(
      <DiffViewer
        runId="00000000-0000-0000-0000-000000000000"
        projectId="p1"
        initialCheckpointId="c1"
      />,
    );
    expect(r.queryByTestId("diff-viewer-step-prev")).toBeNull();
    expect(r.queryByTestId("diff-viewer-step-next")).toBeNull();
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
    // The card's links show the shared focus ring when keyboard-focused.
    for (const id of ["empty-run-card-sdk-docs", "empty-run-card-timeline"]) {
      expect(r.getByTestId(id).classList.contains("focus-ring"), id).toBe(true);
    }
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

// Regression: the A/R hotkeys used to call their own `runs.approve` /
// `runs.reject` mutations — approving the WHOLE run, skipping the
// review-legal status gate, dropping unsaved ignore regions, and firing
// while the reviewer typed into a field. They must now go through the exact
// action the ApprovalBar buttons use.
const RUN_ID = "00000000-0000-0000-0000-000000000000";

interface StepFixture {
  id: string;
  name: string;
  state: string | null;
  decision?: unknown;
  newerCapture?: unknown;
}
const stepFixture = (
  id: string,
  state: string | null,
  over: Partial<StepFixture> = {},
): StepFixture => ({
  id,
  name: id.toUpperCase(),
  state,
  decision: null,
  newerCapture: null,
  ...over,
});

const press = (key: string) =>
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });

function resetReviewSpies() {
  reviewSpies.decide.mockReset();
  reviewSpies.undo.mockReset();
  reviewSpies.isInFlight.mockReset();
  reviewSpies.isInFlight.mockReturnValue(false);
  routerSpies.push.mockReset();
  routerSpies.replace.mockReset();
}

describe("DiffViewer review hotkeys share the ApprovalBar action path", () => {
  beforeEach(() => {
    mockGetByIdData = { ...defaultMockData };
    mockCheckpoints = { items: [stepFixture("cp-1", "unresolved")] };
    resetReviewSpies();
    useViewerStore.setState({
      ignoreEditMode: "off",
      draftIgnoreAreas: [],
      markedForDeletion: new Set(),
      paddingOverrides: new Map(),
      kindOverrides: new Map(),
      selectedIgnoreId: null,
    });
  });
  afterEach(() => {
    cleanup();
  });

  test("A approves the selected checkpoint by id, not the whole run", () => {
    render(
      <DiffViewer runId={RUN_ID} diffId="d1" initialCheckpointId="cp-1" />,
    );
    press("A");
    expect(reviewSpies.decide).toHaveBeenCalledOnce();
    expect(reviewSpies.decide).toHaveBeenCalledWith({
      runId: RUN_ID,
      checkpointIds: ["cp-1"],
      kind: "approved",
      label: "Approved 'CP-1'",
    });
  });

  test("A and the Approve button make the identical call", () => {
    const r = render(
      <DiffViewer runId={RUN_ID} diffId="d1" initialCheckpointId="cp-1" />,
    );
    press("A");
    fireEvent.click(r.getByTestId("approve-checkpoint-button"));
    expect(reviewSpies.decide).toHaveBeenCalledTimes(2);
    expect(reviewSpies.decide.mock.calls[1]).toEqual(
      reviewSpies.decide.mock.calls[0],
    );
  });

  test("A folds unsaved ignore regions into the approval, like the button", () => {
    render(
      <DiffViewer runId={RUN_ID} diffId="d1" initialCheckpointId="cp-1" />,
    );
    act(() => {
      useViewerStore.setState({
        draftIgnoreAreas: [
          {
            id: "draft-1",
            x: 1,
            y: 2,
            width: 30,
            height: 40,
            viewport: "1280x720",
            paddingPx: 0,
            kind: "ignore",
          },
        ],
      });
    });
    press("A");
    expect(reviewSpies.decide).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: RUN_ID,
        checkpointIds: ["cp-1"],
        kind: "approved",
        ignoreAreas: expect.arrayContaining([
          expect.objectContaining({ x: 1, y: 2, width: 30, height: 40 }),
        ]),
      }),
    );
  });

  test.each(["running", "empty"] as const)(
    "A and R do nothing while the run is %s (not reviewable — buttons are disabled)",
    (status) => {
      mockGetByIdData = { ...defaultMockData, status };
      render(
        <DiffViewer runId={RUN_ID} diffId="d1" initialCheckpointId="cp-1" />,
      );
      press("A");
      press("R");
      expect(reviewSpies.decide).not.toHaveBeenCalled();
    },
  );

  test("A and R do nothing while the run is overridden", () => {
    mockGetByIdData = {
      ...defaultMockData,
      status: "failed",
      statusOverride: "failed",
    };
    render(
      <DiffViewer runId={RUN_ID} diffId="d1" initialCheckpointId="cp-1" />,
    );
    press("A");
    press("R");
    press("X");
    expect(reviewSpies.decide).not.toHaveBeenCalled();
  });

  test("R rejects through the same call as the Reject button", () => {
    const r = render(
      <DiffViewer runId={RUN_ID} diffId="d1" initialCheckpointId="cp-1" />,
    );
    press("R");
    expect(reviewSpies.decide).toHaveBeenCalledOnce();
    expect(reviewSpies.decide).toHaveBeenCalledWith({
      runId: RUN_ID,
      checkpointIds: ["cp-1"],
      kind: "rejected",
      label: "Rejected 'CP-1'",
    });
    fireEvent.click(r.getByTestId("reject-button"));
    expect(reviewSpies.decide.mock.calls[1]).toEqual(
      reviewSpies.decide.mock.calls[0],
    );
  });

  test("X is the legacy alias of R", () => {
    render(
      <DiffViewer runId={RUN_ID} diffId="d1" initialCheckpointId="cp-1" />,
    );
    press("X");
    expect(reviewSpies.decide).toHaveBeenCalledWith(
      expect.objectContaining({ checkpointIds: ["cp-1"], kind: "rejected" }),
    );
  });

  test("typing 'a' into a text field does not approve", () => {
    render(
      <DiffViewer runId={RUN_ID} diffId="d1" initialCheckpointId="cp-1" />,
    );
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    press("a");
    press("A");
    input.remove();
    expect(reviewSpies.decide).not.toHaveBeenCalled();
  });

  // Spec §5.4: the keys must not send a decision the server would refuse.
  test.each([
    ["approved", "A", 0],
    ["approved", "R", 0],
    ["rejected", "A", 0],
    ["rejected", "R", 0],
    ["passed", "A", 0],
    ["passed", "R", 1],
    ["new", "A", 1],
    ["new", "R", 1],
  ] as const)("on a %s step, %s sends %i decision(s)", (state, key, calls) => {
    mockCheckpoints = {
      items: [
        stepFixture("cp-1", state, {
          decision:
            state === "approved" || state === "rejected"
              ? { actionId: "a", kind: state, undo: { allowed: true } }
              : null,
        }),
      ],
    };
    render(
      <DiffViewer runId={RUN_ID} diffId="d1" initialCheckpointId="cp-1" />,
    );
    press(key);
    expect(reviewSpies.decide).toHaveBeenCalledTimes(calls);
  });
});

describe("DiffViewer stale-capture guard", () => {
  const NEWER = { runId: "run-newer", buildId: "build-2", buildName: "#42" };
  beforeEach(() => {
    mockGetByIdData = { ...defaultMockData };
    mockCheckpoints = {
      items: [stepFixture("cp-1", "unresolved", { newerCapture: NEWER })],
    };
    resetReviewSpies();
  });
  afterEach(() => cleanup());

  test("the A key asks before approving an older capture", async () => {
    const r = render(
      <DiffViewer runId={RUN_ID} diffId="d1" initialCheckpointId="cp-1" />,
    );
    press("A");
    expect(reviewSpies.decide).not.toHaveBeenCalled();
    expect(await r.findByTestId("stale-step-dialog")).toBeDefined();
    fireEvent.click(r.getByTestId("stale-step-confirm"));
    expect(reviewSpies.decide).toHaveBeenCalledOnce();
  });

  // Every review key yields to the open question; R and X would reject the
  // step outright if one leaked through, since a rejection asks nothing.
  test("review keys are ignored while the confirm is open", async () => {
    const r = render(
      <DiffViewer runId={RUN_ID} diffId="d1" initialCheckpointId="cp-1" />,
    );
    press("A");
    await r.findByTestId("stale-step-dialog");
    for (const key of ["A", "R", "X", "a", "r"]) press(key);

    expect(reviewSpies.decide).not.toHaveBeenCalled();
    expect(r.getAllByTestId("stale-step-dialog")).toHaveLength(1);
    expect(r.getAllByRole("alertdialog")).toHaveLength(1);
  });

  test("Confirm is the only way the question decides", async () => {
    const r = render(
      <DiffViewer runId={RUN_ID} diffId="d1" initialCheckpointId="cp-1" />,
    );
    press("A");
    await r.findByTestId("stale-step-dialog");
    press("A");
    expect(reviewSpies.decide).not.toHaveBeenCalled();
    fireEvent.click(r.getByTestId("stale-step-confirm"));
    expect(reviewSpies.decide).toHaveBeenCalledOnce();
    expect(reviewSpies.decide).toHaveBeenCalledWith(
      expect.objectContaining({ checkpointIds: ["cp-1"], kind: "approved" }),
    );
  });

  test("opened by the A key, Cancel gives focus back to what had it", async () => {
    const r = render(
      <DiffViewer runId={RUN_ID} diffId="d1" initialCheckpointId="cp-1" />,
    );
    const more = r.getByTestId("approval-more-menu");
    more.focus();
    press("A");
    fireEvent.click(await r.findByTestId("stale-step-cancel"));
    await act(async () => {
      await new Promise((res) => setTimeout(res, 0));
    });
    expect(reviewSpies.decide).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(more);
  });

  test("shows the callout, linking to the newer capture", () => {
    mockGetByIdData = { ...defaultMockData, projectId: "proj-1" };
    const r = render(
      <DiffViewer runId={RUN_ID} diffId="d1" initialCheckpointId="cp-1" />,
    );
    const callout = r.getByTestId("stale-step-callout");
    expect(callout.getAttribute("role")).toBe("status");
    expect(callout.textContent).toContain(
      "A newer capture of this step exists in build #42. Approving here makes this older image the baseline.",
    );
    const link = r.getByRole("link", { name: "Open the newer capture" });
    expect(link.getAttribute("href")).toBe("/projects/proj-1/runs/run-newer");
  });

  test("shows no callout when the step has no newer capture", () => {
    mockCheckpoints = { items: [stepFixture("cp-1", "unresolved")] };
    const r = render(
      <DiffViewer runId={RUN_ID} diffId="d1" initialCheckpointId="cp-1" />,
    );
    expect(r.queryByTestId("stale-step-callout")).toBeNull();
  });

  test("shows no callout once the step is decided: nothing is being approved", () => {
    mockCheckpoints = {
      items: [
        stepFixture("cp-1", "approved", {
          newerCapture: NEWER,
          decision: {
            id: "d",
            actionId: "a",
            kind: "approved",
            actor: null,
            at: new Date().toISOString(),
            source: "viewer",
            legacy: false,
            undo: { allowed: false, reason: "superseded_newer_capture" },
          },
        }),
      ],
    };
    const r = render(
      <DiffViewer runId={RUN_ID} diffId="d1" initialCheckpointId="cp-1" />,
    );
    expect(r.queryByTestId("stale-step-callout")).toBeNull();
    expect(r.getByTestId("decision-chip")).toBeDefined();
  });
});

// R35: the viewer moves on as soon as the decision is made, not when the
// server answers; the target is the next step that still needs a reviewer.
describe("DiffViewer auto-advance", () => {
  beforeEach(() => {
    mockGetByIdData = { ...defaultMockData, projectId: "proj-1" };
    resetReviewSpies();
  });
  afterEach(() => cleanup());

  const checkpointUrl = (id: string) =>
    `/projects/proj-1/runs/${RUN_ID}/checkpoints/${id}`;

  test("approving moves to the next pending step, including a new one", () => {
    mockCheckpoints = {
      items: [
        stepFixture("c1", "unresolved"),
        stepFixture("c2", "approved"),
        stepFixture("c3", "new"),
      ],
    };
    render(
      <DiffViewer runId={RUN_ID} projectId="proj-1" initialCheckpointId="c1" />,
    );
    press("A");
    expect(reviewSpies.decide).toHaveBeenCalledOnce();
    expect(routerSpies.replace).toHaveBeenCalledWith(checkpointUrl("c3"));
  });

  test("wraps around to a pending step earlier in the run", () => {
    mockCheckpoints = {
      items: [
        stepFixture("c1", "unresolved"),
        stepFixture("c2", "passed"),
        stepFixture("c3", "unresolved"),
      ],
    };
    render(
      <DiffViewer runId={RUN_ID} projectId="proj-1" initialCheckpointId="c3" />,
    );
    press("R");
    expect(reviewSpies.decide).toHaveBeenCalledOnce();
    expect(routerSpies.replace).toHaveBeenCalledWith(checkpointUrl("c1"));
  });

  test("stays put when no other step needs a reviewer", () => {
    mockCheckpoints = {
      items: [stepFixture("c1", "unresolved"), stepFixture("c2", "approved")],
    };
    render(
      <DiffViewer runId={RUN_ID} projectId="proj-1" initialCheckpointId="c1" />,
    );
    press("A");
    expect(reviewSpies.decide).toHaveBeenCalledOnce();
    expect(routerSpies.replace).not.toHaveBeenCalled();
  });

  test("does not move when nothing was decided", () => {
    mockCheckpoints = {
      items: [stepFixture("c1", "approved"), stepFixture("c2", "unresolved")],
    };
    render(
      <DiffViewer runId={RUN_ID} projectId="proj-1" initialCheckpointId="c1" />,
    );
    press("A");
    expect(reviewSpies.decide).not.toHaveBeenCalled();
    expect(routerSpies.replace).not.toHaveBeenCalled();
  });
});

// ⌘Z undoes the newest review action through the review hook, and the hint bar
// shows the shortcut only while there is something to undo.
describe("DiffViewer undo shortcut and hint", () => {
  const pressCtrlZ = () =>
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "z",
          ctrlKey: true,
          bubbles: true,
        }),
      );
    });

  beforeEach(() => {
    mockGetByIdData = { ...defaultMockData };
    mockCheckpoints = { items: [stepFixture("cp-1", "unresolved")] };
    resetReviewSpies();
    useUndoStore.setState({ stack: [] });
    useViewerStore.setState({
      ignoreEditMode: "off",
      draftIgnoreAreas: [],
      markedForDeletion: new Set(),
      paddingOverrides: new Map(),
      kindOverrides: new Map(),
      selectedIgnoreId: null,
    });
  });
  afterEach(() => {
    cleanup();
    useUndoStore.setState({ stack: [] });
  });

  test("the hint bar shows ⌘Z Undo only while there is an action to undo", () => {
    const r = render(
      <DiffViewer runId={RUN_ID} diffId="d1" initialCheckpointId="cp-1" />,
    );
    expect(r.queryByTestId("shortcut-hint-undo")).toBeNull();

    act(() => {
      useUndoStore
        .getState()
        .push({ actionId: "a1", label: "Approved 'CP-1'", runIds: [RUN_ID] });
    });
    const hint = r.getByTestId("shortcut-hint-undo");
    expect(hint.querySelector("kbd")?.textContent).toBe("⌘Z");
    expect(hint.textContent).toContain("Undo");

    act(() => {
      useUndoStore.getState().drop("a1");
    });
    expect(r.queryByTestId("shortcut-hint-undo")).toBeNull();
  });

  test("⌘Z undoes through the review hook, with no action id (the newest)", () => {
    render(
      <DiffViewer runId={RUN_ID} diffId="d1" initialCheckpointId="cp-1" />,
    );
    pressCtrlZ();
    expect(reviewSpies.undo).toHaveBeenCalledOnce();
    expect(reviewSpies.undo.mock.calls[0]).toEqual([]);
  });

  test("⌘Z while typing in a text field does not undo", () => {
    render(
      <DiffViewer runId={RUN_ID} diffId="d1" initialCheckpointId="cp-1" />,
    );
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    pressCtrlZ();
    input.remove();
    expect(reviewSpies.undo).not.toHaveBeenCalled();
  });
});
