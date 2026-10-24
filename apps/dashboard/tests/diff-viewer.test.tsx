import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render as renderInDom,
  waitFor,
  within,
  type RenderOptions,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  AnchorHTMLAttributes,
  ComponentProps,
  MouseEvent as ReactMouseEvent,
  ReactElement,
  ReactNode,
} from "react";
import { Profiler, useCallback, useRef } from "react";
import { toast } from "sonner";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
  type MockInstance,
} from "vitest";

// Review-action spies: the keyboard shortcuts and the ApprovalBar buttons
// must reach the server through the SAME call (see the hotkey parity block at
// the bottom of this file). The review hook is mocked: its own suite covers
// what a decision does to the caches and the server.
const {
  reviewSpies,
  routerSpies,
  navState,
  setIgnoreAreasSpy,
  nextQuery,
  utilsMock,
  realReview,
  server,
  mutationFor,
  retryDiffSpy,
} = vi.hoisted(() => {
  /** A procedure's utils, as the viewer, the loop and the review hook use them. */
  const procedure = () => ({
    invalidate: vi.fn(),
    cancel: vi.fn(async () => undefined),
    getData: vi.fn(),
    setData: vi.fn(),
    prefetch: vi.fn(),
    fetch: vi.fn(),
  });
  // What the review "server" answers, when the real review hook is on.
  const server = {
    approve: vi.fn(),
    reject: vi.fn(),
    approveGroup: vi.fn(),
    rejectGroup: vi.fn(),
    approveBuild: vi.fn(),
    revert: vi.fn(),
  };
  interface Lifecycle {
    onMutate?: (vars: unknown) => unknown;
    onSuccess?: (data: unknown, vars: unknown) => unknown;
    onError?: (err: unknown, vars: unknown) => unknown;
    onSettled?: (data: unknown, err: unknown, vars: unknown) => unknown;
  }
  // The slice of TanStack's mutation lifecycle the review hook relies on.
  async function runMutation(
    name: keyof typeof server,
    opts: Lifecycle,
    vars: unknown,
  ) {
    await opts.onMutate?.(vars);
    try {
      const data: unknown = await server[name](vars);
      await opts.onSuccess?.(data, vars);
      await opts.onSettled?.(data, null, vars);
    } catch (err) {
      await opts.onError?.(err, vars);
      await opts.onSettled?.(undefined, err, vars);
    }
  }
  return {
    // The ignore-region Save's wire input, so a test can see which step's
    // variation it targets.
    setIgnoreAreasSpy: vi.fn(),
    // `runs.retryDiff`, as the viewer's Retry diff calls it.
    retryDiffSpy: vi.fn(async (_input: unknown) => ({ status: "running" })),
    reviewSpies: {
      decide: vi.fn(),
      undo: vi.fn(),
      isInFlight: vi.fn((_id: string) => false),
    },
    // One router object for every render, so effects that depend on it don't
    // re-run each time.
    routerSpies: { push: vi.fn(), replace: vi.fn() },
    // The URL on screen (`usePathname`, `useSearchParams`), set by a test
    // that needs it.
    navState: { pathname: "", search: "" },
    // What the live `review.next` query answers (the review loop), set per
    // test, and every call it got.
    nextQuery: {
      data: undefined as unknown,
      isLoading: false,
      isFetching: false,
      isError: false,
      error: null as { message: string } | null,
      refetch: vi.fn(),
      calls: [] as Array<{ input: unknown; options: { enabled?: boolean } }>,
    },
    // One utils object for every render, like tRPC's.
    utilsMock: {
      runs: {
        getById: procedure(),
        listCheckpoints: procedure(),
        list: procedure(),
        facets: procedure(),
        getCheckpointGroup: procedure(),
      },
      builds: {
        getById: procedure(),
        list: procedure(),
        pendingCount: procedure(),
      },
      review: { next: procedure() },
    },
    // Off: the review hook is the spies above. On: the real hook, over the
    // stubbed mutations below (for what a refusal does after the loop moved).
    realReview: { on: false },
    server,
    // Like TanStack's, `mutate` is stable and calls the latest lifecycle.
    mutationFor: (name: keyof typeof server) => ({
      useMutation: (opts: Lifecycle) => {
        const latest = useRef(opts);
        latest.current = opts;
        const mutate = useCallback((vars: unknown) => {
          void runMutation(name, latest.current, vars);
        }, []);
        return { mutate, isPending: false };
      },
    }),
  };
});
vi.mock("@/lib/review/use-review-mutations", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../src/lib/review/use-review-mutations")
    >();
  return {
    ...actual,
    useReviewMutations: () =>
      realReview.on ? actual.useReviewMutations() : reviewSpies,
  };
});
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

// Tracks how many times a Pixi Application has been initialized. Module-level
// so the regression test can read it without any reference to the mock class.
let pixiInitCount = 0;

// Mock pixi.js — we test toolbar/store behavior, not WebGL. Enough of it for
// a mode to mount over images that load: inert display objects.
vi.mock("pixi.js", () => {
  const point = () => ({ set: () => {} });
  class Container {
    label = "";
    alpha = 1;
    eventMode = "passive";
    cursor = "";
    scale = point();
    position = point();
    children: unknown[] = [];
    addChild<T>(c: T): T {
      this.children = this.children.filter((x) => x !== c);
      this.children.push(c);
      return c;
    }
    removeChild<T>(c: T): T {
      this.children = this.children.filter((x) => x !== c);
      return c;
    }
    on() {
      return this;
    }
    destroy() {}
  }
  class Graphics extends Container {
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
    clear() {
      return this;
    }
    moveTo() {
      return this;
    }
    lineTo() {
      return this;
    }
  }
  class Sprite extends Container {
    width = 0;
    height = 0;
    constructor(public texture?: unknown) {
      super();
    }
  }
  return {
    Application: class {
      canvas = document.createElement("canvas");
      stage = new Container();
      screen = { width: 600, height: 400 };
      ticker = { add: () => {}, remove: () => {} };
      async init() {
        pixiInitCount++;
      }
      destroy() {}
    },
    Assets: { load: async () => ({}) },
    Sprite,
    Container,
    Graphics,
    Text: Container,
    Texture: { from: () => ({ destroy: () => {} }) },
  };
});

// Mock next/navigation — DiffViewer and its review loop navigate with
// useRouter.
vi.mock("next/navigation", () => ({
  useRouter: () => routerSpies,
  usePathname: () => navState.pathname,
  useSearchParams: () => new URLSearchParams(navState.search),
}));
// next/link as the app router runs a click (Next 15.5's `linkClicked`): the
// link's own onClick first; a click it took, or a modified one (a new tab),
// is left alone; otherwise `onNavigate`, which may call it off, then the
// navigation itself, a push unless `replace` (here, onto the router spies).
vi.mock("next/link", async () => {
  const { createElement } = await import("react");
  type LinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
    href: string;
    replace?: boolean;
    prefetch?: unknown;
    scroll?: unknown;
    onNavigate?: (e: { preventDefault(): void }) => void;
  };
  function Link({
    href,
    replace,
    prefetch: _prefetch,
    scroll: _scroll,
    onNavigate,
    onClick,
    ...rest
  }: LinkProps) {
    return createElement("a", {
      ...rest,
      href,
      onClick: (e: ReactMouseEvent<HTMLAnchorElement>) => {
        onClick?.(e);
        if (e.defaultPrevented) return;
        const modified =
          (rest.target && rest.target !== "_self") ||
          e.metaKey ||
          e.ctrlKey ||
          e.shiftKey ||
          e.altKey ||
          e.button !== 0;
        if (modified) return;
        e.preventDefault();
        let cancelled = false;
        onNavigate?.({ preventDefault: () => (cancelled = true) });
        if (cancelled) return;
        if (replace) routerSpies.replace(href);
        else routerSpies.push(href);
      },
    });
  }
  return { default: Link };
});

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
  checkpointContexts?: Record<string, unknown>;
  diffPercent?: number | null;
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
};
let mockGetByIdData: MockData = { ...defaultMockData };
// `runs.getById` failing (e.g. a shared link to a run that is gone).
let mockGetByIdError: { message: string; data?: { code: string } } | null =
  null;
// A refetch that fails keeps the data it had (a run deleted while open).
let mockGetByIdKeepsData = false;
// ADR-038 checkpoint list — configurable per-test so the side step-arrows
// (which need total > 1) can be exercised. Empty by default.
let mockCheckpoints: { items: unknown[] } = { items: [] };
// The step's same-change group (ADR-042), for the group-approval callout;
// none by default.
let mockGroup: unknown = undefined;

