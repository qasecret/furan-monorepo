/**
 * The viewer's reads (spec 2026-10-27 §5, budget R4): the run header, the
 * step list, and one step at a time (`runs.getStep`), with the steps either
 * side of it in the rail fetched ahead. Over a real tRPC client and
 * react-query cache whose "server" is a function (`TrpcBackend`), so a test
 * sees every call the viewer makes, and when.
 */
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  // Not `screen`: the stage mock's Application has a `screen` of its own,
  // which vitest's mock hoisting would take for this import.
  screen as ui,
  waitFor,
  within,
} from "@testing-library/react";
import { getQueryKey } from "@trpc/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  callsTo,
  createBackend,
  TrpcBackend,
  type Backend,
} from "./trpc-backend";

const { routerSpies } = vi.hoisted(() => ({
  routerSpies: { push: vi.fn(), replace: vi.fn() },
}));
vi.mock("next/navigation", () => ({
  useRouter: () => routerSpies,
  usePathname: () => "",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("next/link", async () => {
  const { createElement } = await import("react");
  return {
    default: ({
      href,
      children,
      ...rest
    }: {
      href: string;
      children: ReactNode;
    }) => createElement("a", { href, ...rest }, children),
  };
});
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
// The stage's canvases: inert display objects (WebGL is not what is tested).
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
    fill() {
      return this;
    }
    stroke() {
      return this;
    }
    clear() {
      return this;
    }
  }
  return {
    Application: class {
      canvas = document.createElement("canvas");
      stage = new Container();
      screen = { width: 600, height: 400 };
      ticker = { add: () => {}, remove: () => {} };
      async init() {}
      destroy() {}
    },
    Assets: { load: async () => ({}) },
    Sprite: Container,
    Container,
    Graphics,
    Text: Container,
    Texture: { from: () => ({ destroy: () => {} }) },
  };
});

// The run's events: a test delivers a frame as the server would.
class StubEventSource {
  static instances: StubEventSource[] = [];
  listeners: Array<(m: { data: string }) => void> = [];
  constructor() {
    StubEventSource.instances.push(this);
  }
  addEventListener(_type: string, fn: (m: { data: string }) => void) {
    this.listeners.push(fn);
  }
  removeEventListener(_type: string, fn: (m: { data: string }) => void) {
    this.listeners = this.listeners.filter((l) => l !== fn);
  }
  /** Delivers a `progress` frame. */
  emit(event: unknown) {
    for (const fn of this.listeners) fn({ data: JSON.stringify(event) });
  }
  close() {}
}
(globalThis as unknown as { EventSource: unknown }).EventSource =
  StubEventSource;

import { DiffViewer } from "@/components/diff-viewer/DiffViewer";
import { resetStepsLeftForTests } from "@/components/diff-viewer/use-viewer-step";
import {
  DEFAULT_VIEWER_PREFS,
  useViewerPrefs,
} from "@/components/diff-viewer/viewer-prefs";
import { CommandRoleProvider } from "@/lib/commands/registry";
import { useReviewMutations } from "@/lib/review/use-review-mutations";
import { trpc } from "@/lib/trpc";

const RUN = "00000000-0000-4000-8000-000000000001";
const OTHER_RUN = "00000000-0000-4000-8000-000000000002";
const NAMES: Record<string, string> = {
  c1: "Home",
  c2: "Search",
  c3: "Cart",
  c4: "Checkout",
};
const AT = "2026-10-27T09:00:00.000Z";
const NO_CHANGES =
  "No pixel changes between the baseline and the current screenshot.";

/** A decision someone else made on a step, as the step's read reports it. */
const OTHERS_APPROVAL = {
  id: "decision-9",
  actionId: "action-9",
  kind: "approved",
  actor: { id: "user-9", name: "Grace" },
  at: AT,
  source: "viewer",
  legacy: false,
  undo: { allowed: false, reason: "not_decider" },
};

/** One step as the server holds it; a test may change it. */
interface HeldStep {
  verdict: "new" | "unresolved" | "passed";
  decided: boolean;
  diffPercent: number | null;
  /** A step from before steps kept their own diff images and numbers. */
  legacy: boolean;
}

interface Server {
  backend: Backend;
  steps: Record<string, HeldStep>;
  /** Holds the next call to `path:key` until the returned release. */
  gate(key: string): () => void;
}

/** A server holding one run (`ids`, in capture order), nothing decided. */
function runServer(
  ids: readonly string[] = ["c1", "c2", "c3", "c4"],
  over: Partial<HeldStep> = {},
): Server {
  const steps: Record<string, HeldStep> = Object.fromEntries(
    ids.map((id) => [
      id,
      {
        verdict: "unresolved",
        decided: false,
        diffPercent: 1.5,
        legacy: false,
        ...over,
      },
    ]),
  );
  const stateOf = (h: HeldStep) => (h.decided ? "approved" : h.verdict);
  const listed = (id: string) => {
    const h = steps[id]!;
    return {
      id,
      name: NAMES[id],
      viewport: "1280x720",
      browser: "chromium",
      os: `os-${id}`,
      device: null,
      imageKey: `img-${id}`,
      diffFailedAt: null,
      diffError: null,
      verdict: h.verdict,
      state: stateOf(h),
      decision: h.decided
        ? {
            actionId: OTHERS_APPROVAL.actionId,
            kind: "approved",
            undo: { allowed: false },
          }
        : null,
      newerCapture: null,
    };
  };
  const stepRead = (runId: string, id: string) => {
    const h = steps[id]!;
    return {
      step: {
        id,
        runId,
        name: NAMES[id],
        viewport: "1280x720",
        browser: "chromium",
        os: `os-${id}`,
        device: null,
        matchLevel: "strict",
        imageKey: `img-${id}`,
        diffImageKey: h.legacy ? null : `diff-${id}`,
        elementMapKey: null,
        diffPercent: h.diffPercent,
        diffGeneration: h.legacy ? 0 : 1,
        vlmDescription: null,
        testVariationId: `variation-${id}`,
        diffFailedAt: null,
        diffError: null,
        verdict: h.verdict,
        createdAt: AT,
      },
      baselineContext: {
        baselineScreenshot: { id: `base-${id}`, imageKey: `base-${id}` },
        baselineSource: "this_branch",
        variationIgnoreAreas: null,
      },
      regions: [],
      review: {
        verdict: h.verdict,
        state: stateOf(h),
        decision: h.decided ? OTHERS_APPROVAL : null,
      },
      newerCapture: null,
    };
  };
  const gates = new Map<string, Promise<void>>();
  const backend = createBackend();
  backend.answer = async ({ path, input }) => {
    const key = `${path}:${String(input.checkpointId ?? input.runId ?? "")}`;
    const gate = gates.get(key);
    if (gate) {
      gates.delete(key);
      await gate;
    }
    switch (path) {
      case "runs.getById":
        return {
          id: RUN,
          projectId: "p1",
          buildId: "b1",
          name: "Checkout flow",
          status: "unresolved",
          statusOverride: null,
          branchName: "main",
          // The run's worst step's image and %, which a legacy step of a run
          // of one step borrows.
          diffName: "run-diff",
          diffPercent: 2,
          vlmDescription: null,
          baselineName: null,
          comment: null,
          diffThresholdOverride: null,
          createdAt: AT,
          updatedAt: AT,
          runByName: "Mem Ber",
          autoApproved: false,
        };
      case "runs.listCheckpoints":
        return { items: ids.map(listed) };
      case "runs.getStep":
        return stepRead(String(input.runId), String(input.checkpointId));
      case "projects.getById":
        return {
          id: "p1",
          name: "App",
          dynamicTextEnabled: false,
          diffThreshold: null,
        };
      case "review.next":
        return {
          target: null,
          scope: "batch",
          remaining: {
            run: 0,
            batch: 0,
            batchUnfiltered: 0,
            projectBatches: 0,
          },
          nextBatch: null,
        };
      case "review.approve":
        return {
          actionId: input.actionId,
          decided: (input.checkpointIds as string[]).map((checkpointId) => ({
            checkpointId,
            runId: RUN,
            state: "approved",
          })),
          runs: [{ runId: RUN, status: "unresolved" }],
          replayed: false,
          capped: false,
          cap: 500,
        };
      case "runs.getCheckpointGroup":
        return {
          checkpoints: [],
          checkpointCount: 0,
          runCount: 0,
          capped: false,
        };
      case "builds.getById":
        return { id: "b1", runByName: "Mem Ber" };
      default:
        return { items: [], nextCursor: null };
    }
  };
  return {
    backend,
    steps,
    gate(key) {
      let release!: () => void;
      gates.set(key, new Promise<void>((r) => (release = r)));
      return () => release();
    },
  };
}