// Mock the tRPC client.
// T9: getById response includes baselineScreenshot + diffName.
// T11: DiffViewer uses trpc.useUtils() for query invalidation; its review
// actions (keyboard shortcuts and the embedded <ApprovalBar>) read the same
// two queries and make their decisions through the mocked review hook.
vi.mock("../src/lib/trpc", () => {
  const noopMutation = () => ({ mutate: () => undefined, isPending: false });
  return {
    trpc: {
      useUtils: () => utilsMock,
      runs: {
        getById: {
          useQuery: () => ({
            data:
              mockGetByIdError && !mockGetByIdKeepsData
                ? undefined
                : mockGetByIdData,
            isLoading: false,
            error: mockGetByIdError,
          }),
        },
        // ADR-038: checkpoint list — configurable via mockCheckpoints.
        listCheckpoints: {
          _def: () => ({ path: ["runs", "listCheckpoints"] }),
          useQuery: () => ({
            data: mockCheckpoints,
            isLoading: false,
            error: null,
          }),
        },
        // The review hook's cache patch reads the runs lists by key.
        list: { _def: () => ({ path: ["runs", "list"] }) },
        overrideStatus: { useMutation: noopMutation },
        retryDiff: {
          useMutation: () => ({
            mutateAsync: retryDiffSpy,
            isPending: false,
          }),
        },
        setComment: { useMutation: noopMutation },
        setIgnoreAreas: {
          useMutation: () => ({ mutate: setIgnoreAreasSpy, isPending: false }),
        },
        setTempIgnoreAreas: { useMutation: noopMutation },
        setDiffThresholdOverride: { useMutation: noopMutation },
        // ADR-042: group-approval callout — data:undefined (the default)
        // fires its null-guard → renders nothing.
        getCheckpointGroup: {
          useQuery: () => ({ data: mockGroup, isLoading: false, error: null }),
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
      review: {
        // The review loop's answer, set per test through `nextQuery`.
        next: {
          useQuery: (input: unknown, options: { enabled?: boolean }) => {
            nextQuery.calls.push({ input, options });
            return {
              data: nextQuery.data,
              isLoading: nextQuery.isLoading,
              isFetching: nextQuery.isFetching,
              isError: nextQuery.isError,
              error: nextQuery.error,
              refetch: nextQuery.refetch,
            };
          },
        },
        approve: mutationFor("approve"),
        reject: mutationFor("reject"),
        approveGroup: mutationFor("approveGroup"),
        rejectGroup: mutationFor("rejectGroup"),
        approveBuild: mutationFor("approveBuild"),
        revert: mutationFor("revert"),
      },
    },
  };
});

// T11: DiffViewer mounts useRunEvents which opens an EventSource. jsdom
// has no EventSource — stub it. It keeps its listeners, so a test can deliver
// a frame; without one it is a no-op for the other tests.
class StubEventSource {
  static instances: StubEventSource[] = [];
  url: string;
  withCredentials: boolean;
  listeners: Array<(m: { data: string }) => void> = [];
  constructor(url: string, init?: EventSourceInit) {
    this.url = url;
    this.withCredentials = init?.withCredentials ?? false;
    StubEventSource.instances.push(this);
  }
  addEventListener(_type: string, fn: (m: { data: string }) => void): void {
    this.listeners.push(fn);
  }
  removeEventListener(_type: string, fn: (m: { data: string }) => void): void {
    this.listeners = this.listeners.filter((l) => l !== fn);
  }
  /** Delivers a `progress` frame to the hook. */
  emit(event: unknown): void {
    for (const fn of this.listeners) fn({ data: JSON.stringify(event) });
  }
  close(): void {
    /* noop */
  }
}
(globalThis as unknown as { EventSource: typeof StubEventSource }).EventSource =
  StubEventSource;

import type { ViewerMode } from "../src/components/diff-viewer/comparison-modes";
import { DiffViewer as ViewerUnderTest } from "../src/components/diff-viewer/DiffViewer";
import { useViewerStore } from "../src/components/diff-viewer/useViewerStore";
import { useViewState } from "../src/components/diff-viewer/view-state";
import { readEffectiveMode } from "../src/components/diff-viewer/viewer-mode";
import {
  DEFAULT_VIEWER_PREFS,
  prefsKey,
  useViewerPrefs,
} from "../src/components/diff-viewer/viewer-prefs";
import { useReviewAnnouncer } from "../src/lib/review/review-announcer";
import { loopHandoff, useLoopCue } from "../src/lib/review/use-review-loop";
import { useInFlightStore } from "../src/lib/review/use-review-mutations";
import { useUndoStore } from "../src/lib/review/use-undo-store";

import { usePaletteStore } from "@/components/cmdk/use-command-palette";
import { useShortcutsSheet } from "@/components/shortcuts/use-shortcuts-sheet";
import { CommandDispatcher } from "@/lib/commands/dispatcher";
import { GlobalCommands } from "@/lib/commands/global-commands";
import { useSingleKeyStore } from "@/lib/commands/prefs";
import {
  CommandRoleProvider,
  resolveCommands,
  useCommandRegistry,
} from "@/lib/commands/registry";
import { canReviewRole, type ViewerRole } from "@/lib/roles";

/**
 * The protected layout's keyboard, around every viewer here, as the app
 * mounts it: the role, the global commands (⌘Z among them) and the one
 * dispatcher, which runs the viewer's keys from the registry. A reviewer,
 * unless a test says otherwise.
 */
const keyboard: { role: ViewerRole } = { role: "editor" };
// The layout's providers: the global undo reads a query client.
const layoutQueryClient = new QueryClient();
function Keyboard({ children }: { children: ReactNode }) {
  return (
    <CommandRoleProvider role={keyboard.role}>
      <QueryClientProvider client={layoutQueryClient}>
        <GlobalCommands />
      </QueryClientProvider>
      <CommandDispatcher />
      {children}
    </CommandRoleProvider>
  );
}
function render(ui: ReactElement, options?: Omit<RenderOptions, "wrapper">) {
  return renderInDom(ui, { wrapper: Keyboard, ...options });
}

/**
 * The viewer as the checkpoint page hands it out: `canReview` is the
 * server's answer for the same role the keyboard has, unless a test says,
 * and there is no user id (preferences in memory) unless a test gives one.
 */
function DiffViewer(
  props: Omit<
    ComponentProps<typeof ViewerUnderTest>,
    "canReview" | "userId"
  > & {
    canReview?: boolean;
    userId?: string | null;
  },
) {
  return (
    <ViewerUnderTest
      canReview={canReviewRole(keyboard.role)}
      userId={null}
      {...props}
    />
  );
}

/**
 * The viewer's history writes (R31): a mode change replaces the URL with
 * `history.replaceState`, which Next applies to `usePathname` and
 * `useSearchParams` in a transition, with no navigation. Here the write moves
 * the URL the mocks read, and the render that shows the mode reads it.
 */
let historyWrite: MockInstance<History["replaceState"]>;
beforeEach(() => {
  historyWrite = vi
    .spyOn(window.history, "replaceState")
    .mockImplementation((_data, _unused, url) => {
      if (url === undefined || url === null) return;
      const at = new URL(String(url), "http://localhost");
      navState.pathname = at.pathname;
      navState.search = at.search.slice(1);
    });
});
afterEach(() => historyWrite.mockRestore());

beforeEach(() => {
  mockGroup = undefined;
  keyboard.role = "editor";
  // A fresh visit: the default preferences, none read yet, and a fit view.
  useViewerPrefs.setState({
    userId: null,
    prefs: DEFAULT_VIEWER_PREFS,
    previousMode: "side-by-side",
  });
  useViewState.getState().resetView({ reducedMotion: false });
  // The ignore-region editor closed: its store outlives every viewer, and
  // open it shows Swipe and Flicker as side by side (spec §4.4).
  useViewerStore.setState({ ignoreEditMode: "off" });
  useCommandRegistry.setState({ entries: [], role: "guest" });
  useSingleKeyStore.setState({ on: true });
  usePaletteStore.setState({ open: false });
  useShortcutsSheet.setState({ open: false });
});

/** Every mock the review loop reads, back to "no answer yet". */
function resetLoop() {
  nextQuery.data = undefined;
  nextQuery.isLoading = false;
  nextQuery.isFetching = false;
  nextQuery.isError = false;
  nextQuery.error = null;
  nextQuery.refetch.mockReset();
  nextQuery.calls = [];
  for (const group of Object.values(utilsMock)) {
    for (const proc of Object.values(group)) {
      for (const fn of Object.values(proc)) fn.mockReset();
    }
  }
  utilsMock.runs.getById.getData.mockReturnValue({ name: "Checkout" });
  for (const fn of Object.values(server)) fn.mockReset();
  realReview.on = false;
  mockGetByIdError = null;
  mockGetByIdKeepsData = false;
  vi.mocked(toast.error).mockReset();
  vi.mocked(toast.success).mockReset();
  useLoopCue.setState({ cue: null });
  loopHandoff.slot = null;
  useInFlightStore.setState({ ids: new Set(), decisions: new Set() });
  useReviewAnnouncer.setState({ text: "", seq: 0 });
  navState.pathname = "";
  navState.search = "";
}

describe("DiffViewer", () => {
  beforeEach(() => {
    pixiInitCount = 0;
    StubEventSource.instances = [];
    mockGetByIdData = { ...defaultMockData };
    mockCheckpoints = { items: [] };
    resetLoop();
    useViewerStore.setState({ viewport: "" });
    useViewerPrefs.setState({
      prefs: { ...DEFAULT_VIEWER_PREFS, highlight: false },
    });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  /**
   * A run whose step has a baseline, so every mode is available (R2). Its
   * images are never answered: nothing reaches the network.
   */
  function withBaseline() {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {})),
    );
    mockGetByIdData = {
      ...defaultMockData,
      baselineScreenshot: { id: "base", imageKey: "base-img" },
      screenshots: [{ id: "c1", imageKey: "img-1", diffImageKey: null }],
    };
  }

  test("renders the toolbar's comparison modes: a radio group of the five", () => {
    const r = render(
      <DiffViewer runId="00000000-0000-0000-0000-000000000000" diffId="d1" />,
    );
    const group = r.getByRole("radiogroup", { name: "Comparison mode" });
    expect(
      within(group)
        .getAllByRole("radio")
        .map((radio) => radio.textContent),
    ).toEqual(["Side by side", "Swipe", "Flicker", "Overlay", "Diff"]);
  });

  test("the run is refetched on the worker's run.checkpoint_diffed and run.completed, not on every event", () => {
    const runId = "00000000-0000-0000-0000-000000000000";
    render(<DiffViewer runId={runId} diffId="d1" />);
    const es = StubEventSource.instances.at(-1)!;
    const getById = utilsMock.runs.getById.invalidate;

    act(() => es.emit({ type: "capture.started", runId }));
    expect(getById).not.toHaveBeenCalled();

    act(() =>
      es.emit({
        type: "run.checkpoint_diffed",
        runId,
        screenshotId: "s1",
        verdict: "passed",
        failed: false,
      }),
    );
    expect(getById).toHaveBeenCalledTimes(1);
    expect(getById).toHaveBeenLastCalledWith({ runId });

    act(() => es.emit({ type: "run.completed", runId }));
    expect(getById).toHaveBeenCalledTimes(2);
  });

  test("clicking a tab sets the mode preference", () => {
    withBaseline();
    const r = render(
      <DiffViewer runId="00000000-0000-0000-0000-000000000000" diffId="d1" />,
    );
    fireEvent.click(r.getByRole("radio", { name: /^overlay$/i }));
    expect(useViewerPrefs.getState().prefs.mode).toBe("overlay");

    fireEvent.click(r.getByRole("radio", { name: /^diff$/i }));
    expect(useViewerPrefs.getState().prefs.mode).toBe("diff");
  });

  test("a mode change keeps the zoom and the pan: every mode draws the one world (R8)", () => {
    withBaseline();
    const r = render(
      <DiffViewer runId="00000000-0000-0000-0000-000000000000" diffId="d1" />,
    );
    act(() => useViewState.getState().setView({ zoom: 3, panX: 40, panY: 9 }));
    fireEvent.click(r.getByRole("radio", { name: /^overlay$/i }));
    expect(useViewState.getState()).toMatchObject({
      zoom: 3,
      panX: 40,
      panY: 9,
    });
    fireEvent.click(r.getByRole("radio", { name: /side by side/i }));
    expect(useViewState.getState()).toMatchObject({
      zoom: 3,
      panX: 40,
      panY: 9,
    });
  });

  test("a flicker preference draws Flicker, on one stage, with Pause in the toolbar, and is kept", () => {
    withBaseline();
    useViewerPrefs.setState({
      prefs: { ...DEFAULT_VIEWER_PREFS, mode: "flicker" },
    });
    const r = render(
      <DiffViewer runId="00000000-0000-0000-0000-000000000000" diffId="d1" />,
    );
    expect(r.getByTestId("single-stage-host").dataset.mode).toBe("flicker");
    expect(r.queryByTestId("candidate-canvas-host")).toBeNull();
    expect(r.getByRole("button", { name: "Pause" })).toBeDefined();
    expect(useViewerPrefs.getState().prefs.mode).toBe("flicker");
  });

  test("a swipe preference draws Swipe, on one stage, and is kept", () => {
    withBaseline();
    useViewerPrefs.setState({
      prefs: { ...DEFAULT_VIEWER_PREFS, mode: "swipe" },
    });
    const r = render(
      <DiffViewer runId="00000000-0000-0000-0000-000000000000" diffId="d1" />,
    );
    expect(r.getByTestId("single-stage-host").dataset.mode).toBe("swipe");
    expect(r.queryByTestId("candidate-canvas-host")).toBeNull();
    expect(useViewerPrefs.getState().prefs.mode).toBe("swipe");
  });

  describe("preferences", () => {
    beforeEach(() => localStorage.clear());
    afterEach(() => localStorage.clear());

    test("mode persists across a remount via preferences", async () => {
      withBaseline();
      localStorage.setItem(
        prefsKey("u1"),
        JSON.stringify({ ...DEFAULT_VIEWER_PREFS, mode: "overlay" }),
      );
      const r = render(
        <DiffViewer
          runId="00000000-0000-0000-0000-000000000000"
          diffId="d1"
          userId="u1"
        />,
      );
      expect(
        r
          .getByRole("radio", { name: /^overlay$/i })
          .getAttribute("aria-checked"),
      ).toBe("true");
      expect(r.getByTestId("single-stage-host").dataset.mode).toBe("overlay");
      // The first paint is already the saved mode: one stage was mounted, and
      // never the two side-by-side panes before it.
      await act(async () => {});
      expect(pixiInitCount).toBe(1);

      // A change is saved for this user, and the next visit opens on it.
      fireEvent.click(r.getByRole("radio", { name: /^diff$/i }));
      r.unmount();
      useViewerPrefs.setState({
        userId: null,
        prefs: DEFAULT_VIEWER_PREFS,
      });
      const again = render(
        <DiffViewer
          runId="00000000-0000-0000-0000-000000000000"
          diffId="d1"
          userId="u1"
        />,
      );
      expect(again.getByTestId("single-stage-host").dataset.mode).toBe("diff");
    });

    test("a visit with no user after a user's: the defaults, and nothing written to that user", () => {
      withBaseline();
      localStorage.setItem(
        prefsKey("u1"),
        JSON.stringify({ ...DEFAULT_VIEWER_PREFS, mode: "overlay" }),
      );
      const first = render(
        <DiffViewer
          runId="00000000-0000-0000-0000-000000000000"
          diffId="d1"
          userId="u1"
        />,
      );
      expect(first.getByTestId("single-stage-host").dataset.mode).toBe(
        "overlay",
      );
      first.unmount();

      const r = render(
        <DiffViewer
          runId="00000000-0000-0000-0000-000000000000"
          diffId="d1"
          userId={null}
        />,
      );
      expect(useViewerPrefs.getState().prefs.mode).toBe("side-by-side");
      expect(r.getByTestId("candidate-canvas-host")).toBeDefined();
      fireEvent.click(r.getByRole("radio", { name: /^diff$/i }));
      expect(JSON.parse(localStorage.getItem(prefsKey("u1"))!).mode).toBe(
        "overlay",
      );
    });

    test("without a user the mode holds for the visit and nothing is stored", () => {
      withBaseline();
      const r = render(
        <DiffViewer runId="00000000-0000-0000-0000-000000000000" diffId="d1" />,
      );
      fireEvent.click(r.getByRole("radio", { name: /^overlay$/i }));
      r.unmount();
      const again = render(
        <DiffViewer runId="00000000-0000-0000-0000-000000000000" diffId="d1" />,
      );
      expect(again.getByTestId("single-stage-host").dataset.mode).toBe(
        "overlay",
      );
      expect(localStorage.length).toBe(0);
    });
  });

  describe("the view resets", () => {
    /** The view as a reviewer leaves it on a step. */
    function leaveAView() {
      act(() => {
        useViewState.getState().setView({ zoom: 3, panX: 25, panY: -8 });
        useViewState.getState().setSwipe(0.2);
        useViewState.getState().setSelected("r1");
      });
    }
    function expectAFreshView() {
      expect(useViewState.getState()).toMatchObject({
        zoom: 1,
        panX: 0,
        panY: 0,
        swipe: 0.5,
        selectedRegionId: null,
      });
    }

    test("a step change resets the view", () => {
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
      leaveAView();
      fireEvent.click(r.getByTestId("diff-viewer-step-next"));
      expectAFreshView();
    });

    test("a step change is at fit by its first commit: the reset runs before anything can paint the step (m6)", () => {
      mockCheckpoints = {
        items: [
          { id: "c1", name: "Home", state: "unresolved" },
          { id: "c2", name: "Search", state: "unresolved" },
        ],
      };
      // Each commit of the viewer, read at the end of its layout phase (a
      // Profiler's onRender runs after its subtree's layout effects): which
      // step the DOM shows, and the view then. A passive reset would land
      // after the step's first commit, which the browser can paint.
      const commits: Array<{ onSecond: boolean; zoom: number; swipe: number }> =
        [];
      const onRender = () => {
        const next = document.querySelector<HTMLButtonElement>(
          '[data-testid="diff-viewer-step-next"]',
        );
        const { zoom, swipe } = useViewState.getState();
        commits.push({ onSecond: next?.disabled === true, zoom, swipe });
      };
      const r = render(
        <Profiler id="viewer" onRender={onRender}>
          <DiffViewer
            runId="00000000-0000-0000-0000-000000000000"
            projectId="p1"
            initialCheckpointId="c1"
          />
        </Profiler>,
      );
      leaveAView();
      commits.length = 0;
      fireEvent.click(r.getByTestId("diff-viewer-step-next"));
      const onSecond = commits.filter((c) => c.onSecond);
      expect(onSecond.length).toBeGreaterThan(0);
      for (const c of onSecond)
        expect(c).toEqual({ onSecond: true, zoom: 1, swipe: 0.5 });
    });

    test("a viewport switch resets the view", () => {
      mockGetByIdData = {
        ...defaultMockData,
        screenshots: [
          { id: "c1", viewport: "1280x720" },
          { id: "c2", viewport: "375x812" },
        ],
      };
      const r = render(
        <DiffViewer runId="00000000-0000-0000-0000-000000000000" diffId="d1" />,
      );
      leaveAView();
      fireEvent.click(r.getByRole("button", { name: "375x812" }));
      expect(useViewerStore.getState().viewport).toBe("375x812");
      expectAFreshView();
    });

    test("new data for the same step (a refetch) keeps the view", () => {
      mockCheckpoints = {
        items: [
          { id: "c1", name: "Home", state: "unresolved" },
          { id: "c2", name: "Search", state: "unresolved" },
        ],
      };
      const shots = () => [
        { id: "c1", viewport: "1280x720" },
        { id: "c2", viewport: "1280x720" },
      ];
      mockGetByIdData = { ...defaultMockData, screenshots: shots() };
      const viewer = (
        <DiffViewer
          runId="00000000-0000-0000-0000-000000000000"
          projectId="p1"
          initialCheckpointId="c1"
        />
      );
      const r = render(viewer);
      leaveAView();
      // What an SSE refresh brings: fresh objects, new regions, same step.
      mockGetByIdData = {
        ...defaultMockData,
        screenshots: shots(),
        diffRegions: [
          {
            id: "r1",
            severity: "major",
            category: "visual",
            bbox: { x: 1, y: 2, width: 3, height: 4 },
            description: "",
            source: "l1_pixel",
          },
        ],
      };
      r.rerender(viewer);
      expect(useViewState.getState()).toMatchObject({
        zoom: 3,
        panX: 25,
        panY: -8,
        swipe: 0.2,
        selectedRegionId: "r1",
      });
    });

    test("a remount on the next step starts fresh too: the store outlives it", () => {
      leaveAView();
      render(
        <DiffViewer runId="00000000-0000-0000-0000-000000000000" diffId="d1" />,
      );
      expectAFreshView();
    });

    test("under reduced motion the flicker starts paused", () => {
      const matchMedia = vi.fn((query: string) => ({
        matches: query === "(prefers-reduced-motion: reduce)",
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }));
      vi.stubGlobal("matchMedia", matchMedia);
      try {
        act(() => useViewState.getState().setFlicker("current", true));
        render(
          <DiffViewer
            runId="00000000-0000-0000-0000-000000000000"
            diffId="d1"
          />,
        );
        expect(useViewState.getState()).toMatchObject({
          flickerFrame: "baseline",
          flickerPlaying: false,
        });
      } finally {
        vi.unstubAllGlobals();
      }
    });
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

  describe("the diff image", () => {
    /** The storage keys the viewer asked the proxy for, in request order. */
    function requestedKeys(fetchMock: ReturnType<typeof vi.fn>): string[] {
      return fetchMock.mock.calls.map(
        ([url]) => String(url).split("/api/v1/storage/")[1] ?? "",
      );
    }
    // Never answered: the step's own images stay loading, so the steps
    // either side are not fetched ahead and every key asked for is this
    // step's.
    async function withFetch(
      body: (fetchMock: ReturnType<typeof vi.fn>) => void | Promise<void>,
    ) {
      const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
      vi.stubGlobal("fetch", fetchMock);
      try {
        await body(fetchMock);
      } finally {
        vi.unstubAllGlobals();
      }
    }

    test("uses the step's own diff image, not the run's", async () => {
      // The run's `diffName` is its worst step's (step 1); step 2 has its own.
      mockGetByIdData = {
        ...defaultMockData,
        diffName: "diff-of-step-1",
        screenshots: [
          { id: "c1", imageKey: "img-1", diffImageKey: "diff-of-step-1" },
          { id: "c2", imageKey: "img-2", diffImageKey: "diff-of-step-2" },
        ],
      };
      mockCheckpoints = {
        items: [
          { id: "c1", name: "Home", state: "unresolved" },
          { id: "c2", name: "Search", state: "unresolved" },
        ],
      };
      await withFetch(async (fetchMock) => {
        render(
          <DiffViewer
            runId="00000000-0000-0000-0000-000000000000"
            projectId="p1"
            initialCheckpointId="c2"
          />,
        );
        await vi.waitFor(() =>
          expect(requestedKeys(fetchMock)).toContain("diff-of-step-2"),
        );
        expect(requestedKeys(fetchMock)).not.toContain("diff-of-step-1");
        expect(
          document
            .getElementById("diff-viewer-canvas")
            ?.hasAttribute("data-diff-image-legacy-missing"),
        ).toBe(false);
      });
    });

    test("a step of a multi-step run with no image of its own is not given the run's", async () => {
      // A run diffed before steps kept their own images: `diffName` is the
      // worst step's, so showing it on step 2 would draw step 1's diff.
      mockGetByIdData = {
        ...defaultMockData,
        diffName: "diff-of-step-1",
        screenshots: [
          { id: "c1", imageKey: "img-1", diffImageKey: null },
          { id: "c2", imageKey: "img-2", diffImageKey: null },
        ],
      };
      mockCheckpoints = {
        items: [
          { id: "c1", name: "Home", state: "unresolved" },
          { id: "c2", name: "Search", state: "unresolved" },
        ],
      };
      await withFetch(async (fetchMock) => {
        render(
          <DiffViewer
            runId="00000000-0000-0000-0000-000000000000"
            projectId="p1"
            initialCheckpointId="c2"
          />,
        );
        // The step's own image is requested, so the viewer has had its chance
        // to ask for the diff image too.
        await vi.waitFor(() =>
          expect(requestedKeys(fetchMock)).toContain("img-2"),
        );
        expect(requestedKeys(fetchMock)).not.toContain("diff-of-step-1");
        // Said so, for the canvas to tell the reviewer why there is no image.
        expect(
          document
            .getElementById("diff-viewer-canvas")
            ?.getAttribute("data-diff-image-legacy-missing"),
        ).toBe("true");
      });
    });

    test("once the step's images are in, the steps either side are fetched ahead: their images, baselines and own diff images", async () => {
      const ctx = (key: string) => ({
        baselineScreenshot: { id: `base-of-${key}`, imageKey: key },
        baselineSource: null,
        variationIgnoreAreas: null,
      });
      mockGetByIdData = {
        ...defaultMockData,
        diffName: "pf-diff-of-the-run",
        screenshots: [
          { id: "c1", imageKey: "pf-img-1", diffImageKey: "pf-diff-1" },
          { id: "c2", imageKey: "pf-img-2", diffImageKey: "pf-diff-2" },
          // Diffed before steps kept their own images: none to fetch.
          { id: "c3", imageKey: "pf-img-3", diffImageKey: null },
        ],
        checkpointContexts: {
          c1: ctx("pf-base-1"),
          c2: ctx("pf-base-2"),
          c3: ctx("pf-base-3"),
        },
      };
      mockCheckpoints = {
        items: [
          { id: "c1", name: "Home", state: "unresolved" },
          { id: "c2", name: "Search", state: "unresolved" },
          { id: "c3", name: "Cart", state: "unresolved" },
        ],
      };
      const answers: Array<() => void> = [];
      const fetchMock = vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            answers.push(() => resolve(new Response(null, { status: 404 })));
          }),
      );
      vi.stubGlobal("fetch", fetchMock);
      try {
        render(
          <DiffViewer
            runId="00000000-0000-0000-0000-000000000000"
            projectId="p1"
            initialCheckpointId="c2"
          />,
        );
        const step2 = ["pf-base-2", "pf-diff-2", "pf-img-2"];
        await vi.waitFor(() =>
          expect(requestedKeys(fetchMock).sort()).toEqual(step2),
        );
        // Nothing ahead while the step's own images are on the wire.
        await act(async () => {
          await new Promise((r) => setTimeout(r, 0));
        });
        expect(requestedKeys(fetchMock).sort()).toEqual(step2);

        // A failed image is settled too: the step is ready.
        await act(async () => {
          for (const answer of answers.splice(0)) answer();
          await new Promise((r) => setTimeout(r, 0));
        });
        await vi.waitFor(() =>
          expect(requestedKeys(fetchMock).sort()).toEqual(
            [
              ...step2,
              "pf-img-1",
              "pf-base-1",
              "pf-diff-1",
              "pf-img-3",
              "pf-base-3",
            ].sort(),
          ),
        );
        expect(requestedKeys(fetchMock)).not.toContain("pf-diff-of-the-run");
      } finally {
        vi.unstubAllGlobals();
      }
    });

    test("a legacy single-step run still shows the run's diff image", async () => {
      mockGetByIdData = {
        ...defaultMockData,
        diffName: "diff-of-the-run",
        screenshots: [{ id: "c1", imageKey: "img-1", diffImageKey: null }],
      };
      mockCheckpoints = {
        items: [{ id: "c1", name: "Home", state: "unresolved" }],
      };
      await withFetch(async (fetchMock) => {
        render(
          <DiffViewer
            runId="00000000-0000-0000-0000-000000000000"
            projectId="p1"
            initialCheckpointId="c1"
          />,
        );
        await vi.waitFor(() =>
          expect(requestedKeys(fetchMock)).toContain("diff-of-the-run"),
        );
        expect(
          document
            .getElementById("diff-viewer-canvas")
            ?.hasAttribute("data-diff-image-legacy-missing"),
        ).toBe(false);
      });
    });
  });

  describe("what the canvas can't show", () => {
    afterEach(() => vi.unstubAllGlobals());

    /** Every storage read answers 404: each image the step asks for fails. */
    function failingStorage() {
      vi.stubGlobal(
        "fetch",
        vi.fn(() =>
          Promise.resolve({ ok: false, status: 404 } as unknown as Response),
        ),
      );
    }
    /**
     * Every storage read answers with an image that decodes to 100×100, so
     * both screenshots are in, at the same size.
     */
    function loadingStorage() {
      vi.stubGlobal(
        "fetch",
        vi.fn(() =>
          Promise.resolve({
            ok: true,
            status: 200,
            blob: () => Promise.resolve(new Blob(["png"])),
          } as unknown as Response),
        ),
      );
      vi.stubGlobal(
        "createImageBitmap",
        vi.fn(() =>
          Promise.resolve({ width: 100, height: 100, close: () => {} }),
        ),
      );
    }
    // Keys no other test uses: the image loader's cache is module-wide.
    let keyCount = 0;
    const fresh = (name: string) => `cs${++keyCount}-${name}`;
    const inDiff = () =>
      useViewerPrefs.setState((s) => ({ prefs: { ...s.prefs, mode: "diff" } }));
    const region = (screenshotId: string, source = "l1_pixel") => ({
      id: `r-${screenshotId}-${source}`,
      severity: "major",
      category: "visual",
      bbox: { x: 1, y: 1, width: 5, height: 5 },
      description: "A change",
      source,
      screenshotId,
    });
    /** A run of two steps, diffed before steps kept their own images. */
    function legacyRun(regions: unknown[]) {
      mockGetByIdData = {
        ...defaultMockData,
        diffName: "diff-of-step-1",
        baselineScreenshot: { id: "base", imageKey: fresh("base") },
        screenshots: [
          { id: "c1", imageKey: fresh("img-1"), diffImageKey: null },
          { id: "c2", imageKey: fresh("img-2"), diffImageKey: null },
        ],
        diffRegions: regions,
      };
      mockCheckpoints = {
        items: [
          { id: "c1", name: "Home", state: "unresolved" },
          { id: "c2", name: "Search", state: "unresolved" },
        ],
      };
    }
    const openStep = (checkpointId: string) =>
      render(
        <DiffViewer
          runId="00000000-0000-0000-0000-000000000000"
          projectId="p1"
          initialCheckpointId={checkpointId}
        />,
      );

    test("no baseline: every mode but side by side is unavailable, and the panes say why", () => {
      const r = render(
        <DiffViewer runId="00000000-0000-0000-0000-000000000000" diffId="d1" />,
      );
      for (const name of [/^swipe$/i, /^flicker$/i, /^overlay$/i, /^diff$/i]) {
        const radio = r.getByRole("radio", { name });
        expect(radio.getAttribute("aria-disabled")).toBe("true");
        expect(radio.getAttribute("title")).toBe("Needs a baseline");
      }
      expect(
        r
          .getByRole("radio", { name: /side by side/i })
          .hasAttribute("aria-disabled"),
      ).toBe(false);
      expect(r.getByText("No baseline")).toBeDefined();
      expect(
        r.getByText(
          "No baseline yet. Approve this step to make it the baseline.",
        ),
      ).toBeDefined();
    });

    test("Diff on a legacy step with a region: no diff image was kept for it (R4)", async () => {
      failingStorage();
      inDiff();
      legacyRun([region("c2")]);
      const r = openStep("c2");
      expect(
        await r.findByText("No diff image was kept for this step."),
      ).toBeDefined();
      expect(r.queryByText(/No pixel changes/)).toBeNull();
    });

    test("Diff on a legacy step with no diff: no pixel changes (R4)", async () => {
      loadingStorage();
      inDiff();
      // Step 1's region is not step 2's.
      legacyRun([region("c1")]);
      const r = openStep("c2");
      expect(
        await r.findByText(
          "No pixel changes between the baseline and the current screenshot.",
        ),
      ).toBeDefined();
      expect(r.queryByText(/No diff image was kept/)).toBeNull();
    });

    test.each(["dynamic_text", "axe"])(
      "Diff on a step of a multi-step run with only %s rows: no pixel changes, not a lost image (I1)",
      async (source) => {
        loadingStorage();
        inDiff();
        legacyRun([region("c2", source)]);
        const r = openStep("c2");
        expect(
          await r.findByText(
            "No pixel changes between the baseline and the current screenshot.",
          ),
        ).toBeDefined();
        expect(r.queryByText(/No diff image was kept/)).toBeNull();
      },
    );

    test("Diff on a one-step run with only audit rows and no diff image: no pixel changes (I1)", async () => {
      loadingStorage();
      inDiff();
      mockGetByIdData = {
        ...defaultMockData,
        diffName: null,
        baselineScreenshot: { id: "base", imageKey: fresh("base") },
        screenshots: [
          { id: "c1", imageKey: fresh("img-1"), diffImageKey: null },
        ],
        diffRegions: [region("c1", "dynamic_text"), region("c1", "axe")],
      };
      mockCheckpoints = {
        items: [{ id: "c1", name: "Home", state: "unresolved" }],
      };
      const r = openStep("c1");
      expect(
        await r.findByText(
          "No pixel changes between the baseline and the current screenshot.",
        ),
      ).toBeDefined();
    });

    test.each([
      { diffPercent: 2.5, says: null },
      {
        diffPercent: 0,
        says: "No pixel changes between the baseline and the current screenshot.",
      },
    ])(
      "Diff on a one-step run with no diff image and a diff percent of $diffPercent (R4)",
      async ({ diffPercent, says }) => {
        loadingStorage();
        inDiff();
        mockGetByIdData = {
          ...defaultMockData,
          diffName: null,
          diffPercent,
          baselineScreenshot: { id: "base", imageKey: fresh("base") },
          screenshots: [
            { id: "c1", imageKey: fresh("img-1"), diffImageKey: null },
          ],
        };
        mockCheckpoints = {
          items: [{ id: "c1", name: "Home", state: "unresolved" }],
        };
        const r = openStep("c1");
        // Both screenshots are in.
        await vi.waitFor(() =>
          expect(
            r.getByTestId("single-stage-host").hasAttribute("aria-busy"),
          ).toBe(false),
        );
        await act(async () => {});
        if (says) {
          expect(r.getByText(says)).toBeDefined();
        } else {
          expect(r.queryByText(/No pixel changes/)).toBeNull();
          expect(r.queryByText(/No diff image was kept/)).toBeNull();
        }
      },
    );

    test("the stage root names the step it opened on once its images are drawn (data-stage-drawn)", async () => {
      loadingStorage();
      legacyRun([]);
      const r = openStep("c2");
      const canvas = r.container.querySelector("#diff-viewer-canvas")!;
      await vi.waitFor(() =>
        expect(
          canvas
            .querySelector("[data-stage-drawn]")
            ?.getAttribute("data-stage-drawn"),
        ).toBe("c2"),
      );
    });
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

  test("the step's details sit in the resizable rail, and t collapses it to the strip", () => {
    const r = render(<DiffViewer runId="r1" diffId="d1" />);
    const rail = r.getByTestId("test-info-sidebar");
    expect(
      within(rail).getByRole("separator", { name: "Resize details" }),
    ).toBeDefined();
    expect(rail.style.width).toBe("320px");
    expect(within(rail).getByTestId("info-stat-cards")).toBeDefined();
    press("t");
    expect(r.getByTestId("test-info-sidebar").style.width).toBe("40px");
    expect(r.getByRole("button", { name: "Show details" })).toBeDefined();
    expect(r.queryByTestId("info-stat-cards")).toBeNull();
  });

  test("editing ignore regions, the rail holds their list: one rail, no second column, and the details come back on leaving (spec §5)", () => {
    const r = render(<DiffViewer runId="r1" diffId="d1" />);
    press("i");
    expect(useViewerStore.getState().ignoreEditMode).not.toBe("off");
    const landmarks = r.getAllByRole("complementary");
    expect(landmarks).toHaveLength(1);
    const rail = landmarks[0]!;
    expect(rail.style.width).toBe("320px");
    expect(
      within(rail).getByRole("heading", { name: "Ignore regions" }),
    ).toBeDefined();
    // The list is the rail's content, not a column of its own.
    expect(r.getByTestId("ignore-region-list-panel").closest("aside")).toBe(
      rail,
    );
    expect(r.queryByTestId("info-stat-cards")).toBeNull();
    // Its rows are the viewport's drafts, and delete as they did.
    const viewport = useViewerStore.getState().viewport;
    act(() =>
      useViewerStore.setState({
        draftIgnoreAreas: [
          {
            id: "d1",
            x: 1,
            y: 1,
            width: 10,
            height: 10,
            viewport,
            paddingPx: 0,
            kind: "ignore",
          },
        ],
      }),
    );
    expect(within(rail).getAllByTestId("ignore-region-item")).toHaveLength(1);
    fireEvent.click(within(rail).getByTestId("ignore-region-delete"));
    expect(useViewerStore.getState().draftIgnoreAreas).toEqual([]);

    press("Escape");
    expect(useViewerStore.getState().ignoreEditMode).toBe("off");
    expect(r.getAllByRole("complementary")).toHaveLength(1);
    expect(r.queryByTestId("ignore-region-list-panel")).toBeNull();
    expect(within(rail).getByTestId("info-stat-cards")).toBeDefined();
  });

  test("in the editor a collapsed rail is one button, Ignore regions (N), counting the list's own regions (the viewport on screen)", () => {
    useViewerPrefs.setState({
      prefs: { ...DEFAULT_VIEWER_PREFS, railCollapsed: true },
    });
    const region = (id: string, viewport: string) => ({
      id,
      x: 1,
      y: 1,
      width: 10,
      height: 10,
      viewport,
      paddingPx: 0,
      kind: "ignore" as const,
    });
    useViewerStore.setState({ viewport: "1280x720", draftIgnoreAreas: [] });
    const r = render(<DiffViewer runId="r1" diffId="d1" />);
    press("i");
    act(() =>
      useViewerStore.setState({
        draftIgnoreAreas: [region("d1", "1280x720"), region("d2", "375x812")],
      }),
    );
    const open = r.getByRole("button", { name: "Ignore regions (1)" });
    fireEvent.click(open);
    expect(
      within(
        r.getByRole("complementary", { name: "Ignore regions" }),
      ).getAllByTestId("ignore-region-item"),
    ).toHaveLength(1);
    act(() =>
      useViewerStore.setState({
        viewport: "",
        draftIgnoreAreas: [],
        ignoreEditMode: "off",
      }),
    );
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

  test("highlight-toggle button toggles the highlight preference", () => {
    const r = render(
      <DiffViewer runId="00000000-0000-0000-0000-000000000000" diffId="d1" />,
    );
    expect(useViewerPrefs.getState().prefs.highlight).toBe(false);

    // First click: activates highlight
    fireEvent.click(r.getByTestId("highlight-toggle"));
    expect(useViewerPrefs.getState().prefs.highlight).toBe(true);

    // Second click: deactivates highlight
    fireEvent.click(r.getByTestId("highlight-toggle"));
    expect(useViewerPrefs.getState().prefs.highlight).toBe(false);
  });

  test("toggling highlight does NOT re-initialize the Pixi canvas (new Application + init must not re-run)", async () => {
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
    expect(useViewerPrefs.getState().prefs.hideDisplacement).toBe(true);

    // Layout region filtered: counter drops to "Diff 0 / 1"
    expect(r.getByTestId("diff-counter").textContent).toContain("0 / 1");

    // Toggle hide-displacement off
    fireEvent.click(r.getByTestId("hide-displacement-toggle"));
    expect(useViewerPrefs.getState().prefs.hideDisplacement).toBe(false);

    // Layout region restored: counter back to "Diff 0 / 2"
    expect(r.getByTestId("diff-counter").textContent).toContain("0 / 2");
  });
});

// Regression: the A/R hotkeys used to call their own whole-run approve /
// reject mutations — approving the WHOLE run, skipping the review-legal status
// gate, dropping unsaved ignore regions, and firing while the reviewer typed
// into a field. They must now go through the exact action the ApprovalBar
// buttons use.
const RUN_ID = "00000000-0000-0000-0000-000000000000";

interface StepFixture {
  id: string;
  name: string;
  state: string | null;
  decision?: unknown;
  newerCapture?: unknown;
  browser?: string;
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

/** Where the Undone toast's Go to takes the reviewer back to cp-1. */
const CP1 = {
  href: `/projects/test-project-id/runs/${RUN_ID}/checkpoints/cp-1`,
  name: "CP-1",
};

function resetReviewSpies() {
  reviewSpies.decide.mockReset();
  reviewSpies.undo.mockReset();
  reviewSpies.isInFlight.mockReset();
  reviewSpies.isInFlight.mockReturnValue(false);
  routerSpies.push.mockReset();
  routerSpies.replace.mockReset();
  resetLoop();
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
      goTo: CP1,
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
      goTo: CP1,
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
  const NEWER = {
    runId: "run-newer",
    checkpointId: "cp-9",
    buildId: "build-2",
    buildName: "#42",
  };
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

  test("shows the callout, linking to the newer capture's own step, in the same filters", () => {
    mockGetByIdData = { ...defaultMockData, projectId: "proj-1" };
    const r = render(
      <DiffViewer
        runId={RUN_ID}
        diffId="d1"
        initialCheckpointId="cp-1"
        reviewContext={{ status: "failed", facets: { browser: "chromium" } }}
      />,
    );
    const callout = r.getByTestId("stale-step-callout");
    expect(callout.getAttribute("role")).toBe("status");
    expect(callout.textContent).toContain(
      "A newer capture of this step exists in build #42. Approving here makes this older image the baseline.",
    );
    const link = r.getByRole("link", { name: "Open the newer capture" });
    expect(link.getAttribute("href")).toBe(
      "/projects/proj-1/runs/run-newer/checkpoints/cp-9?status=failed&browser=chromium",
    );
  });

  test("the newer capture's link keeps the comparison mode (spec §6.3)", () => {
    mockGetByIdData = { ...defaultMockData, projectId: "proj-1" };
    const r = render(
      <DiffViewer
        runId={RUN_ID}
        diffId="d1"
        initialCheckpointId="cp-1"
        reviewContext={{ status: "failed", facets: {} }}
        view="flicker"
      />,
    );
    expect(
      r
        .getByRole("link", { name: "Open the newer capture" })
        .getAttribute("href"),
    ).toBe(
      "/projects/proj-1/runs/run-newer/checkpoints/cp-9?status=failed&view=flicker",
    );
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

// The review loop drives the viewer (spec §5.4): decisions, J / K and the
// header's Next pending all move on the answer of `review.next`, and every
// link keeps the review context.
describe("DiffViewer: the review loop", () => {
  const PROJECT = "proj-1";
  const BUILD = "build-1";
  const OTHER_RUN = "run-2";

  type Answer = {
    target: { buildId: string; runId: string; checkpointId: string } | null;
    scope: "run" | "batch" | "nextBatch" | "none";
    remaining: {
      run: number;
      batch: number;
      batchUnfiltered: number;
      projectBatches: number;
    };
    nextBatch: {
      buildId: string;
      name: string;
      number: number | null;
      branch: string | null;
      pending: number;
    } | null;
  };
  const answer = (over: Partial<Answer> = {}): Answer => ({
    target: { buildId: BUILD, runId: RUN_ID, checkpointId: "c3" },
    scope: "run",
    remaining: { run: 1, batch: 3, batchUnfiltered: 3, projectBatches: 2 },
    nextBatch: null,
    ...over,
  });
  /** An answer whose next step is in another test of the batch. */
  const intoOtherRun = (batch = 4) =>
    answer({
      target: { buildId: BUILD, runId: OTHER_RUN, checkpointId: "s9" },
      scope: "batch",
      remaining: { run: 0, batch, batchUnfiltered: batch, projectBatches: 2 },
    });
  const stepUrl = (runId: string, id: string, query = "") =>
    `/projects/${PROJECT}/runs/${runId}/checkpoints/${id}${query}`;

  /** The viewer on its step's route, as the checkpoint page renders it. */
  function renderViewer(
    props: Partial<ComponentProps<typeof DiffViewer>> = {},
  ) {
    navState.pathname = stepUrl(
      props.runId ?? RUN_ID,
      props.initialCheckpointId ?? "c1",
    );
    return render(
      <DiffViewer
        runId={RUN_ID}
        projectId={PROJECT}
        initialCheckpointId="c1"
        {...props}
      />,
    );
  }

  const pressAsync = (key: string, init: KeyboardEventInit = {}) =>
    act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true, ...init }),
      );
    });

  beforeEach(() => {
    mockGetByIdData = {
      ...defaultMockData,
      projectId: PROJECT,
      buildId: BUILD,
    };
    // In-run order would take c1 to c2, the next pending step of this run.
    mockCheckpoints = {
      items: [
        stepFixture("c1", "unresolved"),
        stepFixture("c2", "unresolved"),
        stepFixture("c3", "new"),
      ],
    };
    resetReviewSpies();
    useUndoStore.setState({ stack: [] });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    useUndoStore.setState({ stack: [] });
  });

  test("a decision runs loop.afterDecision (not nextPendingCheckpointId)", () => {
    // The loop says c3, where the in-run walk would have said c2.
    nextQuery.data = answer();
    renderViewer();
    press("A");
    expect(reviewSpies.decide).toHaveBeenCalledOnce();
    expect(routerSpies.replace).toHaveBeenCalledTimes(1);
    expect(routerSpies.replace).toHaveBeenCalledWith(stepUrl(RUN_ID, "c3"));
    cleanup();

    // Rejecting moves too, here into the next test of the batch.
    resetReviewSpies();
    nextQuery.data = intoOtherRun();
    renderViewer();
    press("R");
    expect(reviewSpies.decide).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "rejected", checkpointIds: ["c1"] }),
    );
    expect(routerSpies.push).toHaveBeenCalledTimes(1);
    expect(routerSpies.push).toHaveBeenCalledWith(stepUrl(OTHER_RUN, "s9"));
    expect(routerSpies.replace).not.toHaveBeenCalled();
  });

  test("Mark as Bug does not advance (R35)", () => {
    nextQuery.data = answer();
    const r = renderViewer();
    fireEvent.click(r.getByTestId("mark-as-bug-button"));
    expect(reviewSpies.decide).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "rejected", checkpointIds: ["c1"] }),
    );
    expect(routerSpies.replace).not.toHaveBeenCalled();
    expect(routerSpies.push).not.toHaveBeenCalled();
  });

  test("a step whose diff failed is pending for the loop: no done card, and J moves on from it", () => {
    mockCheckpoints = {
      items: [
        {
          ...stepFixture("c1", "unresolved"),
          diffFailedAt: "2026-10-24T08:00:00.000Z",
          diffError: "engine_error",
        },
        stepFixture("c2", "unresolved"),
      ],
    };
    nextQuery.data = intoOtherRun();
    const r = renderViewer();
    // The step needs a reviewer (once it is retried): the loop stops on it.
    expect(r.queryByTestId("batch-done-card")).toBeNull();
    expect(r.getByTestId("stage-diff-failed")).toBeDefined();
    press("J");
    expect(routerSpies.push).toHaveBeenCalledOnce();
    expect(routerSpies.push).toHaveBeenCalledWith(stepUrl(OTHER_RUN, "s9"));
  });

  test("R25: Mark as Bug in the editor puts its note in this run's draft and says so; another run's comment box stays empty", () => {
    vi.mocked(toast.info).mockClear();
    useViewerStore.setState({ commentDrafts: {} });
    const r = renderViewer();
    press("i");
    fireEvent.click(r.getByTestId("mark-as-bug-button"));
    expect(reviewSpies.decide).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "rejected", checkpointIds: ["c1"] }),
    );
    expect(useViewerStore.getState().commentDrafts).toEqual({
      [RUN_ID]: "Marked 'C1' as a bug: ",
    });
    // The rail holds the editor's regions: where the note went is said.
    expect(toast.info).toHaveBeenCalledWith("Note added to Comments");
    cleanup();

    // A step of another run, the editor still open; then out of it, on
    // Comments (the tab the note made the one that comes back).
    const other = renderViewer({ runId: OTHER_RUN, initialCheckpointId: "s9" });
    press("Escape");
    expect(useViewerStore.getState().ignoreEditMode).toBe("off");
    const box = other.getByTestId("comment-textarea") as HTMLTextAreaElement;
    expect(box.value).toBe("");
    expect(useViewerStore.getState().commentDrafts).toEqual({
      [RUN_ID]: "Marked 'C1' as a bug: ",
    });
    cleanup();

    // Back on the first run, the note is in its box.
    const first = renderViewer();
    expect(
      (first.getByTestId("comment-textarea") as HTMLTextAreaElement).value,
    ).toBe("Marked 'C1' as a bug: ");
  });

  test("Mark as Bug out of the editor opens the note in the rail, with nothing more to say", () => {
    vi.mocked(toast.info).mockClear();
    useViewerStore.setState({ commentDrafts: {} });
    const r = renderViewer();
    fireEvent.click(r.getByTestId("mark-as-bug-button"));
    expect(
      (r.getByTestId("comment-textarea") as HTMLTextAreaElement).value,
    ).toBe("Marked 'C1' as a bug: ");
    expect(toast.info).not.toHaveBeenCalled();
  });

  test("a decision with no answer yet waits for it, then moves once", () => {
    nextQuery.isLoading = true;
    nextQuery.isFetching = true;
    const r = renderViewer();
    press("A");
    expect(routerSpies.replace).not.toHaveBeenCalled();
    nextQuery.isLoading = false;
    nextQuery.isFetching = false;
    nextQuery.data = answer();
    r.rerender(
      <DiffViewer
        runId={RUN_ID}
        projectId={PROJECT}
        initialCheckpointId="c1"
      />,
    );
    expect(routerSpies.replace).toHaveBeenCalledTimes(1);
    expect(routerSpies.replace).toHaveBeenCalledWith(stepUrl(RUN_ID, "c3"));
  });

  test("J / K call the loop and never fire while typing or in a dialog; repeat ignored", async () => {
    nextQuery.data = intoOtherRun();
    utilsMock.review.next.fetch.mockResolvedValue(
      answer({ target: { buildId: BUILD, runId: RUN_ID, checkpointId: "c0" } }),
    );
    renderViewer();

    // Typing in a field.
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    await pressAsync("J");
    await pressAsync("K");
    input.remove();
    // Focus inside a dialog.
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.innerHTML = "<button>Cancel</button>";
    document.body.appendChild(dialog);
    dialog.querySelector("button")!.focus();
    await pressAsync("J");
    await pressAsync("K");
    dialog.remove();
    // Auto-repeat.
    await pressAsync("J", { repeat: true });
    await pressAsync("K", { repeat: true });
    expect(routerSpies.push).not.toHaveBeenCalled();
    expect(routerSpies.replace).not.toHaveBeenCalled();
    expect(utilsMock.review.next.fetch).not.toHaveBeenCalled();

    // K asks for the previous pending step of this one, and goes there.
    await pressAsync("K");
    expect(utilsMock.review.next.fetch).toHaveBeenCalledWith({
      projectId: PROJECT,
      at: { buildId: BUILD, runId: RUN_ID, checkpointId: "c1" },
      direction: "prev",
      facets: {},
    });
    expect(routerSpies.replace).toHaveBeenCalledWith(stepUrl(RUN_ID, "c0"));
    cleanup();

    // J goes to the next one (a fresh page, as after the route commits).
    renderViewer();
    await pressAsync("j");
    expect(routerSpies.push).toHaveBeenCalledTimes(1);
    expect(routerSpies.push).toHaveBeenCalledWith(stepUrl(OTHER_RUN, "s9"));
  });

  test("header shows N left in batch · M in filter and Next pending", () => {
    // The step on screen (c1) needs review, inside the filter: `remaining`
    // leaves it out, the pill counts it in both (R33).
    mockCheckpoints = {
      items: [
        stepFixture("c1", "unresolved", { browser: "chromium" }),
        stepFixture("c2", "unresolved", { browser: "chromium" }),
      ],
    };
    nextQuery.data = answer({
      remaining: { run: 1, batch: 3, batchUnfiltered: 8, projectBatches: 2 },
    });
    const r = renderViewer({
      reviewContext: {
        status: "needs-review",
        facets: { browser: "chromium" },
      },
    });
    expect(r.getByTestId("header-loop-remaining").textContent).toBe(
      "9 left in batch · 4 in filter",
    );
    const next = r.getByTestId("header-next-pending");
    expect(next.getAttribute("aria-label")).toBe("Next pending step");
    fireEvent.click(next);
    expect(routerSpies.replace).toHaveBeenCalledWith(
      stepUrl(RUN_ID, "c3", "?browser=chromium"),
    );
  });

  test("without facets the pill is N left in batch", () => {
    nextQuery.data = answer({
      remaining: { run: 1, batch: 3, batchUnfiltered: 3, projectBatches: 2 },
    });
    const r = renderViewer({ reviewContext: { status: "failed", facets: {} } });
    // c1 still needs review: the 3 others and itself (R33).
    expect(r.getByTestId("header-loop-remaining").textContent).toBe(
      "4 left in batch",
    );
  });

  test("the pill counts the step on screen only while it needs review, and in the filter only inside it", () => {
    nextQuery.data = answer({
      remaining: { run: 1, batch: 3, batchUnfiltered: 8, projectBatches: 2 },
    });
    // Settled: what `remaining` says.
    mockCheckpoints = { items: [stepFixture("c1", "passed")] };
    const settled = renderViewer({
      reviewContext: { status: "all", facets: { browser: "chromium" } },
    });
    expect(settled.getByTestId("header-loop-remaining").textContent).toBe(
      "8 left in batch · 3 in filter",
    );
    cleanup();
    // Pending, outside the filter: in the batch's count, not the filter's.
    mockCheckpoints = {
      items: [stepFixture("c1", "unresolved", { browser: "firefox" })],
    };
    const outside = renderViewer({
      reviewContext: { status: "all", facets: { browser: "chromium" } },
    });
    expect(outside.getByTestId("header-loop-remaining").textContent).toBe(
      "9 left in batch · 3 in filter",
    );
  });

  test("no pill before the loop has answered; Next pending is there already", () => {
    nextQuery.isLoading = true;
    const r = renderViewer();
    expect(r.queryByTestId("header-loop-remaining")).toBeNull();
    expect(r.getByTestId("header-next-pending")).toBeDefined();
  });

  test("Back to batch keeps the context and anchors the run", () => {
    const r = renderViewer({
      reviewContext: { status: "failed", facets: { viewport: "1280x720" } },
    });
    expect(r.getByTestId("contextual-header-back").getAttribute("href")).toBe(
      `/projects/${PROJECT}/builds/${BUILD}?status=failed&viewport=1280x720#run-${RUN_ID}`,
    );
  });

  test("hint bar lists J / K", () => {
    const r = renderViewer();
    const hint = r.getByTestId("shortcut-hint-loop");
    const keys = [...hint.querySelectorAll("kbd")];
    expect(keys.map((k) => k.textContent)).toEqual(["J", "K"]);
    expect(hint.textContent).toContain("next/prev pending");
    // The same key caps as the others in the bar.
    const approveKey = [
      ...r.getByTestId("diff-viewer-shortcut-hints").querySelectorAll("kbd"),
    ].find((k) => k.textContent === "A");
    expect(keys[0]!.className).toBe(approveKey!.className);
  });

  test("already_decided after an advance: one rollback toast, loop refetches, no second navigation", async () => {
    // The real review hook, over a server that says a teammate decided first.
    realReview.on = true;
    server.approve.mockRejectedValue({
      message: "already_decided",
      data: {
        code: "CONFLICT",
        details: {
          winner: { kind: "approved", actorName: "Ana", checkpointId: "c1" },
        },
      },
    });
    // The caches the review hook patches, as loaded: the step list (it names
    // the step in the toast) and the run.
    utilsMock.runs.listCheckpoints.getData.mockReturnValue(mockCheckpoints);
    utilsMock.runs.getById.getData.mockReturnValue({
      ...mockGetByIdData,
      name: "Checkout",
      statusOverride: null,
      checkpointContexts: {},
    });
    nextQuery.data = answer();
    const qc = new QueryClient();
    const wrap = (ui: ReactNode) => (
      <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
    );
    // A new element each time: the same one would let React skip the render.
    const viewer = () => (
      <DiffViewer runId={RUN_ID} projectId={PROJECT} initialCheckpointId="c1" />
    );
    const r = render(wrap(viewer()));

    // The decision moves on at once...
    await pressAsync("A");
    expect(server.approve).toHaveBeenCalledOnce();
    expect(routerSpies.replace).toHaveBeenCalledTimes(1);
    expect(routerSpies.replace).toHaveBeenCalledWith(stepUrl(RUN_ID, "c3"));
    // ...and the refusal comes back: one toast naming the step.
    expect(toast.error).toHaveBeenCalledOnce();
    expect(toast.error).toHaveBeenCalledWith("Ana already approved C1");
    expect(toast.success).not.toHaveBeenCalled();
    // The loop's answer is refetched.
    expect(utilsMock.review.next.invalidate).toHaveBeenCalledOnce();

    // The refetch lands, with another answer: nothing moves again.
    nextQuery.isFetching = true;
    const calls = nextQuery.calls.length;
    r.rerender(wrap(viewer()));
    nextQuery.isFetching = false;
    nextQuery.data = intoOtherRun();
    r.rerender(wrap(viewer()));
    // The viewer did render the new answer.
    expect(nextQuery.calls.length).toBeGreaterThan(calls);
    await act(async () => {});
    expect(routerSpies.replace).toHaveBeenCalledTimes(1);
    expect(routerSpies.push).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledOnce();
  });

  test("⌘Z on the step the loop moved to: the Undone toast's Go to opens the step undone, in the same filters", async () => {
    realReview.on = true;
    useUndoStore.setState({ stack: [] });
    server.approve.mockResolvedValue({
      actionId: "echo",
      decided: [{ checkpointId: "c1", runId: RUN_ID, state: "approved" }],
      runs: [{ runId: RUN_ID, status: "unresolved" }],
      replayed: false,
      capped: false,
      cap: 500,
    });
    server.revert.mockResolvedValue({
      actionId: "echo",
      reverted: 1,
      skipped: [],
      runs: [],
    });
    utilsMock.runs.listCheckpoints.getData.mockReturnValue(mockCheckpoints);
    utilsMock.runs.getById.getData.mockReturnValue({
      ...mockGetByIdData,
      name: "Checkout",
      statusOverride: null,
      checkpointContexts: {},
    });
    nextQuery.data = answer();
    const ctx = {
      status: "failed" as const,
      facets: { os: "macOS" },
    };
    const QUERY = "?status=failed&os=macOS";
    const qc = new QueryClient();
    const viewer = (step: string) => (
      <QueryClientProvider client={qc}>
        <DiffViewer
          runId={RUN_ID}
          projectId={PROJECT}
          initialCheckpointId={step}
          reviewContext={ctx}
        />
      </QueryClientProvider>
    );
    navState.pathname = stepUrl(RUN_ID, "c1");
    render(viewer("c1"));
    await pressAsync("A");
    expect(routerSpies.replace).toHaveBeenCalledWith(
      stepUrl(RUN_ID, "c3", QUERY),
    );

    // The move lands: the reviewer is on c3, and takes the decision back.
    cleanup();
    navState.pathname = stepUrl(RUN_ID, "c3");
    render(viewer("c3"));
    vi.mocked(toast.success).mockClear();
    await pressAsync("z", { ctrlKey: true });
    expect(server.revert).toHaveBeenCalledOnce();
    expect(toast.success).toHaveBeenCalledOnce();
    const [text, options] = vi.mocked(toast.success).mock.calls[0]!;
    expect(text).toBe("Undone");
    const action = (
      options as { action?: { label: string; onClick: () => void } }
    ).action;
    expect(action?.label).toBe("Go to 'C1'");
    expect(routerSpies.push).not.toHaveBeenCalled();
    action!.onClick();
    expect(routerSpies.push).toHaveBeenCalledOnce();
    expect(routerSpies.push).toHaveBeenCalledWith(stepUrl(RUN_ID, "c1", QUERY));
  });

  test("run not found: loop affordances hidden, review.next not called", async () => {
    mockGetByIdError = {
      message: "Run not found",
      data: { code: "NOT_FOUND" },
    };
    // Even with an answer in the cache; and both for a link to a run that is
    // gone, and for a run deleted while it was open (its refetch fails and
    // the query keeps the data it had).
    nextQuery.data = answer();
    for (const keepsData of [false, true]) {
      mockGetByIdKeepsData = keepsData;
      nextQuery.calls = [];
      const r = renderViewer();
      expect(r.getByText("Error: Run not found")).toBeDefined();
      expect(r.queryByTestId("header-next-pending")).toBeNull();
      expect(r.queryByTestId("header-loop-remaining")).toBeNull();
      expect(nextQuery.calls.length).toBeGreaterThan(0);
      expect(nextQuery.calls.every((c) => c.options.enabled === false)).toBe(
        true,
      );
      await pressAsync("J");
      await pressAsync("K");
      expect(utilsMock.review.next.fetch).not.toHaveBeenCalled();
      expect(routerSpies.push).not.toHaveBeenCalled();
      expect(routerSpies.replace).not.toHaveBeenCalled();
      cleanup();
    }
  });

  test("read-only viewer still navigates", async () => {
    const readOnly: Array<Partial<MockData>> = [
      // Overridden by hand.
      { status: "failed", statusOverride: "failed" },
      // Not reviewable yet.
      { status: "running" },
    ];
    for (const over of readOnly) {
      resetReviewSpies();
      mockGetByIdData = {
        ...defaultMockData,
        projectId: PROJECT,
        buildId: BUILD,
        ...over,
      };
      nextQuery.data = intoOtherRun();
      const r = renderViewer();
      // Deciding is off...
      press("A");
      expect(reviewSpies.decide).not.toHaveBeenCalled();
      // ...moving is not: the button,
      fireEvent.click(r.getByTestId("header-next-pending"));
      expect(routerSpies.push).toHaveBeenCalledWith(stepUrl(OTHER_RUN, "s9"));
      cleanup();
      // and J on a fresh page.
      renderViewer();
      await pressAsync("J");
      expect(routerSpies.push).toHaveBeenCalledTimes(2);
      cleanup();
    }
  });

  test("the loop is fed the step on screen once _first has resolved", () => {
    renderViewer({ initialCheckpointId: "_first" });
    const asked = nextQuery.calls.filter((c) => c.options.enabled);
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.at(-1)!.input).toEqual({
      projectId: PROJECT,
      at: { buildId: BUILD, runId: RUN_ID, checkpointId: "c1" },
      facets: {},
    });
    expect(JSON.stringify(nextQuery.calls.map((c) => c.input))).not.toContain(
      "_first",
    );
    // And it follows the steps the reviewer opens.
    press("ArrowRight");
    expect(nextQuery.calls.at(-1)!.input).toEqual(
      expect.objectContaining({
        at: { buildId: BUILD, runId: RUN_ID, checkpointId: "c2" },
      }),
    );
  });

  test("_first resolves without losing the review context", () => {
    renderViewer({
      initialCheckpointId: "_first",
      reviewContext: { status: "failed", facets: { os: "macOS" } },
    });
    expect(routerSpies.replace).toHaveBeenCalledWith(
      stepUrl(RUN_ID, "c1", "?status=failed&os=macOS"),
    );
  });

  test("← / → keep the review context", () => {
    renderViewer({
      reviewContext: { status: "failed", facets: { os: "macOS" } },
    });
    press("ArrowRight");
    expect(routerSpies.replace).toHaveBeenLastCalledWith(
      stepUrl(RUN_ID, "c2", "?status=failed&os=macOS"),
    );
  });

  test("J, K, ← / →, the step buttons and _first carry the URL's comparison mode (spec §6.3)", async () => {
    nextQuery.data = intoOtherRun();
    utilsMock.review.next.fetch.mockResolvedValue(
      answer({ target: { buildId: BUILD, runId: RUN_ID, checkpointId: "c0" } }),
    );
    renderViewer({ view: "overlay" });
    press("J");
    expect(routerSpies.push).toHaveBeenLastCalledWith(
      stepUrl(OTHER_RUN, "s9", "?view=overlay"),
    );
    cleanup();

    renderViewer({ view: "overlay" });
    await pressAsync("K");
    expect(routerSpies.replace).toHaveBeenLastCalledWith(
      stepUrl(RUN_ID, "c0", "?view=overlay"),
    );
    cleanup();

    const context = { status: "failed" as const, facets: { os: "macOS" } };
    const r = renderViewer({ view: "overlay", reviewContext: context });
    press("ArrowRight");
    expect(routerSpies.replace).toHaveBeenLastCalledWith(
      stepUrl(RUN_ID, "c2", "?status=failed&os=macOS&view=overlay"),
    );
    fireEvent.click(r.getByTestId("diff-viewer-step-prev"));
    expect(routerSpies.replace).toHaveBeenLastCalledWith(
      stepUrl(RUN_ID, "c1", "?status=failed&os=macOS&view=overlay"),
    );
    cleanup();

    renderViewer({ initialCheckpointId: "_first", view: "overlay" });
    expect(routerSpies.replace).toHaveBeenLastCalledWith(
      stepUrl(RUN_ID, "c1", "?view=overlay"),
    );
  });

  describe("R20: a mode change while the loop's move is on its way", () => {
    beforeEach(() => {
      // A step with a baseline, so every mode is available; its images are
      // never answered.
      vi.stubGlobal(
        "fetch",
        vi.fn(() => new Promise<Response>(() => {})),
      );
      mockGetByIdData = {
        ...mockGetByIdData,
        baselineScreenshot: { id: "base", imageKey: "r20-base" },
      };
    });
    afterEach(() => vi.unstubAllGlobals());
    /** No navigation of the step on screen, c1, nor write of its URL. */
    const neverToC1 = () =>
      [
        ...routerSpies.replace.mock.calls,
        ...routerSpies.push.mock.calls,
        ...historyWrite.mock.calls.map(([, , url]) => [url]),
      ].every(([href]) => !String(href).startsWith(stepUrl(RUN_ID, "c1")));
    const stageMode = () =>
      document
        .querySelector("[data-testid=single-stage-host]")
        ?.getAttribute("data-mode");

    test("J, then d before the next test commits: the move goes again in Diff, a push, and this step's URL is never written", () => {
      nextQuery.data = intoOtherRun();
      renderViewer({ view: "overlay" });
      press("J");
      press("d");
      expect(routerSpies.push.mock.calls).toEqual([
        [stepUrl(OTHER_RUN, "s9", "?view=overlay")],
        [stepUrl(OTHER_RUN, "s9", "?view=diff")],
      ]);
      expect(routerSpies.replace).not.toHaveBeenCalled();
      expect(neverToC1()).toBe(true);
      // The step being left shows Diff meanwhile.
      expect(stageMode()).toBe("diff");
      // J again is the same move: nothing more.
      press("J");
      expect(routerSpies.push).toHaveBeenCalledTimes(2);
      cleanup();

      // The next test's route commits: its viewer opens in Diff, and J and K
      // move on from it.
      utilsMock.review.next.fetch.mockResolvedValue(
        answer({
          target: { buildId: BUILD, runId: RUN_ID, checkpointId: "c0" },
        }),
      );
      nextQuery.data = answer();
      renderViewer({ view: "diff" });
      expect(stageMode()).toBe("diff");
      press("J");
      expect(routerSpies.replace).toHaveBeenLastCalledWith(
        stepUrl(RUN_ID, "c3", "?view=diff"),
      );
    });

    test("a decision's move, then o: the replace goes again in the new mode, never to this step", () => {
      nextQuery.data = answer();
      renderViewer({ view: "overlay" });
      press("A");
      press("o");
      expect(routerSpies.replace.mock.calls).toEqual([
        [stepUrl(RUN_ID, "c3", "?view=overlay")],
        [stepUrl(RUN_ID, "c3", "?view=diff")],
      ]);
      expect(routerSpies.push).not.toHaveBeenCalled();
      expect(neverToC1()).toBe(true);
    });

    test("with no move on its way, a mode change writes this step's URL, to the history: no navigation (R31)", () => {
      renderViewer({ view: "overlay" });
      press("d");
      expect(historyWrite).toHaveBeenCalledOnce();
      expect(historyWrite).toHaveBeenCalledWith(
        null,
        "",
        stepUrl(RUN_ID, "c1", "?view=diff"),
      );
      expect(routerSpies.replace).not.toHaveBeenCalled();
      expect(routerSpies.push).not.toHaveBeenCalled();
    });

    describe("R22: a mode change while one of the viewer's links is on its way", () => {
      test("the header's Back to batch, then 2: the link goes on as it is, and this step's URL is never written", () => {
        const r = renderViewer({ view: "overlay" });
        const back = r.getByTestId("contextual-header-back");
        const href = back.getAttribute("href")!;
        fireEvent.click(back);
        // Next's own navigation, not committed yet.
        expect(routerSpies.push.mock.calls).toEqual([[href]]);
        press("2");
        expect(stageMode()).toBe("swipe");
        expect(routerSpies.push.mock.calls).toEqual([[href]]);
        expect(routerSpies.replace).not.toHaveBeenCalled();
        expect(neverToC1()).toBe(true);
      });

      test("the newer capture's link, then 2: it goes again with view=swipe, a push, and never to this step", () => {
        mockCheckpoints = {
          items: [
            stepFixture("c1", "unresolved", {
              newerCapture: {
                runId: "run-newer",
                checkpointId: "cp-9",
                buildId: "build-2",
                buildName: "#42",
              },
            }),
            stepFixture("c2", "unresolved"),
          ],
        };
        const r = renderViewer({ view: "overlay" });
        fireEvent.click(r.getByTestId("stale-step-link"));
        const newer = stepUrl("run-newer", "cp-9");
        expect(routerSpies.push.mock.calls).toEqual([
          [`${newer}?view=overlay`],
        ]);
        press("2");
        expect(routerSpies.push.mock.calls).toEqual([
          [`${newer}?view=overlay`],
          [`${newer}?view=swipe`],
        ]);
        expect(routerSpies.replace).not.toHaveBeenCalled();
        expect(neverToC1()).toBe(true);
        expect(stageMode()).toBe("swipe");
      });

      test("a link opened in a new tab is not on its way here: a mode change writes this step's URL", () => {
        const r = renderViewer({ view: "overlay" });
        // The browser's new tab, which jsdom can't open: kept from it.
        const browser = (e: MouseEvent) => e.preventDefault();
        window.addEventListener("click", browser);
        fireEvent.click(r.getByTestId("contextual-header-back"), {
          ctrlKey: true,
        });
        window.removeEventListener("click", browser);
        expect(routerSpies.push).not.toHaveBeenCalled();
        press("2");
        expect(historyWrite).toHaveBeenCalledWith(
          null,
          "",
          stepUrl(RUN_ID, "c1", "?view=swipe"),
        );
        expect(routerSpies.replace).not.toHaveBeenCalled();
      });
    });
  });

  test("with no view in the URL, the links carry none: the next step opens in the preference", () => {
    nextQuery.data = intoOtherRun();
    useViewerPrefs.setState((s) => ({ prefs: { ...s.prefs, mode: "diff" } }));
    renderViewer();
    press("J");
    expect(routerSpies.push).toHaveBeenLastCalledWith(stepUrl(OTHER_RUN, "s9"));
  });

  test("the cue chip shows on the test the loop moved to, for about 3 s", async () => {
    vi.useFakeTimers();
    nextQuery.data = intoOtherRun(4);
    renderViewer();
    await pressAsync("J");
    expect(routerSpies.push).toHaveBeenCalledWith(stepUrl(OTHER_RUN, "s9"));
    // The move's own page goes; the route takes its time to commit.
    cleanup();
    await act(async () => {});
    act(() => vi.advanceTimersByTime(2_000));

    // The viewer of the test the move opened: the 3 s start when it shows.
    const r = renderViewer({ runId: OTHER_RUN, initialCheckpointId: "s9" });
    const chip = r.getByTestId("header-loop-cue");
    // The 4 the answer names past c1, and c1, which J left pending (R33).
    expect(chip.textContent).toBe("Next test: Checkout · 5 left in batch");
    expect(chip.getAttribute("aria-hidden")).toBe("true");
    act(() => vi.advanceTimersByTime(2_999));
    expect(r.queryByTestId("header-loop-cue")).not.toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(r.queryByTestId("header-loop-cue")).toBeNull();
  });

  describe("on arrival the cue and the pill show the same count", () => {
    /** A batch: each pending step, with its run and browser. */
    type Pending = { id: string; runId: string; browser: string };
    /**
     * `review.next`'s counts from `at`, as the server takes them: every
     * pending step of the batch except `at`, and those inside the facets.
     */
    const remainingFrom = (
      pending: Pending[],
      at: string,
      browser?: string,
    ) => {
      const others = pending.filter((p) => p.id !== at);
      const inFilter = others.filter(
        (p) => browser === undefined || p.browser === browser,
      );
      const atRun = pending.find((p) => p.id === at)?.runId ?? RUN_ID;
      return {
        run: inFilter.filter((p) => p.runId === atRun).length,
        batch: inFilter.length,
        batchUnfiltered: others.length,
        projectBatches: 1,
      };
    };
    const stepsOf = (pending: Pending[], runId: string) => ({
      items: pending
        .filter((p) => p.runId === runId)
        .map((p) => stepFixture(p.id, "unresolved", { browser: p.browser })),
    });

    /**
     * From c1 (in RUN_ID) to s9 (in OTHER_RUN) by `move`, then the viewer of
     * s9: the cue it shows and its pill.
     */
    async function arrive(
      pending: Pending[],
      move: "J" | "A",
      browser?: string,
    ) {
      const reviewContext = {
        status: "needs-review" as const,
        facets: browser ? { browser } : {},
      };
      mockCheckpoints = stepsOf(pending, RUN_ID);
      nextQuery.data = answer({
        target: { buildId: BUILD, runId: OTHER_RUN, checkpointId: "s9" },
        scope: "batch",
        remaining: remainingFrom(pending, "c1", browser),
      });
      renderViewer({ reviewContext });
      await pressAsync(move);
      expect(routerSpies.push).toHaveBeenCalledWith(
        stepUrl(OTHER_RUN, "s9", browser ? `?browser=${browser}` : ""),
      );
      cleanup();
      await act(async () => {});

      // What is pending on arrival: a decision settled c1, J left it.
      const after =
        move === "A" ? pending.filter((p) => p.id !== "c1") : pending;
      mockCheckpoints = stepsOf(after, OTHER_RUN);
      nextQuery.data = answer({
        target: null,
        scope: "batch",
        remaining: remainingFrom(after, "s9", browser),
      });
      const r = renderViewer({
        runId: OTHER_RUN,
        initialCheckpointId: "s9",
        reviewContext,
      });
      return {
        cue: r.getByTestId("header-loop-cue").textContent,
        pill: r.getByTestId("header-loop-remaining").textContent,
      };
    }

    const batch: Pending[] = [
      { id: "c1", runId: RUN_ID, browser: "chromium" },
      { id: "c2", runId: RUN_ID, browser: "firefox" },
      { id: "s9", runId: OTHER_RUN, browser: "chromium" },
      { id: "s10", runId: OTHER_RUN, browser: "firefox" },
      { id: "x1", runId: "run-3", browser: "chromium" },
    ];

    test.each(["J", "A"] as const)("without facets (%s)", async (move) => {
      const { cue, pill } = await arrive(batch, move);
      expect(cue).toBe(`Next test: Checkout · ${pill}`);
      expect(pill).toBe(move === "J" ? "5 left in batch" : "4 left in batch");
    });

    test.each(["J", "A"] as const)("with facets (%s)", async (move) => {
      const { cue, pill } = await arrive(batch, move, "chromium");
      expect(cue).toBe(`Next test: Checkout · ${pill}`);
      expect(pill).toBe(
        move === "J"
          ? "5 left in batch · 3 in filter"
          : "4 left in batch · 2 in filter",
      );
    });
  });

  test("a decision while review.next is fetching shows Next as busy, then moves exactly once", () => {
    // A cached answer being refetched (a decision invalidated it).
    nextQuery.data = answer();
    nextQuery.isFetching = true;
    // A new element each time: the same one would let React skip the render.
    const viewer = () => (
      <DiffViewer runId={RUN_ID} projectId={PROJECT} initialCheckpointId="c1" />
    );
    const r = render(viewer());
    const next = () => r.getByTestId("header-next-pending");
    expect(next().getAttribute("aria-busy")).not.toBe("true");
    press("A");
    expect(reviewSpies.decide).toHaveBeenCalledOnce();
    expect(routerSpies.replace).not.toHaveBeenCalled();
    expect(next().getAttribute("aria-busy")).toBe("true");
    // Pressing it again meanwhile is harmless.
    expect((next() as HTMLButtonElement).disabled).toBe(false);

    // The fresh answer arrives.
    nextQuery.isFetching = false;
    nextQuery.data = answer({
      target: { buildId: BUILD, runId: RUN_ID, checkpointId: "c2" },
    });
    r.rerender(viewer());
    expect(next().getAttribute("aria-busy")).not.toBe("true");
    expect(routerSpies.replace).toHaveBeenCalledTimes(1);
    expect(routerSpies.replace).toHaveBeenCalledWith(stepUrl(RUN_ID, "c2"));
    r.rerender(viewer());
    expect(routerSpies.replace).toHaveBeenCalledTimes(1);
    expect(routerSpies.push).not.toHaveBeenCalled();
  });

  test("the empty run's View build link keeps the context and anchors the run", () => {
    mockGetByIdData = {
      ...defaultMockData,
      projectId: PROJECT,
      buildId: BUILD,
      status: "empty",
    };
    const r = renderViewer({
      reviewContext: { status: "failed", facets: { os: "macOS" } },
    });
    expect(r.getByTestId("empty-run-card-timeline").getAttribute("href")).toBe(
      `/projects/${PROJECT}/builds/${BUILD}?status=failed&os=macOS#run-${RUN_ID}`,
    );
  });

  test("a run with no batch offers no Next pending, and J / K do nothing", async () => {
    mockGetByIdData = { ...defaultMockData, projectId: PROJECT, buildId: "" };
    nextQuery.data = answer();
    utilsMock.review.next.fetch.mockResolvedValue(answer());
    const r = renderViewer();
    expect(
      (r.getByTestId("header-next-pending") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(r.queryByTestId("shortcut-hint-loop")).toBeNull();
    expect(nextQuery.calls.every((c) => c.options.enabled === false)).toBe(
      true,
    );
    await pressAsync("J");
    await pressAsync("K");
    expect(routerSpies.replace).not.toHaveBeenCalled();
    expect(routerSpies.push).not.toHaveBeenCalled();
    expect(utilsMock.review.next.fetch).not.toHaveBeenCalled();
  });

  // ---- The done cards (spec §5.4) ----

  /** This batch is done inside the filters; `left` steps are outside them. */
  const intoNextBatch = (left = 0) =>
    answer({
      target: { buildId: "build-2", runId: "run-9", checkpointId: "s1" },
      scope: "nextBatch",
      remaining: {
        run: 0,
        batch: 0,
        batchUnfiltered: left,
        projectBatches: 2,
      },
      nextBatch: {
        buildId: "build-2",
        name: "Nightly",
        number: 43,
        branch: "main",
        pending: 5,
      },
    });
  const CONTINUE = "Continue to build #43 · main · 5 pending";
  const decision = {
    id: "d",
    actionId: "a",
    kind: "approved",
    actor: null,
    at: new Date().toISOString(),
    source: "viewer",
    legacy: false,
    undo: { allowed: true, reason: null },
  };
  /** A step with a decision on it (as the optimistic update leaves it). */
  const decided = (id: string) => stepFixture(id, "approved", { decision });
  const card = (r: ReturnType<typeof render>) =>
    r.queryByTestId("batch-done-card");
  const canvas = () => document.getElementById("diff-viewer-canvas");

  /**
   * The viewer on c1, the last step of the batch that needs review, and a
   * way to render it again after the caches change (a new element each time:
   * the same one would let React skip the render).
   */
  function lastPendingStep(
    props: Partial<ComponentProps<typeof DiffViewer>> = {},
  ) {
    mockCheckpoints = {
      items: [stepFixture("c1", "unresolved"), decided("c2"), decided("c3")],
    };
    const viewer = () => (
      <DiffViewer
        runId={RUN_ID}
        projectId={PROJECT}
        initialCheckpointId="c1"
        {...props}
      />
    );
    const r = render(viewer());
    return { r, again: () => r.rerender(viewer()) };
  }
  /** The decision on c1 lands: the step reads as decided. */
  function c1Decided(again: () => void) {
    mockCheckpoints = {
      items: [decided("c1"), decided("c2"), decided("c3")],
    };
    again();
  }

  test("the last decision of the batch brings the card in place of the canvas, focused on Continue", () => {
    nextQuery.data = intoNextBatch();
    const { r, again } = lastPendingStep({
      reviewContext: { status: "needs-review", facets: { os: "macOS" } },
    });
    press("A");
    expect(reviewSpies.decide).toHaveBeenCalledOnce();
    // Until the decision's own update lands the step reads as pending, and
    // the canvas stays.
    expect(card(r)).toBeNull();
    c1Decided(again);

    const dialog = r.getByRole("dialog", { name: "Batch done" });
    expect(card(r)).toBe(dialog);
    // In the canvas's place: no canvas, no toolbar, no key hints.
    expect(canvas()).toBeNull();
    expect(r.queryByTestId("diff-viewer-shortcut-hints")).toBeNull();
    expect(document.getElementById("diff-viewer-toolbar")).toBeNull();
    // The header stays.
    expect(r.getByTestId("contextual-header")).toBeDefined();
    const next = r.getByRole("button", { name: CONTINUE });
    expect(document.activeElement).toBe(next);
    expect(useReviewAnnouncer.getState().text).toBe(`Batch done. ${CONTINUE}.`);
    // The card's Back to batch goes where the header's does.
    expect(
      within(dialog)
        .getByRole("link", { name: "Back to batch" })
        .getAttribute("href"),
    ).toBe(`/projects/${PROJECT}/builds/${BUILD}?os=macOS#run-${RUN_ID}`);

    // Continue: the next batch's first pending step, the facets kept. The
    // card stays up, busy, until the route commits (R24).
    fireEvent.click(next);
    expect(routerSpies.push).toHaveBeenCalledOnce();
    expect(routerSpies.push).toHaveBeenCalledWith(
      stepUrl("run-9", "s1", "?os=macOS"),
    );
    expect(card(r)).not.toBeNull();
    expect(next.getAttribute("aria-busy")).toBe("true");
    fireEvent.click(next);
    expect(routerSpies.push).toHaveBeenCalledOnce();
  });

  test("the done card's Continue carries the comparison mode (spec §6.3)", () => {
    nextQuery.data = intoNextBatch();
    const { r, again } = lastPendingStep({
      reviewContext: { status: "needs-review", facets: { os: "macOS" } },
      view: "swipe",
    });
    press("A");
    c1Decided(again);
    fireEvent.click(r.getByRole("button", { name: CONTINUE }));
    expect(routerSpies.push).toHaveBeenCalledOnce();
    expect(routerSpies.push).toHaveBeenCalledWith(
      stepUrl("run-9", "s1", "?os=macOS&view=swipe"),
    );
  });

  test("undo of the last decision brings the canvas back", () => {
    nextQuery.data = intoNextBatch();
    const { r, again } = lastPendingStep();
    press("A");
    c1Decided(again);
    expect(card(r)).not.toBeNull();
    expect(document.activeElement).toBe(
      r.getByRole("button", { name: CONTINUE }),
    );

    // ⌘Z, with focus on the card: it reaches the viewer's undo (the decision
    // is on the stack once the server has answered).
    act(() => {
      useUndoStore.getState().push({
        actionId: "a1",
        label: "Approved 'CP-1'",
        runIds: [RUN_ID],
      });
    });
    act(() => {
      document.activeElement!.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "z",
          ctrlKey: true,
          bubbles: true,
        }),
      );
    });
    expect(reviewSpies.undo).toHaveBeenCalledOnce();
    // The undo puts the step back: pending again, so the canvas is back.
    mockCheckpoints = {
      items: [stepFixture("c1", "unresolved"), decided("c2"), decided("c3")],
    };
    again();
    expect(card(r)).toBeNull();
    expect(canvas()).not.toBeNull();

    // A new decision brings the card back, and says so again.
    const said = useReviewAnnouncer.getState().seq;
    press("A");
    expect(reviewSpies.decide).toHaveBeenCalledTimes(2);
    c1Decided(again);
    expect(card(r)).not.toBeNull();
    expect(useReviewAnnouncer.getState().seq).toBe(said + 1);
    expect(canvas()).toBeNull();
  });

  test("A and J do nothing while the card is up; Esc goes back to the batch", () => {
    // A step the diff passed (R would reject it) at the batch boundary.
    mockCheckpoints = {
      items: [stepFixture("c1", "passed"), decided("c2"), decided("c3")],
    };
    nextQuery.data = intoNextBatch();
    const viewer = () => (
      <DiffViewer runId={RUN_ID} projectId={PROJECT} initialCheckpointId="c1" />
    );
    const r = render(viewer());
    press("J");
    expect(card(r)).not.toBeNull();
    const before = useViewerPrefs.getState().prefs.mode;

    // Focus is on the card: the review keys, the moves and the viewer's own
    // keys all yield to it.
    for (const key of ["A", "R", "X", "J", "K", "ArrowRight", "D"]) press(key);
    expect(reviewSpies.decide).not.toHaveBeenCalled();
    expect(utilsMock.review.next.fetch).not.toHaveBeenCalled();
    expect(routerSpies.replace).not.toHaveBeenCalled();
    expect(routerSpies.push).not.toHaveBeenCalled();
    expect(useViewerPrefs.getState().prefs.mode).toBe(before);

    // A step needing review turns up in the batch (a teammate's undo), and
    // focus has left the card: J still waits while the card is up.
    nextQuery.data = intoOtherRun();
    r.rerender(viewer());
    act(() => (document.activeElement as HTMLElement | null)?.blur());
    press("J");
    press("R");
    // Nor does → move to the next step of the run.
    press("ArrowRight");
    expect(routerSpies.push).not.toHaveBeenCalled();
    expect(routerSpies.replace).not.toHaveBeenCalled();
    expect(reviewSpies.decide).not.toHaveBeenCalled();

    // Esc, from the card: back to the batch, anchored on this run.
    const dialog = r.getByRole("dialog");
    act(() => dialog.focus());
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(routerSpies.push).toHaveBeenCalledOnce();
    expect(routerSpies.push).toHaveBeenCalledWith(
      `/projects/${PROJECT}/builds/${BUILD}#run-${RUN_ID}`,
    );
  });

  test("Esc after a click on the card's surround goes back to the batch", async () => {
    nextQuery.data = intoNextBatch();
    const { r, again } = lastPendingStep({
      reviewContext: { status: "failed", facets: {} },
    });
    press("A");
    c1Decided(again);
    // A click beside the card: focus leaves it for the page.
    const user = userEvent.setup();
    await user.click(r.getByTestId("batch-done-card-area"));
    expect(card(r)!.contains(document.activeElement)).toBe(false);
    await user.keyboard("{Escape}");
    expect(routerSpies.push).toHaveBeenCalledOnce();
    expect(routerSpies.push).toHaveBeenCalledWith(
      `/projects/${PROJECT}/builds/${BUILD}?status=failed#run-${RUN_ID}`,
    );
  });

  test("Continue is offered only while the answer leads into the next batch", () => {
    mockCheckpoints = { items: [decided("c1"), decided("c2"), decided("c3")] };
    nextQuery.data = intoNextBatch();
    const viewer = () => (
      <DiffViewer runId={RUN_ID} projectId={PROJECT} initialCheckpointId="c1" />
    );
    const r = render(viewer());
    press("J");
    expect(r.getByRole("button", { name: CONTINUE })).toBeDefined();
    // The refetched answer has a step in this batch again; it still names
    // the next batch, but Continue would not go there.
    nextQuery.data = {
      ...intoOtherRun(),
      nextBatch: intoNextBatch().nextBatch,
    };
    r.rerender(viewer());
    expect(card(r)).not.toBeNull();
    expect(r.queryByRole("button", { name: /Continue/ })).toBeNull();
  });

  test("J at the batch boundary shows the card", () => {
    // The reviewer went back to a step already decided; nothing in the batch
    // needs review any more.
    mockCheckpoints = { items: [decided("c1"), decided("c2"), decided("c3")] };
    nextQuery.data = intoNextBatch();
    const r = renderViewer();
    expect(card(r)).toBeNull();
    press("J");
    expect(r.getByRole("dialog", { name: "Batch done" })).toBeDefined();
    // It never leaves the batch on its own.
    expect(routerSpies.push).not.toHaveBeenCalled();
    expect(routerSpies.replace).not.toHaveBeenCalled();
  });

  test("J at the boundary on a read-only step shows the card", () => {
    // Overridden by hand: its steps take no decisions, but the loop walks on.
    mockGetByIdData = {
      ...defaultMockData,
      projectId: PROJECT,
      buildId: BUILD,
      status: "failed",
      statusOverride: "failed",
    };
    nextQuery.data = intoNextBatch();
    // c1 still reads unresolved, but nothing here waits for a reviewer.
    const r = renderViewer();
    press("J");
    expect(useReviewAnnouncer.getState().text).toBe(`Batch done. ${CONTINUE}.`);
    fireEvent.click(r.getByRole("button", { name: CONTINUE }));
    expect(routerSpies.push).toHaveBeenCalledOnce();
    expect(routerSpies.push).toHaveBeenCalledWith(stepUrl("run-9", "s1"));
  });

  const LAST = "Last step to review in this batch.";

  test("J at the boundary on a pending step announces the last step and shows no card", () => {
    vi.useFakeTimers();
    nextQuery.data = intoNextBatch();
    const { r } = lastPendingStep();
    press("J");
    // The card would cover the one step still to review.
    expect(card(r)).toBeNull();
    expect(canvas()).not.toBeNull();
    expect(useReviewAnnouncer.getState().text).toBe(LAST);
    // Seen as well, beside the pill, for about 3 s.
    expect(r.getByTestId("header-loop-cue").textContent).toBe(LAST);
    act(() => vi.advanceTimersByTime(3_000));
    expect(r.queryByTestId("header-loop-cue")).toBeNull();
    expect(routerSpies.push).not.toHaveBeenCalled();
    expect(routerSpies.replace).not.toHaveBeenCalled();
    // Next pending (the header's) does the same.
    fireEvent.click(r.getByTestId("header-next-pending"));
    expect(card(r)).toBeNull();
    expect(r.getByTestId("header-loop-cue").textContent).toBe(LAST);
  });

  test("K at the boundary behaves like J", async () => {
    // Nothing before this step in the batch: K's answer is the next batch.
    utilsMock.review.next.fetch.mockResolvedValue(intoNextBatch());
    nextQuery.data = intoNextBatch();
    const { r } = lastPendingStep();
    await pressAsync("K");
    expect(card(r)).toBeNull();
    expect(useReviewAnnouncer.getState().text).toBe(LAST);
    cleanup();

    // On a settled step, the card.
    mockCheckpoints = { items: [decided("c1"), decided("c2"), decided("c3")] };
    const settled = renderViewer();
    await pressAsync("K");
    settled.getByRole("dialog", { name: "Batch done" });
    expect(routerSpies.push).not.toHaveBeenCalled();
    expect(routerSpies.replace).not.toHaveBeenCalled();
  });

  test("J on the last pending step, then Mark as Bug: no card", () => {
    nextQuery.data = intoNextBatch();
    const { r, again } = lastPendingStep();
    press("J");
    fireEvent.click(r.getByTestId("mark-as-bug-button"));
    expect(reviewSpies.decide).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "rejected", checkpointIds: ["c1"] }),
    );
    mockCheckpoints = {
      items: [
        stepFixture("c1", "rejected", {
          decision: { ...decision, kind: "rejected" },
        }),
        decided("c2"),
        decided("c3"),
      ],
    };
    again();
    // Mark as Bug stays to write the note (R35): no card over it.
    expect(card(r)).toBeNull();
    expect(canvas()).not.toBeNull();
  });

  /** The card is up from a decision, then ⌘Z puts the step back. */
  function cardThenUndo() {
    nextQuery.data = intoNextBatch();
    const view = lastPendingStep();
    press("A");
    c1Decided(view.again);
    expect(card(view.r)).not.toBeNull();
    act(() => {
      document.activeElement!.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "z",
          ctrlKey: true,
          bubbles: true,
        }),
      );
    });
    mockCheckpoints = {
      items: [stepFixture("c1", "unresolved"), decided("c2"), decided("c3")],
    };
    view.again();
    expect(card(view.r)).toBeNull();
    return view;
  }

  test("undo, then Mark as Bug: no card", () => {
    const { r, again } = cardThenUndo();
    fireEvent.click(r.getByTestId("mark-as-bug-button"));
    expect(reviewSpies.decide).toHaveBeenCalledTimes(2);
    mockCheckpoints = {
      items: [
        stepFixture("c1", "rejected", {
          decision: { ...decision, kind: "rejected" },
        }),
        decided("c2"),
        decided("c3"),
      ],
    };
    again();
    expect(card(r)).toBeNull();
    expect(canvas()).not.toBeNull();
  });

  test("Approve pending / an override with a dismissed card: no card", () => {
    const { r, again } = cardThenUndo();
    // The run is overridden by hand: the step is settled, by no decision.
    mockGetByIdData = { ...mockGetByIdData, statusOverride: "failed" };
    again();
    expect(card(r)).toBeNull();
    // Approve pending decides it, and calls no loop.
    mockGetByIdData = { ...mockGetByIdData, statusOverride: null };
    c1Decided(again);
    expect(card(r)).toBeNull();
    expect(canvas()).not.toBeNull();
  });

  test("a decision waiting for its answer shows no card until the answer comes", () => {
    // The answer is being refetched when the decision lands: it waits.
    nextQuery.data = intoNextBatch();
    nextQuery.isFetching = true;
    const { r, again } = lastPendingStep();
    press("A");
    c1Decided(again);
    const next = () => r.getByTestId("header-next-pending");
    expect(next().getAttribute("aria-busy")).toBe("true");
    expect(card(r)).toBeNull();
    // The answer comes: now the card.
    nextQuery.isFetching = false;
    again();
    expect(next().getAttribute("aria-busy")).not.toBe("true");
    expect(card(r)).not.toBeNull();

    // While the card is up, Next pending is inert (R28), as J is: pressed
    // while the answer is refetched, it neither waits nor takes the card
    // down.
    nextQuery.isFetching = true;
    again();
    expect(next()).toHaveProperty("disabled", true);
    fireEvent.click(next());
    expect(next().getAttribute("aria-busy")).not.toBe("true");
    expect(card(r)).not.toBeNull();
    nextQuery.isFetching = false;
    again();
    expect(card(r)).not.toBeNull();
    expect(routerSpies.push).not.toHaveBeenCalled();
    expect(routerSpies.replace).not.toHaveBeenCalled();
  });

  test("a decision refused while waiting stays on the step", () => {
    // The answer is being refetched when the decision is made: it waits.
    nextQuery.isFetching = true;
    nextQuery.data = answer(); // c3, in this run
    const steps = (c1: StepFixture) => ({
      items: [c1, stepFixture("c2", "unresolved"), stepFixture("c3", "new")],
    });
    const viewer = () => (
      <DiffViewer runId={RUN_ID} projectId={PROJECT} initialCheckpointId="c1" />
    );
    const r = render(viewer());
    const next = () => r.getByTestId("header-next-pending");
    press("A");
    expect(reviewSpies.decide).toHaveBeenCalledOnce();
    expect(next().getAttribute("aria-busy")).toBe("true");
    // The decision shows at once...
    mockCheckpoints = steps(decided("c1"));
    r.rerender(viewer());
    // ...and the server refuses it: the rollback puts c1 back as needing
    // review, and the move it was waiting for is called off (R30).
    mockCheckpoints = steps(stepFixture("c1", "unresolved"));
    r.rerender(viewer());
    expect(next().getAttribute("aria-busy")).not.toBe("true");
    // The answer comes: the reviewer stays on c1.
    nextQuery.isFetching = false;
    r.rerender(viewer());
    expect(routerSpies.replace).not.toHaveBeenCalled();
    expect(routerSpies.push).not.toHaveBeenCalled();
    expect(canvas()).not.toBeNull();
    expect(card(r)).toBeNull();
  });

  test("a decision before the step change's route commits keeps its card (R37)", () => {
    nextQuery.data = intoNextBatch();
    mockCheckpoints = {
      items: [decided("c1"), stepFixture("c2", "unresolved"), decided("c3")],
    };
    const viewer = (step: string) => (
      <DiffViewer
        runId={RUN_ID}
        projectId={PROJECT}
        initialCheckpointId={step}
      />
    );
    const r = render(viewer("c1"));
    // →: the viewer shows c2 at once, and asks the router for its URL.
    fireEvent.click(r.getByTestId("contextual-header-next"));
    expect(routerSpies.replace).toHaveBeenCalledWith(stepUrl(RUN_ID, "c2"));
    // A, before the route commits: the last pending step of the batch.
    press("A");
    expect(reviewSpies.decide).toHaveBeenCalledOnce();
    expect(reviewSpies.decide.mock.calls[0]![0]).toMatchObject({
      checkpointIds: ["c2"],
    });
    mockCheckpoints = {
      items: [decided("c1"), decided("c2"), decided("c3")],
    };
    r.rerender(viewer("c1"));
    expect(card(r)).not.toBeNull();
    // The route commits: Next mounts a new viewer on c2, and the card is
    // still there.
    cleanup();
    const committed = render(viewer("c2"));
    expect(card(committed)).not.toBeNull();
    expect(committed.getByRole("button", { name: CONTINUE })).toBeDefined();
  });

  test("a stale read during the decision keeps its card; the undo's own hold does not (R36)", async () => {
    // The real review hook and its in-flight store, over a server that
    // answers when the test says.
    realReview.on = true;
    useUndoStore.setState({ stack: [] });
    useInFlightStore.setState({ ids: new Set(), decisions: new Set() });
    let approveAnswers: (result: unknown) => void = () => undefined;
    server.approve.mockReturnValue(
      new Promise((resolve) => {
        approveAnswers = resolve;
      }),
    );
    let revertAnswers: (result: unknown) => void = () => undefined;
    server.revert.mockReturnValue(
      new Promise((resolve) => {
        revertAnswers = resolve;
      }),
    );
    // The caches the review hook reads are the ones the viewer shows.
    utilsMock.runs.listCheckpoints.getData.mockImplementation(
      () => mockCheckpoints,
    );
    utilsMock.runs.getById.getData.mockReturnValue({
      ...mockGetByIdData,
      name: "Checkout",
      statusOverride: null,
      checkpointContexts: {},
    });
    nextQuery.data = intoNextBatch();
    const pendingC1 = () => stepFixture("c1", "unresolved");
    const decidedC1 = (actionId: string) =>
      stepFixture("c1", "approved", { decision: { ...decision, actionId } });
    mockCheckpoints = { items: [pendingC1(), decided("c2"), decided("c3")] };
    const qc = new QueryClient();
    const viewer = () => (
      <QueryClientProvider client={qc}>
        <DiffViewer
          runId={RUN_ID}
          projectId={PROJECT}
          initialCheckpointId="c1"
        />
      </QueryClientProvider>
    );
    const r = render(viewer());
    /** c1 as the viewer reads it, rendered again. */
    const c1Is = (c1: StepFixture) => {
      mockCheckpoints = { items: [c1, decided("c2"), decided("c3")] };
      r.rerender(viewer());
    };

    // A: the last pending step of the batch is approved.
    await pressAsync("A");
    expect(server.approve).toHaveBeenCalledOnce();
    const { actionId } = server.approve.mock.calls[0]![0] as {
      actionId: string;
    };
    c1Is(decidedC1(actionId)); // its optimistic update
    expect(card(r)).not.toBeNull();
    // A read from before the commit shows c1 pending: the card hides...
    c1Is(pendingC1());
    expect(card(r)).toBeNull();
    // ...and is back once c1 reads settled again.
    c1Is(decidedC1(actionId));
    expect(card(r)).not.toBeNull();
    // The server commits: the card stays.
    await act(async () => {
      approveAnswers({
        actionId,
        decided: [{ checkpointId: "c1", runId: RUN_ID, state: "approved" }],
        runs: [{ runId: RUN_ID, status: "passed" }],
        replayed: false,
        capped: false,
        cap: 500,
      });
    });
    expect(useInFlightStore.getState().ids.size).toBe(0);
    expect(card(r)).not.toBeNull();

    // ⌘Z: the undo holds c1 in flight too, but it is no decision. Its own
    // update puts c1 back as pending, and the card goes, for good (R30).
    await pressAsync("z", { ctrlKey: true });
    expect(server.revert).toHaveBeenCalledOnce();
    expect(useInFlightStore.getState().ids.has("c1")).toBe(true);
    c1Is(pendingC1());
    expect(card(r)).toBeNull();
    await act(async () => {
      revertAnswers({ actionId, reverted: 1, skipped: [], runs: [] });
    });
    // Settled again by something that is not a decision here: no card.
    c1Is(decidedC1("another-action"));
    expect(card(r)).toBeNull();
    expect(canvas()).not.toBeNull();
  });

  test("the filtered card's Clear filter drops the facets; a card that changes is said again", async () => {
    nextQuery.data = intoNextBatch(4);
    const { r, again } = lastPendingStep({
      reviewContext: { status: "failed", facets: { browser: "chromium" } },
    });
    press("A");
    c1Decided(again);
    r.getByRole("dialog", { name: "Done with the filtered steps" });
    // Clear filter: the next pending step of the batch, outside the filter.
    utilsMock.review.next.fetch.mockResolvedValue(intoOtherRun());
    await act(async () => {
      fireEvent.click(
        r.getByRole("button", { name: "Clear filter (4 more in this batch)" }),
      );
    });
    expect(utilsMock.review.next.fetch).toHaveBeenCalledWith({
      projectId: PROJECT,
      at: { buildId: BUILD, runId: RUN_ID, checkpointId: "c1" },
    });
    expect(routerSpies.push).toHaveBeenCalledWith(
      stepUrl(OTHER_RUN, "s9", "?status=failed"),
    );
    cleanup();

    // Pressed when a teammate has taken the last of them: the batch is done,
    // and the new card is said and focused.
    resetReviewSpies();
    nextQuery.data = intoNextBatch(4);
    const second = lastPendingStep({
      reviewContext: { status: "failed", facets: { browser: "chromium" } },
    });
    press("A");
    c1Decided(second.again);
    utilsMock.review.next.fetch.mockResolvedValue(intoNextBatch(0));
    await act(async () => {
      fireEvent.click(
        second.r.getByRole("button", {
          name: "Clear filter (4 more in this batch)",
        }),
      );
    });
    second.r.getByRole("dialog", { name: "Batch done" });
    expect(useReviewAnnouncer.getState().text).toBe(`Batch done. ${CONTINUE}.`);
    expect(document.activeElement).toBe(
      second.r.getByRole("button", { name: CONTINUE }),
    );
    // No Clear filter on it, whatever the count it had.
    expect(second.r.queryByRole("button", { name: /Clear filter/ })).toBeNull();
    expect(routerSpies.push).not.toHaveBeenCalled();
  });

  test("All caught up: Back to batches keeps the status", () => {
    nextQuery.data = answer({
      target: null,
      scope: "none",
      remaining: { run: 0, batch: 0, batchUnfiltered: 0, projectBatches: 0 },
    });
    // No facets: with them, only the batch is known to be done (R25).
    const { r, again } = lastPendingStep({
      reviewContext: { status: "failed", facets: {} },
    });
    press("A");
    c1Decided(again);
    r.getByRole("dialog", { name: "All caught up" });
    const batches = r.getByRole("link", { name: "Back to batches" });
    expect(batches.getAttribute("href")).toBe("/inbox?status=failed");
    expect(document.activeElement).toBe(batches);
    expect(r.queryByRole("button", { name: /Continue/ })).toBeNull();
  });

  test("a failed lookup says so beside the pill, with Retry", () => {
    nextQuery.isError = true;
    nextQuery.error = { message: "Something went wrong" };
    nextQuery.data = answer();
    const r = renderViewer();
    expect(r.getByTestId("header-loop-error").textContent).toBe(
      "Couldn't load the next step.",
    );
    // What it knew before the failure is not shown as the count.
    expect(r.queryByTestId("header-loop-remaining")).toBeNull();
    fireEvent.click(r.getByTestId("header-loop-retry"));
    expect(nextQuery.refetch).toHaveBeenCalledOnce();
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

  test("the hint bar shows ⌘Z undo only while there is an action to undo", () => {
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
    // jsdom is not a Mac: $mod is Ctrl (a Mac's ⌘Z is checked below).
    expect(hint.querySelector("kbd")?.textContent).toBe("Ctrl+Z");
    expect(hint.textContent).toContain("undo");

    act(() => {
      useUndoStore.getState().drop("a1");
    });
    expect(r.queryByTestId("shortcut-hint-undo")).toBeNull();
    cleanup();

    // On a Mac it reads ⌘Z.
    const mac = vi.spyOn(navigator, "platform", "get");
    mac.mockReturnValue("MacIntel");
    try {
      act(() => {
        useUndoStore.getState().push({
          actionId: "a2",
          label: "Approved 'CP-1'",
          runIds: [RUN_ID],
        });
      });
      const onMac = render(
        <DiffViewer runId={RUN_ID} diffId="d1" initialCheckpointId="cp-1" />,
      );
      expect(
        onMac.getByTestId("shortcut-hint-undo").querySelector("kbd")
          ?.textContent,
      ).toBe("⌘Z");
    } finally {
      mac.mockRestore();
    }
  });

  test("⌘Z undoes through the review hook, with no action id (the newest)", () => {
    act(() => {
      useUndoStore
        .getState()
        .push({ actionId: "a1", label: "Approved 'CP-1'", runIds: [RUN_ID] });
    });
    render(
      <DiffViewer runId={RUN_ID} diffId="d1" initialCheckpointId="cp-1" />,
    );
    pressCtrlZ();
    expect(reviewSpies.undo).toHaveBeenCalledOnce();
    expect(reviewSpies.undo.mock.calls[0]).toEqual([]);
  });

  test("⌘Z while typing in a text field does not undo", () => {
    act(() => {
      useUndoStore
        .getState()
        .push({ actionId: "a1", label: "Approved 'CP-1'", runIds: [RUN_ID] });
    });
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

// The bar of key hints over the canvas, and the hints on the buttons, are
// made from the registry: only what the reviewer's role may run, with the
// keys that work.
describe("DiffViewer key hints come from the registry", () => {
  beforeEach(() => {
    mockGetByIdData = { ...defaultMockData };
    mockCheckpoints = { items: [stepFixture("cp-1", "unresolved")] };
    resetReviewSpies();
    // An action to take back: ⌘Z is due.
    useUndoStore.setState({ stack: [] });
    useUndoStore
      .getState()
      .push({ actionId: "a1", label: "Approved 'CP-1'", runIds: [RUN_ID] });
  });
  afterEach(() => {
    cleanup();
    useUndoStore.setState({ stack: [] });
  });

  const viewer = () => (
    <DiffViewer runId={RUN_ID} diffId="d1" initialCheckpointId="cp-1" />
  );
  /** The key caps of the hint bar, in order. */
  const hintKeys = (r: ReturnType<typeof render>) =>
    [
      ...r.getByTestId("diff-viewer-shortcut-hints").querySelectorAll("kbd"),
    ].map((k) => k.textContent);

  test("hint bar lists only allowed primary commands", () => {
    // A reviewer: steps, pending steps, the decisions and undo.
    const reviewer = render(viewer());
    expect(hintKeys(reviewer)).toEqual([
      "←",
      "→",
      "J",
      "K",
      "A",
      "R",
      "Ctrl+Z",
    ]);
    const bar = reviewer.getByTestId("diff-viewer-shortcut-hints");
    expect(bar.textContent).toBe(
      "←→navigateJKnext/prev pendingAapproveRrejectCtrl+Zundo",
    );
    cleanup();

    // A guest: navigation only. No decision, and nothing of theirs to undo.
    keyboard.role = "guest";
    const guest = render(viewer());
    expect(hintKeys(guest)).toEqual(["←", "→", "J", "K"]);
    expect(guest.getByTestId("diff-viewer-shortcut-hints").textContent).toBe(
      "←→navigateJKnext/prev pending",
    );
    expect(guest.queryByTestId("shortcut-hint-undo")).toBeNull();
    cleanup();

    // Single-key shortcuts off: only the keys that still do something.
    keyboard.role = "editor";
    useSingleKeyStore.setState({ on: false });
    const off = render(viewer());
    expect(hintKeys(off)).toEqual(["←", "→", "Ctrl+Z"]);
    expect(off.queryByTestId("shortcut-hint-loop")).toBeNull();
  });

  test("Approve button carries aria-keyshortcuts A and title (A)", () => {
    const r = render(viewer());
    const approve = r.getByTestId("approve-checkpoint-button");
    expect(approve.getAttribute("aria-keyshortcuts")).toBe("A");
    expect(approve.getAttribute("title")).toBe(
      "Promotes this step's candidate as the new baseline for its test variation. (A)",
    );
    const reject = r.getByTestId("reject-button");
    expect(reject.getAttribute("aria-keyshortcuts")).toBe("R X");
    expect(reject.getAttribute("title")).toBe("Reject (R)");
    // Next pending is J's button.
    const next = r.getByTestId("header-next-pending");
    expect(next.getAttribute("aria-keyshortcuts")).toBe("J");
    expect(next.getAttribute("title")).toBe("Next pending step (J)");
    cleanup();

    // A guest has no decision buttons (R14); J is still theirs.
    keyboard.role = "guest";
    const guest = render(viewer());
    expect(guest.queryByTestId("approve-checkpoint-button")).toBeNull();
    expect(
      guest
        .getByTestId("header-next-pending")
        .getAttribute("aria-keyshortcuts"),
    ).toBe("J");
    cleanup();

    // With single-key shortcuts off, no button names a key that does nothing.
    keyboard.role = "editor";
    useSingleKeyStore.setState({ on: false });
    const off = render(viewer());
    expect(
      off
        .getByTestId("approve-checkpoint-button")
        .hasAttribute("aria-keyshortcuts"),
    ).toBe(false);
    expect(off.getByTestId("header-next-pending").getAttribute("title")).toBe(
      "Next pending step",
    );
  });

  test("the step buttons carry aria-keyshortcuts ← / → and their titles", () => {
    // The middle step: both ways are open.
    mockCheckpoints = {
      items: [
        stepFixture("cp-1", "unresolved"),
        stepFixture("cp-2", "unresolved"),
        stepFixture("cp-3", "unresolved"),
      ],
    };
    const r = render(
      <DiffViewer runId={RUN_ID} diffId="d1" initialCheckpointId="cp-2" />,
    );
    for (const [prev, next] of [
      ["contextual-header-prev", "contextual-header-next"],
      ["diff-viewer-step-prev", "diff-viewer-step-next"],
    ] as const) {
      expect(r.getByTestId(prev).getAttribute("aria-keyshortcuts")).toBe(
        "ArrowLeft",
      );
      expect(r.getByTestId(prev).getAttribute("title")).toBe(
        "Previous step (←)",
      );
      expect(r.getByTestId(next).getAttribute("aria-keyshortcuts")).toBe(
        "ArrowRight",
      );
      expect(r.getByTestId(next).getAttribute("title")).toBe("Next step (→)");
    }
    // The arrows are not character keys: the switch leaves them.
    cleanup();
    useSingleKeyStore.setState({ on: false });
    const off = render(
      <DiffViewer runId={RUN_ID} diffId="d1" initialCheckpointId="cp-2" />,
    );
    expect(
      off
        .getByTestId("diff-viewer-step-next")
        .getAttribute("aria-keyshortcuts"),
    ).toBe("ArrowRight");
  });
});

// R14: the server says whether this viewer may review. A guest gets the
// step's state and its decision, read-only, and no way to decide.
describe("DiffViewer decision buttons follow canReview", () => {
  const DECIDED = {
    id: "d",
    actionId: "a",
    kind: "approved",
    actor: null,
    at: new Date().toISOString(),
    source: "viewer",
    legacy: false,
    undo: { allowed: true, reason: null },
  };
  beforeEach(() => {
    mockGetByIdData = { ...defaultMockData };
    resetReviewSpies();
  });
  afterEach(() => cleanup());

  const DECISION_CONTROLS = [
    "approve-checkpoint-button",
    "reject-button",
    "mark-as-bug-button",
    "approval-more-menu",
    // The same change elsewhere: Accept all / Reject all.
    "group-approval-callout",
    // The older-capture warning, which only matters before approving.
    "stale-step-callout",
  ];
  /** A pending step with a same-change group and a newer capture. */
  function pendingWithEverything() {
    mockGroup = {
      checkpointCount: 2,
      runCount: 1,
      capped: false,
      checkpoints: [
        { runId: "run-2", testName: "Checkout" },
        { runId: "run-2", testName: "Checkout" },
      ],
    };
    mockCheckpoints = {
      items: [
        stepFixture("cp-1", "unresolved", {
          newerCapture: {
            runId: "run-newer",
            checkpointId: "cp-9",
            buildId: "build-2",
            buildName: "#42",
          },
        }),
      ],
    };
  }

  test("a guest sees no Approve / Reject / Mark as Bug in the viewer", () => {
    keyboard.role = "guest";
    pendingWithEverything();
    const pending = render(
      <DiffViewer
        runId={RUN_ID}
        diffId="d1"
        initialCheckpointId="cp-1"
        canReview={false}
      />,
    );
    for (const id of DECISION_CONTROLS) {
      expect(pending.queryByTestId(id), id).toBeNull();
    }
    // The run's state is still on show.
    expect(pending.getByTestId("contextual-header")).toBeDefined();
    cleanup();

    // A decided step: its decision reads as before, with no Undo.
    mockCheckpoints = {
      items: [stepFixture("cp-1", "approved", { decision: DECIDED })],
    };
    const decided = render(
      <DiffViewer
        runId={RUN_ID}
        diffId="d1"
        initialCheckpointId="cp-1"
        canReview={false}
      />,
    );
    const chip = decided.getByTestId("decision-chip");
    expect(chip.textContent).toContain("Approved");
    expect(within(chip).queryByRole("button", { name: /Undo/ })).toBeNull();
    expect(decided.queryByTestId("approval-more-menu")).toBeNull();
    cleanup();

    // A run overridden by hand: the override reads, with no Reset.
    mockGetByIdData = {
      ...defaultMockData,
      status: "failed",
      statusOverride: "failed",
    };
    const overridden = render(
      <DiffViewer
        runId={RUN_ID}
        diffId="d1"
        initialCheckpointId="cp-1"
        canReview={false}
      />,
    );
    expect(overridden.getByTestId("override-chip")).toBeDefined();
    expect(overridden.queryByTestId("reset-override")).toBeNull();
  });

  test("an editor still does", () => {
    pendingWithEverything();
    const pending = render(
      <DiffViewer
        runId={RUN_ID}
        diffId="d1"
        initialCheckpointId="cp-1"
        canReview
      />,
    );
    for (const id of DECISION_CONTROLS) {
      expect(pending.getByTestId(id), id).toBeDefined();
    }
    // And they work (a rejection asks nothing, even of an older capture).
    fireEvent.click(pending.getByTestId("reject-button"));
    expect(reviewSpies.decide).toHaveBeenCalledOnce();
    cleanup();

    mockCheckpoints = {
      items: [stepFixture("cp-1", "approved", { decision: DECIDED })],
    };
    const decided = render(
      <DiffViewer
        runId={RUN_ID}
        diffId="d1"
        initialCheckpointId="cp-1"
        canReview
      />,
    );
    expect(
      within(decided.getByTestId("decision-chip")).getByRole("button", {
        name: "Undo approval",
      }),
    ).toBeDefined();
    cleanup();

    mockGetByIdData = {
      ...defaultMockData,
      status: "failed",
      statusOverride: "failed",
    };
    const overridden = render(
      <DiffViewer
        runId={RUN_ID}
        diffId="d1"
        initialCheckpointId="cp-1"
        canReview
      />,
    );
    expect(overridden.getByTestId("reset-override")).toBeDefined();
  });
});

// C1: a region drawn on step N is saved to step N's variation. The toolbar
// used to send no checkpoint, so the server wrote the run's FIRST step.
describe("DiffViewer ignore-region save targets the selected step", () => {
  const draft = {
    id: "draft-1",
    x: 1,
    y: 2,
    width: 30,
    height: 40,
    viewport: "1280x720",
    paddingPx: 0,
    kind: "ignore" as const,
  };
  beforeEach(() => {
    mockGetByIdData = { ...defaultMockData };
    mockCheckpoints = {
      items: [
        stepFixture("cp-1", "unresolved"),
        stepFixture("cp-2", "unresolved"),
      ],
    };
    resetReviewSpies();
    setIgnoreAreasSpy.mockReset();
    useViewerStore.setState({
      ignoreEditMode: "off",
      isTemporaryMode: false,
      draftIgnoreAreas: [],
      markedForDeletion: new Set(),
      paddingOverrides: new Map(),
      kindOverrides: new Map(),
      selectorOverrides: new Map(),
      thresholdOverrides: new Map(),
      geometryOverrides: new Map(),
      selectedIgnoreId: null,
    });
  });
  afterEach(() => cleanup());

  test("Save on step 2 sends step 2's checkpoint id", () => {
    // The run payload carries step 2's own context, as the server sends it.
    mockGetByIdData = {
      ...defaultMockData,
      checkpointContexts: {
        "cp-2": {
          baselineScreenshot: null,
          baselineSource: null,
          variationIgnoreAreas: null,
        },
      },
    };
    const r = render(
      <DiffViewer runId={RUN_ID} diffId="d1" initialCheckpointId="cp-2" />,
    );
    act(() => {
      useViewerStore.setState({
        ignoreEditMode: "variation",
        draftIgnoreAreas: [draft],
      });
    });
    fireEvent.click(r.getByTestId("ignore-save-button"));
    expect(setIgnoreAreasSpy).toHaveBeenCalledOnce();
    expect(setIgnoreAreasSpy.mock.calls[0]![0]).toEqual(
      expect.objectContaining({ runId: RUN_ID, checkpointId: "cp-2" }),
    );
  });

  // The hydration window: the selected step is in the list, but the run
  // payload carries no context for it yet. Its saved regions must not fall
  // back to step 1's (the run-level fields), and Save waits for its own.
  test("a step without its own context hydrates no step-1 regions and holds Save", () => {
    const step1Region = {
      x: 5,
      y: 5,
      width: 10,
      height: 10,
      viewport: "1280x720",
      paddingPx: 0,
      kind: "ignore",
    };
    mockGetByIdData = {
      ...defaultMockData,
      screenshots: [
        { id: "cp-1", viewport: "1280x720" },
        { id: "cp-2", viewport: "1280x720" },
      ],
      variationIgnoreAreas: [step1Region],
      checkpointContexts: {
        "cp-1": {
          baselineScreenshot: null,
          baselineSource: null,
          variationIgnoreAreas: [step1Region],
        },
      },
    };
    useViewerStore.setState({
      savedRunIgnoreAreas: [],
      savedVariationIgnoreAreas: [],
    });
    const r = render(
      <DiffViewer runId={RUN_ID} diffId="d1" initialCheckpointId="cp-2" />,
    );
    expect(useViewerStore.getState().savedVariationIgnoreAreas).toEqual([]);
    act(() => {
      useViewerStore.setState({
        ignoreEditMode: "variation",
        draftIgnoreAreas: [draft],
      });
    });
    const save = r.getByTestId("ignore-save-button") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(save);
    expect(setIgnoreAreasSpy).not.toHaveBeenCalled();
  });

  test("Save waits for the first step to resolve: no write without a checkpoint", () => {
    // The route's `_first` placeholder, before the checkpoint list lands.
    mockCheckpoints = { items: [] };
    const r = render(
      <DiffViewer runId={RUN_ID} initialCheckpointId="_first" />,
    );
    act(() => {
      useViewerStore.setState({
        ignoreEditMode: "variation",
        draftIgnoreAreas: [draft],
      });
    });
    const save = r.getByTestId("ignore-save-button") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(save);
    expect(setIgnoreAreasSpy).not.toHaveBeenCalled();
  });
});

describe("DiffViewer: the comparison mode in the URL (spec §6.3)", () => {
  const PROJECT = "proj-1";
  const stepUrl = (id: string, query = "") =>
    `/projects/${PROJECT}/runs/${RUN_ID}/checkpoints/${id}${query}`;
  /** The mode on screen: the single stage's, or side by side's two panes. */
  function shownMode(): string | null {
    const single = document.querySelector<HTMLElement>(
      "[data-testid=single-stage-host]",
    );
    if (single) return single.dataset.mode ?? null;
    return document.querySelector("[data-testid=candidate-canvas-host]")
      ? "side-by-side"
      : null;
  }
  const stored = () => localStorage.getItem(prefsKey("u1"));

  beforeEach(() => {
    resetReviewSpies();
    localStorage.clear();
    // The images are never answered: nothing reaches the network.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {})),
    );
    // Step 1 is a new test (no baseline); step 2 has one.
    mockGetByIdData = {
      ...defaultMockData,
      projectId: PROJECT,
      buildId: "build-1",
      screenshots: [
        { id: "c1", imageKey: "view-img-1", diffImageKey: null },
        { id: "c2", imageKey: "view-img-2", diffImageKey: null },
      ],
      checkpointContexts: {
        c1: {
          baselineScreenshot: null,
          baselineSource: null,
          variationIgnoreAreas: [],
        },
        c2: {
          baselineScreenshot: { id: "b2", imageKey: "view-base-2" },
          baselineSource: null,
          variationIgnoreAreas: [],
        },
      },
    };
    mockCheckpoints = {
      items: [stepFixture("c1", "new"), stepFixture("c2", "unresolved")],
    };
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  /** The viewer on step `id`'s route, as the checkpoint page renders it. */
  function openStep(
    id: string,
    props: Partial<ComponentProps<typeof DiffViewer>> = {},
  ) {
    navState.pathname = stepUrl(id);
    return render(
      <DiffViewer
        runId={RUN_ID}
        projectId={PROJECT}
        initialCheckpointId={id}
        userId="u1"
        {...props}
      />,
    );
  }

  test("?view outranks the stored preference, on the canvas and in the toolbar", () => {
    useViewerPrefs.getState().hydrate("u1");
    act(() => useViewerPrefs.getState().set("mode", "diff"));
    const r = openStep("c2", { view: "overlay" });
    expect(shownMode()).toBe("overlay");
    expect(
      r.getByRole("radio", { name: /^overlay$/i }).getAttribute("aria-checked"),
    ).toBe("true");
    cleanup();
    // With no ?view, the preference.
    openStep("c2");
    expect(shownMode()).toBe("diff");
  });

  test("M3: ?view over a different stored preference: the stage, its label, the radio group and the keys all show the URL's mode", () => {
    /** What each surface of the viewer says the mode is. */
    function surfaces() {
      const radio = within(
        document.querySelector<HTMLElement>('[role="radiogroup"]')!,
      )
        .getAllByRole("radio")
        .find((el) => el.getAttribute("aria-checked") === "true");
      const f = resolveCommands().find(
        (c) => c.command.id === "viewer.flicker.toggle",
      );
      return {
        stage: shownMode(),
        canvasLabel: [
          ...document.querySelectorAll('[data-testid="canvas-mode-label"]'),
        ].map((el) => el.textContent),
        radio: radio?.dataset.mode ?? null,
        tabStop: radio?.tabIndex ?? null,
        flickerControls:
          within(document.body).queryByRole("button", {
            name: /^(Play|Pause)$/,
          }) !== null,
        opacitySlider:
          document.querySelector('[data-testid="opacity-slider-wrap"]') !==
          null,
        flickerKey: f ? (f.command.enabled?.(f.ctx()) ?? true) : false,
      };
    }
    const LABELS: Record<ViewerMode, string[]> = {
      "side-by-side": ["Baseline", "Current"],
      swipe: ["Baseline | Current"],
      flicker: ["Baseline"],
      overlay: ["Current over baseline"],
      diff: ["Current"],
    };
    const expected = (mode: ViewerMode) => ({
      stage: mode,
      canvasLabel: LABELS[mode],
      radio: mode,
      tabStop: 0,
      flickerControls: mode === "flicker",
      opacitySlider: mode === "overlay",
      flickerKey: mode === "flicker",
    });

    useViewerPrefs.getState().hydrate("u1");
    for (const [view, stored] of [
      ["overlay", "diff"],
      ["flicker", "overlay"],
      ["diff", "flicker"],
      ["side-by-side", "swipe"],
      ["swipe", "side-by-side"],
    ] as const) {
      act(() => useViewerPrefs.getState().set("mode", stored));
      openStep("c2", { view });
      expect(surfaces(), `?view=${view} over a stored ${stored}`).toEqual(
        expected(view),
      );
      cleanup();
    }
  });

  test("a tab changes the mode at once, stores it, and replaces the URL with view, keeping the rest", () => {
    navState.search = "status=failed&os=macOS";
    const r = openStep("c2", {
      view: "overlay",
      reviewContext: { status: "failed", facets: { os: "macOS" } },
    });
    fireEvent.click(r.getByRole("radio", { name: /^diff$/i }));
    expect(historyWrite).toHaveBeenCalledOnce();
    expect(historyWrite).toHaveBeenCalledWith(
      null,
      "",
      stepUrl("c2", "?status=failed&os=macOS&view=diff"),
    );
    expect(routerSpies.replace).not.toHaveBeenCalled();
    expect(routerSpies.push).not.toHaveBeenCalled();
    expect(useViewerPrefs.getState().prefs.mode).toBe("diff");
    expect(JSON.parse(stored() ?? "{}").mode).toBe("diff");
    // Before the router has re-rendered the page with the new URL.
    expect(shownMode()).toBe("diff");
    // And the next step goes in the mode now chosen.
    press("ArrowLeft");
    expect(routerSpies.replace).toHaveBeenLastCalledWith(
      stepUrl("c1", "?status=failed&os=macOS&view=diff"),
    );
  });

  test("d and o change the URL's mode, not only the preference", () => {
    const r = openStep("c2", { view: "overlay" });
    press("d");
    expect(historyWrite).toHaveBeenLastCalledWith(
      null,
      "",
      stepUrl("c2", "?view=diff"),
    );
    expect(shownMode()).toBe("diff");
    // Back to the mode it left: the URL's Overlay, not the stored default.
    press("d");
    expect(shownMode()).toBe("overlay");
    expect(
      r.getByRole("radio", { name: /^overlay$/i }).getAttribute("aria-checked"),
    ).toBe("true");
    press("o");
    expect(shownMode()).toBe("diff");
    expect(historyWrite).toHaveBeenLastCalledWith(
      null,
      "",
      stepUrl("c2", "?view=diff"),
    );
    expect(routerSpies.replace).not.toHaveBeenCalled();
  });

  test("1–5 follow the step on screen: on a new test only 1 is the viewer's; on the next step, with a baseline, 2 is Swipe", () => {
    /** A key press the page may take (cancelable, as the browser's). */
    const pressKey = (key: string) => {
      const e = new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
      });
      act(() => {
        window.dispatchEvent(e);
      });
      return e;
    };
    openStep("c1");
    for (const key of ["2", "3", "4", "5"]) {
      expect(pressKey(key).defaultPrevented, key).toBe(false);
    }
    expect(shownMode()).toBe("side-by-side");
    expect(routerSpies.replace).not.toHaveBeenCalled();
    expect(historyWrite).not.toHaveBeenCalled();
    expect(stored()).toBeNull();

    // → shows step 2 at once; its route is still on its way, so the mode
    // goes with it, as a replace to step 2: a history write would call the
    // step change off.
    pressKey("ArrowRight");
    expect(pressKey("2").defaultPrevented).toBe(true);
    expect(shownMode()).toBe("swipe");
    expect(routerSpies.replace).toHaveBeenLastCalledWith(
      stepUrl("c2", "?view=swipe"),
      { scroll: false },
    );
    expect(historyWrite).not.toHaveBeenCalled();
  });

  test("the editor on Swipe (spec §4.4): side by side while it is open, Swipe again when it closes, the URL and the preference untouched; the override is the step's", () => {
    const checked = () =>
      document
        .querySelector('[role="radio"][aria-checked="true"]')
        ?.getAttribute("data-mode");
    openStep("c2", { view: "swipe" });
    expect(shownMode()).toBe("swipe");
    press("i");
    expect(useViewerStore.getState().ignoreEditMode).not.toBe("off");
    expect(shownMode()).toBe("side-by-side");
    expect(checked()).toBe("side-by-side");
    press("Escape");
    expect(shownMode()).toBe("swipe");
    expect(checked()).toBe("swipe");
    expect(routerSpies.replace).not.toHaveBeenCalled();
    expect(historyWrite).not.toHaveBeenCalled();
    expect(stored()).toBeNull();

    // Open again, then ← to step 1, which has no baseline: side by side on
    // its own, and the override went with step 2.
    press("i");
    press("ArrowLeft");
    expect(routerSpies.replace).toHaveBeenLastCalledWith(
      stepUrl("c1", "?view=swipe"),
    );
    expect(shownMode()).toBe("side-by-side");
    expect(readEffectiveMode("swipe", true)).toBe("swipe");
    // Back on step 2, the editor still open: side by side again, and Swipe
    // once it closes.
    press("ArrowRight");
    expect(shownMode()).toBe("side-by-side");
    act(() => useViewerStore.getState().setIgnoreEditMode("off"));
    expect(shownMode()).toBe("swipe");

    // The viewer gone with the editor open: it pins no later viewer.
    press("i");
    expect(readEffectiveMode("overlay", true)).toBe("side-by-side");
    cleanup();
    expect(readEffectiveMode("overlay", true)).toBe("overlay");
    openStep("c2", { view: "overlay" });
    expect(shownMode()).toBe("overlay");
  });

  test("Review Focus 4: ?view=swipe on a step with no baseline is side by side, nothing changes, and the next step opens in Swipe", () => {
    openStep("c1", { view: "swipe" });
    expect(shownMode()).toBe("side-by-side");
    expect(routerSpies.replace).not.toHaveBeenCalled();
    expect(historyWrite).not.toHaveBeenCalled();
    expect(useViewerPrefs.getState().prefs.mode).toBe("side-by-side");
    expect(stored()).toBeNull();

    press("ArrowRight");
    expect(routerSpies.replace).toHaveBeenCalledOnce();
    expect(routerSpies.replace).toHaveBeenCalledWith(
      stepUrl("c2", "?view=swipe"),
    );
    // The step on screen now has a baseline.
    expect(shownMode()).toBe("swipe");
    expect(useViewerPrefs.getState().prefs.mode).toBe("side-by-side");
    expect(stored()).toBeNull();
    cleanup();

    // As the route commits: the next step's own page, with the URL's view.
    openStep("c2", { view: "swipe" });
    expect(shownMode()).toBe("swipe");
  });

  describe("R31: a mode change is a history write, and the view is the URL's", () => {
    test("1–5, o and d write the history only: no router.replace and no router.push, so the page is never rendered again", () => {
      const r = openStep("c2", { view: "overlay" });
      for (const [key, mode] of [
        ["2", "swipe"],
        ["3", "flicker"],
        ["5", "diff"],
        ["1", "side-by-side"],
        ["o", "swipe"],
        ["d", "diff"],
      ] as const) {
        press(key);
        expect(shownMode(), key).toBe(mode);
        expect(historyWrite, key).toHaveBeenLastCalledWith(
          null,
          "",
          stepUrl("c2", `?view=${mode}`),
        );
      }
      fireEvent.click(r.getByRole("radio", { name: /^overlay$/i }));
      expect(shownMode()).toBe("overlay");
      expect(historyWrite).toHaveBeenCalledTimes(7);
      expect(routerSpies.replace).not.toHaveBeenCalled();
      expect(routerSpies.push).not.toHaveBeenCalled();
    });

    test("useSearchParams reflects the new view: the viewer reads it there, and its links carry it", () => {
      const r = openStep("c2", { view: "overlay" });
      press("2");
      // Next applied the write: the URL names Swipe, the page's prop still
      // Overlay.
      expect(navState.search).toBe("view=swipe");
      expect(shownMode()).toBe("swipe");
      // The URL moves again without a page render (a history write of
      // another part of the viewer, or Next's own): the viewer follows it.
      navState.search = "view=diff";
      r.rerender(
        <DiffViewer
          runId={RUN_ID}
          projectId={PROJECT}
          initialCheckpointId="c2"
          userId="u1"
          view="overlay"
        />,
      );
      expect(shownMode()).toBe("diff");
      expect(
        r.getByRole("radio", { name: /^diff$/i }).getAttribute("aria-checked"),
      ).toBe("true");
      // ← carries the URL's view to the next step.
      press("ArrowLeft");
      expect(routerSpies.replace).toHaveBeenLastCalledWith(
        stepUrl("c1", "?view=diff"),
      );
    });

    test("Back and Forward restore the mode: an entry a mode change rewrote opens in its URL's mode, over the page's restored view", () => {
      // Step 2 opened in Overlay; 2 rewrote its entry to Swipe; → then went
      // on to step 1 (a new entry, in Swipe).
      openStep("c2", { view: "overlay" });
      press("2");
      expect(navState.search).toBe("view=swipe");
      cleanup();
      openStep("c1", { view: "swipe" });
      press("1");
      cleanup();

      // Back: Next restores step 2's page as it was rendered (view=overlay),
      // under the entry's URL, which says Swipe.
      navState.search = "view=swipe";
      openStep("c2", { view: "overlay" });
      expect(shownMode()).toBe("swipe");
      cleanup();

      // Forward: step 1's entry, which 1 rewrote to side by side.
      navState.search = "view=side-by-side";
      openStep("c1", { view: "swipe" });
      expect(shownMode()).toBe("side-by-side");
      cleanup();

      // Back again, to step 2: Swipe, still.
      navState.search = "view=swipe";
      openStep("c2", { view: "overlay" });
      expect(shownMode()).toBe("swipe");
      expect(routerSpies.replace).not.toHaveBeenCalled();
      expect(routerSpies.push).not.toHaveBeenCalled();
    });

    test("a user id that goes to null while the viewer is open is ignored: the user's preferences stay, and are still stored for them", () => {
      localStorage.setItem(
        prefsKey("u1"),
        JSON.stringify({
          ...DEFAULT_VIEWER_PREFS,
          mode: "overlay",
          opacity: 0.8,
        }),
      );
      const r = openStep("c2");
      expect(shownMode()).toBe("overlay");
      // A later render of the page whose session lookup failed.
      r.rerender(
        <DiffViewer
          runId={RUN_ID}
          projectId={PROJECT}
          initialCheckpointId="c2"
          userId={null}
        />,
      );
      expect(useViewerPrefs.getState().userId).toBe("u1");
      expect(useViewerPrefs.getState().prefs.opacity).toBe(0.8);
      expect(shownMode()).toBe("overlay");
      press("5");
      expect(JSON.parse(stored() ?? "{}").mode).toBe("diff");
    });
  });
});

describe("DiffViewer: a step whose diff failed (spec 2026-10-23 §10)", () => {
  const REASON = "The diff didn't finish in time.";
  /** A step whose diff failed for good, as `runs.listCheckpoints` says it. */
  const failedStep = (id: string, over: Partial<StepFixture> = {}) => ({
    ...stepFixture(id, "unresolved", over),
    diffFailedAt: "2026-10-24T08:00:00.000Z",
    diffError: "timeout",
  });
  const retryCommand = () =>
    resolveCommands().find(({ command }) => command.id === "viewer.retryDiff");
  /** Whether the palette would offer Retry diff now. */
  const retryOffered = () => {
    const resolved = retryCommand();
    return resolved?.command.enabled?.(resolved.ctx()) ?? false;
  };
  const renderStep = (id = "cp-1") =>
    render(<DiffViewer runId={RUN_ID} diffId="d1" initialCheckpointId={id} />);

  beforeEach(() => {
    mockGetByIdData = { ...defaultMockData };
    mockCheckpoints = { items: [failedStep("cp-1")] };
    resetReviewSpies();
    retryDiffSpy.mockReset();
    retryDiffSpy.mockResolvedValue({ status: "running" });
  });
  afterEach(() => cleanup());

  test("the stage says why, and an editor can retry from it", () => {
    const r = renderStep();
    const card = r.getByTestId("stage-diff-failed");
    expect(card.textContent).toContain(`This step's diff failed. ${REASON}`);
    fireEvent.click(within(card).getByRole("button", { name: "Retry diff" }));
    expect(retryDiffSpy).toHaveBeenCalledOnce();
    expect(retryDiffSpy).toHaveBeenCalledWith({
      runId: RUN_ID,
      checkpointId: "cp-1",
    });
  });

  test("a guest sees the state, with no way to retry", () => {
    keyboard.role = "guest";
    const r = renderStep();
    expect(r.getByTestId("stage-diff-failed").textContent).toContain(REASON);
    expect(r.queryByRole("button", { name: "Retry diff" })).toBeNull();
    expect(retryCommand()).toBeUndefined();
  });

  test("Approve, Reject and Mark as Bug are disabled with Retry the diff first, keys included", () => {
    const r = renderStep();
    for (const id of [
      "approve-checkpoint-button",
      "reject-button",
      "mark-as-bug-button",
    ]) {
      const button = r.getByTestId(id);
      expect(button.getAttribute("aria-disabled"), id).toBe("true");
      const reason = document.getElementById(
        button.getAttribute("aria-describedby")!,
      );
      expect(reason?.textContent, id).toBe("Retry the diff first");
      fireEvent.click(button);
    }
    press("A");
    press("R");
    expect(reviewSpies.decide).not.toHaveBeenCalled();
  });

  test("the palette offers Retry diff on the failed step only, and it retries that step", () => {
    renderStep();
    expect(retryOffered()).toBe(true);
    // No key is bound to it.
    expect(retryCommand()?.command.keys ?? []).toEqual([]);
    act(() => {
      void retryCommand()?.command.run(retryCommand()!.ctx());
    });
    expect(retryDiffSpy).toHaveBeenCalledWith({
      runId: RUN_ID,
      checkpointId: "cp-1",
    });
    cleanup();

    // A step whose diff did not fail has nothing to retry.
    mockCheckpoints = { items: [stepFixture("cp-1", "unresolved")] };
    useCommandRegistry.setState({ entries: [], role: "guest" });
    renderStep();
    expect(retryOffered()).toBe(false);
  });

  test("while the retry is out the stage's button is busy and the palette action waits", async () => {
    let settle!: () => void;
    retryDiffSpy.mockReturnValue(
      new Promise<{ status: string }>((resolve) => {
        settle = () => resolve({ status: "running" });
      }),
    );
    const r = renderStep();
    const button = r.getByRole("button", { name: "Retry diff" });
    fireEvent.click(button);
    await waitFor(() => expect(button.getAttribute("aria-busy")).toBe("true"));
    expect(retryOffered()).toBe(false);
    // The step list, the run and the run lists are read again once it lands.
    await act(async () => settle());
    expect(utilsMock.runs.listCheckpoints.invalidate).toHaveBeenCalledWith({
      runId: RUN_ID,
    });
    expect(utilsMock.runs.getById.invalidate).toHaveBeenCalledWith({
      runId: RUN_ID,
    });
    expect(utilsMock.runs.list.invalidate).toHaveBeenCalled();
  });

  test("the step list is read again when a step settles, so a retried step leaves 'being diffed'", () => {
    renderStep();
    const es = StubEventSource.instances.at(-1)!;
    const list = utilsMock.runs.listCheckpoints.invalidate;

    act(() => es.emit({ type: "capture.started", runId: RUN_ID }));
    expect(list).not.toHaveBeenCalled();

    act(() =>
      es.emit({
        type: "run.checkpoint_diffed",
        runId: RUN_ID,
        screenshotId: "cp-1",
        verdict: "unresolved",
        failed: true,
      }),
    );
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenLastCalledWith({ runId: RUN_ID });
  });

  test("a failed step shows no 'no changes' message in Diff", () => {
    useViewerPrefs.setState({
      prefs: { ...DEFAULT_VIEWER_PREFS, mode: "diff" },
    });
    const r = renderStep();
    expect(r.getByTestId("stage-diff-failed")).toBeDefined();
    expect(r.queryByText(/No pixel changes/)).toBeNull();
  });
});