/** The step reads asked for, by step id, in order (run RUN only). */
const stepReads = (backend: Backend): string[] =>
  callsTo(backend, "runs.getStep")
    .filter((c) => c.runId === RUN)
    .map((c) => String(c.checkpointId));
const readsOf = (backend: Backend, id: string): number =>
  stepReads(backend).filter((x) => x === id).length;

/** The step's OS, as the INFO sidebar shows it: from the step's own read. */
const sidebarOs = (id: string) => ui.queryByText(`os-${id}`);

/** The sidebar's Pixel diff card: the step's own diff %, from its read. */
const pixelDiff = () =>
  within(ui.getByTestId("info-stat-cards")).getByText("Pixel diff")
    .previousElementSibling?.textContent;

/** What the header offers for the step on screen. */
const header = () => ({
  approve: ui.queryByTestId("approve-checkpoint-button") !== null,
  matchesBaseline: ui.queryByTestId("matches-baseline") !== null,
});

const stepKey = (runId: string, checkpointId: string) =>
  getQueryKey(trpc.runs.getStep, { runId, checkpointId }, "query");

let utils: ReturnType<typeof trpc.useUtils> | undefined;
let queryClient: QueryClient | undefined;
function Utils() {
  utils = trpc.useUtils();
  queryClient = useQueryClient();
  return null;
}

/** The viewer on `step` (none: the reviewer has left the run). */
function viewer(backend: Backend, step: string | null) {
  return (
    <TrpcBackend backend={backend}>
      <CommandRoleProvider role="editor">
        <Utils />
        {step !== null && (
          <DiffViewer
            // The route remounts the viewer on every step.
            key={step}
            runId={RUN}
            projectId="p1"
            initialCheckpointId={step}
            canReview
            userId={null}
          />
        )}
      </CommandRoleProvider>
    </TrpcBackend>
  );
}

/** Opens `step` and waits for it and its neighbours to be in. */
async function openStep(server: Server, step: string, neighbours: string[]) {
  const r = render(viewer(server.backend, step));
  await ui.findByText(`os-${step}`);
  await waitFor(() =>
    expect(stepReads(server.backend)).toEqual(
      expect.arrayContaining(neighbours),
    ),
  );
  await act(async () => {});
  return r;
}

/** The worker settles `id`: the frame the run's events deliver. */
function diffed(id: string) {
  act(() =>
    StubEventSource.instances.at(-1)!.emit({
      type: "run.checkpoint_diffed",
      runId: RUN,
      screenshotId: id,
      verdict: "passed",
      failed: false,
    }),
  );
}

beforeEach(() => {
  routerSpies.push.mockReset();
  routerSpies.replace.mockReset();
  StubEventSource.instances = [];
  // The step's images are never answered: nothing reaches the network.
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise<Response>(() => {})),
  );
});
afterEach(() => {
  cleanup();
  // The unmount just above may have started a run's leave timer.
  resetStepsLeftForTests();
  vi.unstubAllGlobals();
  utils = undefined;
  queryClient = undefined;
  useViewerPrefs.setState({ prefs: DEFAULT_VIEWER_PREFS });
});

describe("the viewer reads one step", () => {
  test("opening a step fetches getStep for it and never builds.getById", async () => {
    const { backend } = runServer();
    render(viewer(backend, "c2"));

    // The step on screen is its own read's: its environment in the sidebar.
    expect(await ui.findByText("os-c2")).toBeDefined();
    expect(callsTo(backend, "runs.getStep")).toContainEqual({
      runId: RUN,
      checkpointId: "c2",
    });
    // "Run by" is the run header's: no read of the build.
    expect(ui.getByText("Mem Ber")).toBeDefined();
    expect(callsTo(backend, "runs.getById")).toEqual([{ runId: RUN }]);
    expect(callsTo(backend, "builds.getById")).toEqual([]);
  });

  test("the next and previous steps are prefetched", async () => {
    const { backend } = runServer();
    render(viewer(backend, "c2"));
    await ui.findByText("os-c2");

    // In the rail's order: c3 next, c1 previous. Not c4, two steps away.
    await waitFor(() =>
      expect(stepReads(backend).sort()).toEqual(["c1", "c2", "c3"]),
    );
    await act(async () => {});
    // Each asked for once.
    expect(stepReads(backend).sort()).toEqual(["c1", "c2", "c3"]);
  });

  test("moving to the next step renders from the prefetched step without a new getStep round trip", async () => {
    const server = runServer();
    const r = await openStep(server, "c2", ["c1", "c3"]);

    // → in the viewer: c3 is on screen at once, from the cache.
    fireEvent.click(ui.getByTestId("diff-viewer-step-next"));
    expect(sidebarOs("c3")).not.toBeNull();
    expect(ui.queryByText("Loading…")).toBeNull();
    expect(routerSpies.replace).toHaveBeenCalledWith(
      expect.stringContaining(`/runs/${RUN}/checkpoints/c3`),
    );

    // The route commits and remounts the viewer on c3: still the cache.
    r.rerender(viewer(server.backend, "c3"));
    expect(sidebarOs("c3")).not.toBeNull();
    expect(ui.queryByText("Loading…")).toBeNull();
    // Its own neighbours: c4 is fetched ahead; c2 is fresh in the cache.
    await waitFor(() => expect(stepReads(server.backend)).toContain("c4"));
    await act(async () => {});
    expect(readsOf(server.backend, "c3")).toBe(1);
    expect(readsOf(server.backend, "c2")).toBe(1);
  });

  test("a step read older than a step list that says otherwise is read again", async () => {
    const server = runServer();
    await openStep(server, "c2", ["c1", "c3"]);

    // The list read again, saying the same: the step's read stands.
    await act(async () => {
      await utils!.runs.listCheckpoints.invalidate({ runId: RUN });
    });
    expect(readsOf(server.backend, "c2")).toBe(1);
    expect(ui.queryByTestId("decision-chip")).toBeNull();

    // Another reviewer approves c2. The list, read again, says so first;
    // the step's own read, still fresh, is read again and shows who did it.
    server.steps.c2!.decided = true;
    await act(async () => {
      await utils!.runs.listCheckpoints.invalidate({ runId: RUN });
    });
    await waitFor(() => expect(readsOf(server.backend, "c2")).toBe(2));
    const chip = await ui.findByTestId("decision-chip");
    expect(chip.textContent).toContain("Grace");

    // A re-diff of the decided step changes only its verdict: the list says
    // so first, and the step's read is read again for it too.
    server.steps.c2!.verdict = "passed";
    await act(async () => {
      await utils!.runs.listCheckpoints.invalidate({ runId: RUN });
    });
    await waitFor(() => expect(readsOf(server.backend, "c2")).toBe(3));
  });
});

describe("a step reached after an event never shows its old review state", () => {
  test("the worker settles the next step: moving to it shows its new state, never the old", async () => {
    const server = runServer();
    await openStep(server, "c2", ["c1", "c3"]);
    expect(readsOf(server.backend, "c3")).toBe(1);

    // c3 is diffed again and now matches its baseline.
    server.steps.c3!.verdict = "passed";
    server.steps.c3!.diffPercent = 0;
    diffed("c3");
    // The neighbour is read again at once, with the step list.
    await waitFor(() => expect(readsOf(server.backend, "c3")).toBe(2));
    await waitFor(() =>
      expect(callsTo(server.backend, "runs.listCheckpoints")).toHaveLength(2),
    );
    await act(async () => {});

    // Whatever is drawn from the moment c3 is on screen is its new state.
    const offered: Array<ReturnType<typeof header>> = [];
    const watch = new MutationObserver(() => {
      if (sidebarOs("c3")) offered.push(header());
    });
    watch.observe(document.body, { childList: true, subtree: true });
    fireEvent.click(ui.getByTestId("diff-viewer-step-next"));
    expect(sidebarOs("c3")).not.toBeNull();
    expect(header()).toEqual({ approve: false, matchesBaseline: true });
    expect(pixelDiff()).toBe("0.00%");
    await act(async () => {});
    watch.disconnect();
    expect(offered.length).toBeGreaterThan(0);
    for (const h of offered) {
      expect(h).toEqual({ approve: false, matchesBaseline: true });
    }
  });

  test("a step read the event left stale, reached while it is read again, takes the step list's newer word", async () => {
    const server = runServer();
    const r = await openStep(server, "c2", ["c1", "c3"]);
    // The review loop's next step, c4, fetched ahead: in the cache, watched
    // by no viewer.
    await act(async () => {
      await utils!.runs.getStep.prefetch({ runId: RUN, checkpointId: "c4" });
    });
    expect(readsOf(server.backend, "c4")).toBe(1);

    // c4 is diffed again: the list, on screen, is read again; c4's read
    // only goes stale.
    server.steps.c4!.verdict = "passed";
    server.steps.c4!.diffPercent = 0;
    diffed("c4");
    await waitFor(() =>
      expect(callsTo(server.backend, "runs.listCheckpoints")).toHaveLength(2),
    );
    await act(async () => {});
    expect(readsOf(server.backend, "c4")).toBe(1);

    // The loop lands on c4 while its read is on its way again: the header
    // follows the list, read since, not the old read on screen meanwhile.
    const release = server.gate("runs.getStep:c4");
    r.rerender(viewer(server.backend, "c4"));
    expect(sidebarOs("c4")).not.toBeNull();
    expect(header()).toEqual({ approve: false, matchesBaseline: true });
    release();
    await waitFor(() => expect(pixelDiff()).toBe("0.00%"));
    expect(header()).toEqual({ approve: false, matchesBaseline: true });
  });
});

describe("the step reads of a run", () => {
  test("getStep.invalidate({ runId }) reaches every step read of the run, and no other run's", async () => {
    const server = runServer();
    function Reads() {
      trpc.runs.getStep.useQuery({ runId: RUN, checkpointId: "c1" });
      trpc.runs.getStep.useQuery({ runId: RUN, checkpointId: "c2" });
      trpc.runs.getStep.useQuery({ runId: OTHER_RUN, checkpointId: "c1" });
      return null;
    }
    render(
      <TrpcBackend backend={server.backend}>
        <Utils />
        <Reads />
      </TrpcBackend>,
    );
    await waitFor(() =>
      expect(callsTo(server.backend, "runs.getStep")).toHaveLength(3),
    );
    server.backend.calls.length = 0;

    await act(async () => {
      await utils!.runs.getStep.invalidate({ runId: RUN });
    });
    expect(callsTo(server.backend, "runs.getStep")).toEqual([
      { runId: RUN, checkpointId: "c1" },
      { runId: RUN, checkpointId: "c2" },
    ]);
  });

  test("a run-wide invalidation reads the neighbours again, and a move to one shows what it is now", async () => {
    const server = runServer();
    await openStep(server, "c2", ["c1", "c3"]);

    server.steps.c3!.diffPercent = 4;
    await act(async () => {
      await utils!.runs.getStep.invalidate({ runId: RUN });
    });
    // The step on screen and both neighbours; not c4, which no one watches.
    expect(stepReads(server.backend).sort()).toEqual(
      ["c1", "c1", "c2", "c2", "c3", "c3"].sort(),
    );

    fireEvent.click(ui.getByTestId("diff-viewer-step-next"));
    expect(sidebarOs("c3")).not.toBeNull();
    expect(pixelDiff()).toBe("4.00%");
    await act(async () => {});
    expect(readsOf(server.backend, "c3")).toBe(2);
  });

  test("a decision does not cancel a neighbour's read still on its way", async () => {
    const server = runServer();
    let decide!: ReturnType<typeof useReviewMutations>["decide"];
    function Reviewer() {
      decide = useReviewMutations().decide;
      trpc.runs.listCheckpoints.useQuery({ runId: RUN });
      return null;
    }
    render(
      <TrpcBackend backend={server.backend}>
        <Utils />
        <Reviewer />
      </TrpcBackend>,
    );
    await waitFor(() =>
      expect(callsTo(server.backend, "runs.listCheckpoints")).toHaveLength(1),
    );
    await act(async () => {});

    // c3 is fetched ahead; its answer is still on its way.
    const release = server.gate("runs.getStep:c3");
    let ahead!: Promise<void>;
    act(() => {
      ahead = utils!.runs.getStep.prefetch({ runId: RUN, checkpointId: "c3" });
    });
    // c2 is approved meanwhile.
    await act(async () => {
      decide({
        runId: RUN,
        checkpointIds: ["c2"],
        kind: "approved",
        label: "Approved 'Search'",
      });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(callsTo(server.backend, "review.approve")).toHaveLength(1);

    // c3's answer lands in the cache: the next move needs no read.
    release();
    await act(async () => {
      await ahead;
    });
    expect(
      utils!.runs.getStep.getData({ runId: RUN, checkpointId: "c3" }),
    ).toBeDefined();
    expect(readsOf(server.backend, "c3")).toBe(1);
  });

  test("leaving the run marks its step reads stale; a remount on another of its steps does not", async () => {
    const server = runServer();
    const r = await openStep(server, "c2", ["c1", "c3"]);
    const invalidated = (id: string) =>
      queryClient!.getQueryState(stepKey(RUN, id))?.isInvalidated;

    // The route remounts the viewer on c3: still the run.
    r.rerender(viewer(server.backend, "c3"));
    await new Promise((res) => setTimeout(res, 1_200));
    expect(["c2", "c3"].map(invalidated)).toEqual([false, false]);

    // The reviewer leaves the run.
    const beforeLeaving = stepReads(server.backend).length;
    r.rerender(viewer(server.backend, null));
    await waitFor(
      () =>
        expect(["c2", "c3", "c4"].map(invalidated)).toEqual([true, true, true]),
      { timeout: 3_000 },
    );
    // Nothing was read for it meanwhile: marking the reads stale reads none.
    const reads = stepReads(server.backend).length;
    expect(reads).toBe(beforeLeaving);

    // Coming back reads the step again.
    r.rerender(viewer(server.backend, "c3"));
    await waitFor(() =>
      expect(stepReads(server.backend).length).toBeGreaterThan(reads),
    );
    expect(stepReads(server.backend).slice(reads)).toContain("c3");
  });

  test("a leave never outlives its test: the reset cancels its timer", async () => {
    const server = runServer();
    const r = await openStep(server, "c2", ["c1", "c3"]);
    const invalidated = (id: string) =>
      queryClient!.getQueryState(stepKey(RUN, id))?.isInvalidated;

    // Leaving the run starts its grace timer; the reset (as afterEach runs
    // it) cancels it, so the timer never fires, here or in a later test.
    r.rerender(viewer(server.backend, null));
    resetStepsLeftForTests();
    await new Promise((res) => setTimeout(res, 1_200));
    expect(["c1", "c2", "c3"].map(invalidated)).toEqual([false, false, false]);
  });
});

describe("a legacy step of a run of one step", () => {
  test("waits for the step list before it says anything about its diff", async () => {
    // Its images load (100×100); the viewer is in Diff mode.
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
    useViewerPrefs.setState({
      prefs: { ...DEFAULT_VIEWER_PREFS, mode: "diff" },
    });
    const server = runServer(["c1"], { legacy: true, diffPercent: null });
    const release = server.gate(`runs.listCheckpoints:${RUN}`);
    render(viewer(server.backend, "c1"));

    // The step's read is in; whether it may borrow the run's image is the
    // step count's to say, and that is still on its way.
    await waitFor(() => expect(readsOf(server.backend, "c1")).toBe(1));
    await act(async () => {
      await new Promise((res) => setTimeout(res, 50));
    });
    expect(ui.getByText("Loading…")).toBeDefined();
    expect(ui.queryByText(NO_CHANGES)).toBeNull();

    // Nothing was asked for the run's image meanwhile.
    const asked = () => vi.mocked(fetch).mock.calls.map(([url]) => String(url));
    expect(asked().some((u) => u.includes("run-diff"))).toBe(false);

    // The list lands: one step, so the run's image is the step's.
    release();
    await ui.findByText("os-c1");
    await waitFor(() =>
      expect(asked().some((u) => u.includes("run-diff"))).toBe(true),
    );
    await act(async () => {});
    expect(ui.queryByText(NO_CHANGES)).toBeNull();
  });
});
