import { randomFillSync } from "node:crypto";

import type { ApproveBuildPreview } from "@furan/shared-types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useCallback, useRef, type ReactNode } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The tRPC client is stubbed, not run through a fake fetch: this suite asserts
// *our* behaviour (what is patched, what is sent, what is shown), not tRPC's
// wire format. Each cache lives in one real QueryClient under the key shape
// tRPC uses, so the hook's own getQueryKey(runs.list) matches the seeded pages.
const qc = new QueryClient({
  defaultOptions: { queries: { gcTime: Infinity } },
});

const keyOf = (path: string[], input?: unknown) => [
  path,
  { input, type: "query" },
];

function procedureUtils(path: string[]) {
  return {
    cancel: vi.fn(async () => undefined),
    getData: vi.fn((input?: unknown) => qc.getQueryData(keyOf(path, input))),
    setData: vi.fn((input: unknown, updater: unknown) =>
      qc.setQueryData(keyOf(path, input), updater as never),
    ),
    invalidate: vi.fn(async () => undefined),
  };
}

const utils = {
  runs: {
    listCheckpoints: procedureUtils(["runs", "listCheckpoints"]),
    getById: procedureUtils(["runs", "getById"]),
    getStep: procedureUtils(["runs", "getStep"]),
    list: procedureUtils(["runs", "list"]),
    getCheckpointGroup: procedureUtils(["runs", "getCheckpointGroup"]),
    facets: procedureUtils(["runs", "facets"]),
  },
  builds: {
    getById: procedureUtils(["builds", "getById"]),
    list: procedureUtils(["builds", "list"]),
    pendingCount: procedureUtils(["builds", "pendingCount"]),
  },
  review: { next: procedureUtils(["review", "next"]) },
};

interface Lifecycle {
  onMutate?: (vars: unknown) => unknown;
  onSuccess?: (data: unknown, vars: unknown) => unknown;
  onError?: (err: unknown, vars: unknown) => unknown;
  onSettled?: (data: unknown, err: unknown, vars: unknown) => unknown;
}

// Hoisted because the vi.mock factory below runs before this file's own
// top-level code, and it builds the mutation hooks as soon as it runs.
const { server, mutationFor } = vi.hoisted(() => {
  // What the "server" answers, per procedure. Tests set a resolved value, a
  // rejection, or a deferred promise they settle by hand.
  const server = {
    approve: vi.fn(),
    reject: vi.fn(),
    approveGroup: vi.fn(),
    rejectGroup: vi.fn(),
    approveBuild: vi.fn(),
    revert: vi.fn(),
  };

  // The slice of TanStack's mutation lifecycle the hook relies on: onMutate,
  // the call, then onSuccess or onError, then onSettled.
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

  // Like TanStack's, `mutate` is the same function on every render and calls
  // the lifecycle of the latest one.
  const mutationFor = (name: keyof typeof server) => ({
    useMutation: (opts: Lifecycle) => {
      const latest = useRef(opts);
      latest.current = opts;
      const mutate = useCallback((vars: unknown) => {
        void runMutation(name, latest.current, vars);
      }, []);
      return { mutate, isPending: false };
    },
  });

  return { server, mutationFor };
});

vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => utils,
    runs: {
      list: { _def: () => ({ path: ["runs", "list"] }) },
      listCheckpoints: { _def: () => ({ path: ["runs", "listCheckpoints"] }) },
      getStep: { _def: () => ({ path: ["runs", "getStep"] }) },
    },
    review: {
      approve: mutationFor("approve"),
      reject: mutationFor("reject"),
      approveGroup: mutationFor("approveGroup"),
      rejectGroup: mutationFor("rejectGroup"),
      approveBuild: mutationFor("approveBuild"),
      revert: mutationFor("revert"),
    },
  },
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));
// The Undone toast's Go to navigates with the router, and is left out when
// the reviewer is already on that step: set `nav.pathname` per test.
const nav = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn() },
  pathname: "/projects/p-1/builds/build-1",
}));
vi.mock("next/navigation", () => ({
  useRouter: () => nav.router,
  usePathname: () => nav.pathname,
}));

import {
  useInFlightStore,
  useIsInFlight,
  useReviewMutations,
  type DecideArgs,
} from "../src/lib/review/use-review-mutations";
import { useUndoStore } from "../src/lib/review/use-undo-store";

const RUN = "run-1";
const RUN_2 = "run-2";
const BUILD = "build-1";
const A = "cp-a"; // unresolved, pending
const B = "cp-b"; // new, pending
const C = "cp-c"; // passed by the machine, not pending
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const review = (verdict: string, state = verdict) => ({
  verdict,
  state,
  decision: null,
  newerCapture: null,
});

interface Item {
  id: string;
  name: string;
  verdict: string;
  state: string;
  decision: { actionId: string; kind: string } | null;
}

const seedItems = (): Item[] => [
  { id: A, name: "home", ...review("unresolved") },
  { id: B, name: "pricing", ...review("new") },
  { id: C, name: "footer", ...review("passed") },
];

/**
 * The step list's decision, as `seedApproved` writes it, and the same one as
 * the step's own read has it (`runs.getStep`): who decided and when, too.
 */
const viewedDecision = (d: Item["decision"]) =>
  d && {
    id: `decision-${d.actionId}`,
    ...d,
    actor: { id: "user-2", name: "Grace" },
    at: "2026-10-10T00:00:00.000Z",
    source: "viewer",
    legacy: false,
    undo: { allowed: true },
  };

/** What `runs.getStep` carries for a step: its row, and its review in full. */
const stepOf = ({ id, name, verdict, state, decision }: Item) => ({
  step: { id, name },
  baselineContext: {
    baselineScreenshot: null,
    baselineSource: null,
    variationIgnoreAreas: null,
  },
  regions: [],
  review: { verdict, state, decision: viewedDecision(decision) },
  newerCapture: null,
});

/** Each of `items` read on its own (the viewer's step and its neighbours). */
function seedSteps(items: Item[]) {
  for (const i of items) {
    qc.setQueryData(
      keyOf(["runs", "getStep"], { runId: RUN, checkpointId: i.id }),
      stepOf(i),
    );
  }
}

/**
 * The caches a decision patches. `run` is the run header and each step read
 * on its own (the viewer's views of the run); `items` the step list.
 */
function seed(
  loaded: {
    items?: boolean;
    run?: boolean;
    list?: boolean;
    build?: boolean;
  } = {},
) {
  const { items = true, run = true, list = true, build = true } = loaded;
  if (items) {
    qc.setQueryData(keyOf(["runs", "listCheckpoints"], { runId: RUN }), {
      items: seedItems(),
    });
  }
  if (run) {
    qc.setQueryData(keyOf(["runs", "getById"], { runId: RUN }), {
      id: RUN,
      buildId: BUILD,
      status: "unresolved",
      statusOverride: null,
    });
    seedSteps(seedItems());
  }
  if (list) {
    qc.setQueryData(
      keyOf(["runs", "list"], { projectId: "p-1", buildId: BUILD }),
      {
        items: [
          {
            id: RUN,
            buildId: BUILD,
            status: "unresolved",
            statusOverride: null,
          },
          { id: RUN_2, buildId: BUILD, status: "failed", statusOverride: null },
        ],
        nextCursor: null,
      },
    );
  }
  if (build) {
    qc.setQueryData(keyOf(["builds", "getById"], { buildId: BUILD }), {
      id: BUILD,
      pendingCheckpoints: 5,
      approvableCheckpoints: 5,
    });
  }
}

/** The seed, with step A already approved under `actionId` in every cache. */
function seedApproved(actionId: string) {
  seed();
  const decision = { actionId, kind: "approved" };
  qc.setQueryData(keyOf(["runs", "listCheckpoints"], { runId: RUN }), {
    items: seedItems().map((i) =>
      i.id === A ? { ...i, state: "approved", decision } : i,
    ),
  });
  qc.setQueryData(keyOf(["runs", "getById"], { runId: RUN }), {
    id: RUN,
    buildId: BUILD,
    status: "new",
    statusOverride: null,
  });
  seedSteps(
    seedItems().map((i) =>
      i.id === A ? { ...i, state: "approved", decision } : i,
    ),
  );
  qc.setQueryData(
    keyOf(["runs", "list"], { projectId: "p-1", buildId: BUILD }),
    {
      items: [
        { id: RUN, buildId: BUILD, status: "new", statusOverride: null },
        { id: RUN_2, buildId: BUILD, status: "failed", statusOverride: null },
      ],
      nextCursor: null,
    },
  );
}

/**
 * Makes the patch's read of the run header throw, once: after it has patched
 * the step list and the steps' own reads, before the header and the rest.
 */
function breakNextPatchRead() {
  utils.runs.getById.getData.mockImplementationOnce(() => {
    throw new TypeError("a broken cache");
  });
}

const itemsCache = () =>
  qc.getQueryData<{ items: Item[] }>(
    keyOf(["runs", "listCheckpoints"], { runId: RUN }),
  )?.items;
const runCache = () =>
  qc.getQueryData<{ status: string }>(
    keyOf(["runs", "getById"], { runId: RUN }),
  );
/** Step `id` of the run, as its own read (`runs.getStep`) holds it. */
const stepCache = (id: string) =>
  qc.getQueryData<{
    review: Pick<Item, "verdict" | "state"> & {
      decision: { actionId: string; kind: string } | null;
    };
  }>(keyOf(["runs", "getStep"], { runId: RUN, checkpointId: id }));
const listRows = () =>
  qc.getQueryData<{ items: Array<{ id: string; status: string }> }>(
    keyOf(["runs", "list"], { projectId: "p-1", buildId: BUILD }),
  )?.items;
const buildCache = () =>
  qc.getQueryData<{
    pendingCheckpoints: number;
    approvableCheckpoints: number;
  }>(keyOf(["builds", "getById"], { buildId: BUILD }));
const itemState = (id: string) => itemsCache()?.find((i) => i.id === id)?.state;

function snapshotCaches() {
  return structuredClone({
    items: itemsCache(),
    run: runCache(),
    steps: [A, B, C].map(stepCache),
    rows: listRows(),
    build: buildCache(),
  });
}

function deferred<T = unknown>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// One step decided by default: an action that decided nothing has nothing to
// undo, and the tests for that case say so explicitly.
const decided = (runs: string[] = [RUN]) => ({
  actionId: "server-echo",
  decided: [{ checkpointId: A, runId: runs[0] ?? RUN, state: "approved" }],
  runs: runs.map((runId) => ({ runId, status: "passed" })),
  replayed: false,
  capped: false,
  cap: 500,
});

const reverted = (over: Record<string, unknown> = {}) => ({
  actionId: "x",
  reverted: 1,
  skipped: [],
  runs: [],
  ...over,
});

const trpcError = (message: string, code: string, details?: unknown) => ({
  message,
  data: { code, details },
});

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={qc}>{children}</QueryClientProvider>
);

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function setup() {
  const hook = renderHook(() => useReviewMutations(), { wrapper });
  /** Run `fn` and let every promise it started settle, inside act. */
  const run = async (fn: () => void = () => undefined) => {
    await act(async () => {
      fn();
      await flush();
    });
  };
  return { ...hook, run };
}

/** The Undo action handed to the last success toast. */
function toastAction() {
  const call = vi.mocked(toast.success).mock.calls.at(-1);
  const options = call?.[1] as
    | { action: { label: string; onClick: () => void }; duration: number }
    | undefined;
  if (!options) throw new Error("no success toast with options");
  return options;
}

const sentActionId = (mock: ReturnType<typeof vi.fn>, call = 0): string =>
  (mock.mock.calls[call]?.[0] as { actionId: string }).actionId;

beforeEach(() => {
  qc.clear();
  vi.clearAllMocks();
  for (const fn of Object.values(server)) fn.mockReset();
  server.approve.mockResolvedValue(decided());
  server.reject.mockResolvedValue(decided());
  server.approveGroup.mockResolvedValue(decided());
  server.rejectGroup.mockResolvedValue(decided());
  server.approveBuild.mockResolvedValue(decided([RUN, RUN_2]));
  server.revert.mockResolvedValue(reverted());
  useUndoStore.setState({ stack: [] });
  useInFlightStore.setState({ ids: new Set(), decisions: new Set() });
  nav.router.push.mockReset();
  nav.pathname = "/projects/p-1/builds/build-1";
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useReviewMutations: identity", () => {
  // The batch page memoizes its step cards on `decide` and `undo`, so a card
  // is redrawn for its own step only if these never change.
  it("hands out the very same callbacks on every render", () => {
    const { result, rerender } = setup();
    const first = result.current;

    rerender();

    expect(result.current.decide).toBe(first.decide);
    expect(result.current.undo).toBe(first.undo);
    expect(result.current.decideGroup).toBe(first.decideGroup);
    expect(result.current.approveBuild).toBe(first.approveBuild);
  });

  it("keeps them when what is in flight changes, which does redraw the hook", () => {
    const { result } = setup();
    const first = result.current;

    act(() => useInFlightStore.getState().hold([A]));
    expect(result.current.isInFlight(A)).toBe(true);

    expect(result.current.decide).toBe(first.decide);
    expect(result.current.undo).toBe(first.undo);
    expect(result.current.decideGroup).toBe(first.decideGroup);
    expect(result.current.approveBuild).toBe(first.approveBuild);
    act(() => useInFlightStore.getState().release([A]));
  });
});

describe("useReviewMutations: optimistic decide", () => {
  it("patches every loaded cache before the server answers", async () => {
    seed();
    const pending = deferred();
    server.approve.mockReturnValueOnce(pending.promise);
    const cancelSteps = vi.spyOn(qc, "cancelQueries");
    const { result, run } = setup();

    await run(() =>
      result.current.decide({
        runId: RUN,
        checkpointIds: [A],
        kind: "approved",
        label: "Approved home",
      }),
    );

    // The call is out, nothing has come back, and the screen already shows it.
    expect(server.approve).toHaveBeenCalledTimes(1);
    expect(toast.success).not.toHaveBeenCalled();
    expect(itemsCache()?.find((i) => i.id === A)).toMatchObject({
      state: "approved",
      decision: { kind: "approved" },
    });
    expect(itemState(B)).toBe("new");
    // The step's own read shows the decision in full, as the chip draws it.
    expect(stepCache(A)?.review).toMatchObject({
      state: "approved",
      decision: {
        id: expect.stringMatching(/^optimistic:/) as string,
        kind: "approved",
        actor: { id: "", name: "You" },
        undo: { allowed: true },
      },
    });
    expect(stepCache(B)?.review).toMatchObject({ state: "new" });
    // A was the only unresolved step: the run is now "new" (B), not unresolved.
    expect(runCache()?.status).toBe("new");
    expect(listRows()?.find((r) => r.id === RUN)?.status).toBe("new");
    expect(listRows()?.find((r) => r.id === RUN_2)?.status).toBe("failed");
    expect(buildCache()?.pendingCheckpoints).toBe(4);
    // The approve button's count moves with it.
    expect(buildCache()?.approvableCheckpoints).toBe(4);
    expect(utils.runs.listCheckpoints.cancel).toHaveBeenCalledWith({
      runId: RUN,
    });
    expect(utils.runs.getById.cancel).toHaveBeenCalledWith({ runId: RUN });
    expect(cancelSteps).toHaveBeenCalledWith({
      queryKey: keyOf(["runs", "getStep"], { runId: RUN }),
    });
    cancelSteps.mockRestore();

    pending.resolve(decided());
    await run();
  });

  it("sends the explicit ids with a fresh action id and the optimistic actor", async () => {
    seed();
    const { result, run } = setup();

    await run(() =>
      result.current.decide({
        runId: RUN,
        checkpointIds: [A],
        kind: "approved",
        label: "Approved home",
      }),
    );

    expect(server.approve).toHaveBeenCalledWith({
      runId: RUN,
      checkpointIds: [A],
      actionId: expect.stringMatching(UUID_V4) as string,
    });
  });

  it("targets every pending step when no ids are given", async () => {
    seed();
    const pending = deferred();
    server.approve.mockReturnValueOnce(pending.promise);
    const { result, run } = setup();

    await run(() =>
      result.current.decide({
        runId: RUN,
        kind: "approved",
        label: "Approved 2",
      }),
    );

    expect(server.approve.mock.calls[0]?.[0]).not.toHaveProperty(
      "checkpointIds",
    );
    expect(itemState(A)).toBe("approved");
    expect(itemState(B)).toBe("approved");
    expect(itemState(C)).toBe("passed");
    expect(runCache()?.status).toBe("passed");
    expect(buildCache()?.pendingCheckpoints).toBe(3);

    pending.resolve(decided());
    await run();
  });

  it("rejects through review.reject and passes the reason along", async () => {
    seed();
    const { result, run } = setup();

    await run(() =>
      result.current.decide({
        runId: RUN,
        checkpointIds: [A],
        kind: "rejected",
        label: "Rejected home",
        reason: "wrong colour",
      }),
    );

    expect(server.approve).not.toHaveBeenCalled();
    expect(server.reject).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: RUN,
        checkpointIds: [A],
        reason: "wrong colour",
      }),
    );
  });

  it("passes ignore areas to review.approve", async () => {
    seed();
    const { result, run } = setup();
    const ignoreAreas = [{ id: "r1" }];

    await run(() =>
      result.current.decide({
        runId: RUN,
        checkpointIds: [A],
        kind: "approved",
        label: "Approved home",
        ignoreAreas: ignoreAreas as never,
      }),
    );

    expect(server.approve).toHaveBeenCalledWith(
      expect.objectContaining({ ignoreAreas }),
    );
  });

  it("patches only loaded caches", async () => {
    seed({ run: false });
    const { result, run } = setup();

    await run(() =>
      result.current.decide({
        runId: RUN,
        checkpointIds: [A],
        kind: "approved",
        label: "Approved home",
      }),
    );

    expect(utils.runs.getById.getData).toHaveBeenCalled();
    expect(utils.runs.getById.setData).not.toHaveBeenCalled();
    expect(utils.runs.listCheckpoints.setData).toHaveBeenCalled();
    expect(server.approve).toHaveBeenCalledTimes(1);
  });

  it("patches a step's own read without the step list, and moves the build's count by it", async () => {
    seed({ items: false });
    const pending = deferred();
    server.approve.mockReturnValueOnce(pending.promise);
    const { result, run } = setup();

    await run(() =>
      result.current.decide({
        runId: RUN,
        checkpointIds: [A],
        kind: "approved",
        label: "Approved home",
      }),
    );

    expect(stepCache(A)?.review).toMatchObject({
      state: "approved",
      decision: { kind: "approved" },
    });
    expect(stepCache(B)?.review).toMatchObject({ state: "new" });
    // With no step list there is no rollup to take: the header keeps its
    // status until the refetch.
    expect(runCache()?.status).toBe("unresolved");
    expect(buildCache()?.pendingCheckpoints).toBe(4);

    pending.resolve(decided());
    await run();
  });

  it("patches nothing, and still sends the call, when no cache is loaded", async () => {
    const { result, run } = setup();

    await run(() =>
      result.current.decide({
        runId: RUN,
        kind: "approved",
        label: "Approved",
      }),
    );

    expect(utils.runs.listCheckpoints.setData).not.toHaveBeenCalled();
    expect(utils.runs.getById.setData).not.toHaveBeenCalled();
    expect(utils.builds.getById.setData).not.toHaveBeenCalled();
    expect(server.approve).toHaveBeenCalledTimes(1);
  });

  it("finds the build through the run list when the run is not loaded", async () => {
    seed({ run: false });
    const pending = deferred();
    server.approve.mockReturnValueOnce(pending.promise);
    const { result, run } = setup();

    await run(() =>
      result.current.decide({
        runId: RUN,
        checkpointIds: [A],
        kind: "approved",
        label: "Approved home",
      }),
    );

    expect(buildCache()?.pendingCheckpoints).toBe(4);
    expect(listRows()?.find((r) => r.id === RUN)?.status).toBe("new");

    pending.resolve(decided());
    await run();
  });

  it("never lets a broken cache stop the call or leave a half patch behind, and says so outside production", async () => {
    seed();
    const before = snapshotCaches();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    breakNextPatchRead();
    const { result, run } = setup();

    await run(() =>
      result.current.decide({
        runId: RUN,
        checkpointIds: [A],
        kind: "approved",
        label: "Approved home",
      }),
    );

    expect(server.approve).toHaveBeenCalledTimes(1);
    expect(itemsCache()).toEqual(before.items);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("optimistic patch failed"),
      expect.any(TypeError),
    );
    warn.mockRestore();
  });

  it("stays quiet about a broken patch in production", async () => {
    seed();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubEnv("NODE_ENV", "production");
    breakNextPatchRead();
    const { result, run } = setup();

    await run(() =>
      result.current.decide({
        runId: RUN,
        checkpointIds: [A],
        kind: "approved",
        label: "Approved home",
      }),
    );

    expect(server.approve).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
    vi.unstubAllEnvs();
  });

  it("waits for the running fetches to be cancelled before it patches or calls", async () => {
    seed();
    const cancelled = deferred<undefined>();
    utils.runs.listCheckpoints.cancel.mockReturnValueOnce(cancelled.promise);
    const { result, run } = setup();

    await run(() =>
      result.current.decide({
        runId: RUN,
        checkpointIds: [A],
        kind: "approved",
        label: "Approved home",
      }),
    );

    // The cancel has not resolved: nothing is written, and nothing is sent.
    expect(utils.runs.listCheckpoints.cancel).toHaveBeenCalledTimes(1);
    expect(utils.runs.listCheckpoints.setData).not.toHaveBeenCalled();
    expect(utils.runs.getById.setData).not.toHaveBeenCalled();
    expect(itemState(A)).toBe("unresolved");
    expect(server.approve).not.toHaveBeenCalled();

    cancelled.resolve(undefined);
    await run();

    expect(utils.runs.listCheckpoints.setData).toHaveBeenCalledTimes(1);
    expect(itemState(A)).toBe("approved");
    expect(server.approve).toHaveBeenCalledTimes(1);
  });

  it("writes nothing when the patch reaches nothing", async () => {
    seed({ items: false });
    const setQueryData = vi.spyOn(qc, "setQueryData");
    const { result, run } = setup();

    // No ids and no loaded checkpoint list: there is nothing to target.
    await run(() =>
      result.current.decide({
        runId: RUN,
        kind: "approved",
        label: "Approved",
      }),
    );

    expect(server.approve).toHaveBeenCalledTimes(1);
    expect(utils.runs.getById.setData).not.toHaveBeenCalled();
    expect(utils.builds.getById.setData).not.toHaveBeenCalled();
    expect(setQueryData).not.toHaveBeenCalled();
    setQueryData.mockRestore();
  });

  it("refreshes the review caches once the call settles", async () => {
    seed();
    const { result, run } = setup();

    await run(() =>
      result.current.decide({
        runId: RUN,
        checkpointIds: [A],
        kind: "approved",
        label: "Approved home",
      }),
    );

    expect(utils.runs.listCheckpoints.invalidate).toHaveBeenCalled();
    expect(utils.runs.getById.invalidate).toHaveBeenCalled();
    // Every step read: the one on screen and the neighbours fetched ahead.
    expect(utils.runs.getStep.invalidate).toHaveBeenCalledWith();
    expect(utils.runs.list.invalidate).toHaveBeenCalled();
    expect(utils.builds.getById.invalidate).toHaveBeenCalled();
  });

  it("refreshes the Batches list, the sidebar badge and the loop counts after a decision", async () => {
    seed();
    const { result, run } = setup();

    await run(() =>
      result.current.decide({
        runId: RUN,
        checkpointIds: [A],
        kind: "approved",
        label: "Approved home",
      }),
    );

    expect(utils.builds.list.invalidate).toHaveBeenCalled();
    expect(utils.builds.pendingCount.invalidate).toHaveBeenCalled();
    expect(utils.review.next.invalidate).toHaveBeenCalled();
  });

  it("refreshes the batch page's environment filter counts after a decision and after an undo", async () => {
    seed();
    const { result, run } = setup();

    await run(() =>
      result.current.decide({
        runId: RUN,
        checkpointIds: [A],
        kind: "approved",
        label: "Approved home",
      }),
    );
    expect(utils.runs.facets.invalidate).toHaveBeenCalled();

    utils.runs.facets.invalidate.mockClear();
    await run(() => toastAction().action.onClick());
    expect(utils.runs.facets.invalidate).toHaveBeenCalled();
  });

  it("refreshes the Batches list, the sidebar badge and the loop counts after an undo", async () => {
    seed();
    const { result, run } = setup();
    await run(() =>
      result.current.decide({
        runId: RUN,
        checkpointIds: [A],
        kind: "approved",
        label: "Approved home",
      }),
    );
    utils.builds.list.invalidate.mockClear();
    utils.builds.pendingCount.invalidate.mockClear();
    utils.review.next.invalidate.mockClear();

    await run(() => toastAction().action.onClick());

    expect(server.revert).toHaveBeenCalledTimes(1);
    expect(utils.builds.list.invalidate).toHaveBeenCalled();
    expect(utils.builds.pendingCount.invalidate).toHaveBeenCalled();
    expect(utils.review.next.invalidate).toHaveBeenCalled();
  });

  it("refreshes the similar-steps group too, so its callout stops offering what was decided", async () => {
    seed();
    const { result, run } = setup();

    await run(() =>
      result.current.decideGroup({
        runId: RUN,
        checkpointId: A,
        kind: "approved",
        label: "Approved 3 similar steps",
      }),
    );

    expect(utils.runs.getCheckpointGroup.invalidate).toHaveBeenCalled();
  });
});

describe("useReviewMutations: rollback of overlapping decides", () => {
  const decideStep = (
    result: { current: ReturnType<typeof useReviewMutations> },
    id: string,
  ) =>
    result.current.decide({
      runId: RUN,
      checkpointIds: [id],
      kind: "approved",
      label: `Approved ${id}`,
    });

  it("undoes only the failed decide's patch, each time, whichever fails first", async () => {
    seed();
    const before = snapshotCaches();
    const callA = deferred();
    const callB = deferred();
    server.approve
      .mockReturnValueOnce(callA.promise)
      .mockReturnValueOnce(callB.promise);
    const { result, run } = setup();

    await run(() => decideStep(result, A));
    await run(() => decideStep(result, B));
    expect(itemState(A)).toBe("approved");
    expect(itemState(B)).toBe("approved");
    expect(runCache()?.status).toBe("passed");
    expect(buildCache()?.pendingCheckpoints).toBe(3);

    // A is refused: B's approval is still on screen, A's is gone.
    callA.reject(
      trpcError("run_overridden", "PRECONDITION_FAILED", {
        reasons: [{ checkpointId: A, reason: "run_overridden" }],
      }),
    );
    await run();
    expect(itemState(A)).toBe("unresolved");
    expect(itemsCache()?.find((i) => i.id === A)?.decision).toBeNull();
    expect(itemState(B)).toBe("approved");
    expect(stepCache(A)?.review).toMatchObject({
      state: "unresolved",
    });
    expect(stepCache(B)?.review).toMatchObject({
      state: "approved",
    });
    expect(runCache()?.status).toBe("unresolved");
    expect(listRows()?.find((r) => r.id === RUN)?.status).toBe("unresolved");
    expect(buildCache()?.pendingCheckpoints).toBe(4);

    // Then B is refused: neither shows as decided, as before either call.
    callB.reject(new Error("offline"));
    await run();
    expect(snapshotCaches()).toEqual(before);
  });

  it("does not bring a refused decide back when the other one fails later", async () => {
    seed();
    const callA = deferred();
    const callB = deferred();
    server.approve
      .mockReturnValueOnce(callA.promise)
      .mockReturnValueOnce(callB.promise);
    const { result, run } = setup();

    await run(() => decideStep(result, A));
    await run(() => decideStep(result, B));

    // B fails first: A stays approved on screen while its own call is out.
    callB.reject(new Error("offline"));
    await run();
    expect(itemState(B)).toBe("new");
    expect(itemState(A)).toBe("approved");

    callA.resolve(decided());
    await run();
    expect(itemState(A)).toBe("approved");
    expect(toast.success).toHaveBeenCalledTimes(1);
  });
});

describe("useReviewMutations: in flight", () => {
  it("ignores a second decide on an in-flight checkpoint", async () => {
    seed();
    const first = deferred();
    server.approve.mockReturnValueOnce(first.promise);
    const { result, run } = setup();
    const args: DecideArgs = {
      runId: RUN,
      checkpointIds: [A],
      kind: "approved",
      label: "Approved home",
    };

    await run(() => result.current.decide(args));
    expect(result.current.isInFlight(A)).toBe(true);
    expect(result.current.isInFlight(B)).toBe(false);

    await run(() => result.current.decide(args));
    await run(() => result.current.decide({ ...args, kind: "rejected" }));
    expect(server.approve).toHaveBeenCalledTimes(1);
    expect(server.reject).not.toHaveBeenCalled();

    // Another step is free to go.
    await run(() => result.current.decide({ ...args, checkpointIds: [B] }));
    expect(server.approve).toHaveBeenCalledTimes(2);

    first.resolve(decided());
    await run();
    expect(result.current.isInFlight(A)).toBe(false);

    await run(() => result.current.decide(args));
    expect(server.approve).toHaveBeenCalledTimes(3);
  });

  it("ignores a decide with no ids while one of the pending steps is in flight", async () => {
    seed();
    const first = deferred();
    server.approve.mockReturnValueOnce(first.promise);
    const { result, run } = setup();

    await run(() =>
      result.current.decide({
        runId: RUN,
        checkpointIds: [B],
        kind: "approved",
        label: "Approved pricing",
      }),
    );
    await run(() =>
      result.current.decide({
        runId: RUN,
        kind: "approved",
        label: "Approved 2",
      }),
    );

    expect(server.approve).toHaveBeenCalledTimes(1);
    first.resolve(decided());
    await run();
  });

  it("ignores a second run-wide decide, whose targets the first already patched", async () => {
    seed();
    const first = deferred();
    server.approve.mockReturnValueOnce(first.promise);
    const { result, run } = setup();
    const all = { runId: RUN, kind: "approved", label: "Approved 2" } as const;

    await run(() => result.current.decide(all));
    // Both pending steps now read as approved, so nothing is left to target.
    expect(itemState(A)).toBe("approved");
    await run(() => result.current.decide(all));

    expect(server.approve).toHaveBeenCalledTimes(1);
    first.resolve(decided());
    await run();
    expect(result.current.isInFlight(A)).toBe(false);
  });

  it("tells a card about its own checkpoint only", async () => {
    seed();
    const first = deferred();
    server.approve.mockReturnValueOnce(first.promise);
    let renders = 0;
    const card = renderHook(
      () => {
        renders += 1;
        return useIsInFlight(C);
      },
      { wrapper },
    );
    const { result, run } = setup();
    const rendersBefore = renders;

    await run(() =>
      result.current.decide({
        runId: RUN,
        checkpointIds: [A],
        kind: "approved",
        label: "Approved home",
      }),
    );

    // A is in flight; the card for C neither says so nor re-renders for it.
    expect(useInFlightStore.getState().ids.has(A)).toBe(true);
    expect(card.result.current).toBe(false);
    expect(renders).toBe(rendersBefore);

    const forA = renderHook(() => useIsInFlight(A), { wrapper });
    expect(forA.result.current).toBe(true);

    first.resolve(decided());
    await run();
    expect(forA.result.current).toBe(false);
  });

  it("a refused decision stops being one before its rollback lands, and stays held until it settles", async () => {
    // The review loop takes the step reading pending again for an undo only
    // when no decision on it is in flight (R30, R36): so the refusal must be
    // known before the rollback writes the step back, whatever order React
    // renders the two in.
    seed();
    const refusal = deferred();
    server.approve.mockReturnValueOnce(refusal.promise);
    const { result, run } = setup();
    await run(() =>
      result.current.decide({
        runId: RUN,
        checkpointIds: [A],
        kind: "approved",
        label: "Approved home",
      }),
    );
    expect(useInFlightStore.getState().decisions.has(A)).toBe(true);
    // What the store says when the rollback writes the step list.
    const seen: Array<{ decision: boolean; held: boolean }> = [];
    utils.runs.listCheckpoints.setData.mockImplementationOnce(
      (input: unknown, updater: unknown) => {
        const { ids, decisions } = useInFlightStore.getState();
        seen.push({ decision: decisions.has(A), held: ids.has(A) });
        return qc.setQueryData(
          keyOf(["runs", "listCheckpoints"], input),
          updater as never,
        );
      },
    );

    refusal.reject(trpcError("already_decided", "CONFLICT"));
    await run();

    expect(seen).toEqual([{ decision: false, held: true }]);
    expect(itemState(A)).toBe("unresolved");
    expect(useInFlightStore.getState().ids.has(A)).toBe(false);
  });

  it("frees the checkpoint again after a failure", async () => {
    seed();
    server.approve.mockRejectedValueOnce(
      trpcError("INTERNAL", "INTERNAL_SERVER_ERROR"),
    );
    const { result, run } = setup();

    await run(() =>
      result.current.decide({
        runId: RUN,
        checkpointIds: [A],
        kind: "approved",
        label: "Approved home",
      }),
    );

    expect(result.current.isInFlight(A)).toBe(false);
  });
});

describe("useReviewMutations: success", () => {
  it("toasts the label with an Undo action and remembers it for undo", async () => {
    seed();
    const { result, run } = setup();

    await run(() =>
      result.current.decide({
        runId: RUN,
        checkpointIds: [A],
        kind: "approved",
        label: "Approved home",
      }),
    );

    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast.success).mock.calls[0]?.[0]).toBe("Approved home");
    expect(toastAction().action.label).toBe("Undo");
    expect(toastAction().duration).toBe(10_000);
    expect(useUndoStore.getState().stack).toEqual([
      {
        actionId: sentActionId(server.approve),
        label: "Approved home",
        runIds: [RUN],
      },
    ]);
  });

  it("evaluates a function label on the server's result, for the toast and for the undo entry", async () => {
    seed();
    server.approve.mockResolvedValueOnce({
      ...decided(),
      decided: [
        { checkpointId: A, runId: RUN, state: "approved" },
        { checkpointId: B, runId: RUN, state: "approved" },
      ],
    });
    const label = vi.fn(
      (r: { decided: unknown[] }) => `Approved ${r.decided.length} steps`,
    );
    const { result, run } = setup();

    await run(() =>
      result.current.decide({
        runId: RUN,
        kind: "approved",
        label: label as DecideArgs["label"],
      }),
    );

    expect(label).toHaveBeenCalledTimes(1);
    expect(label.mock.calls[0]?.[0]).toMatchObject({
      actionId: "server-echo",
      decided: [{ checkpointId: A }, { checkpointId: B }],
    });
    expect(vi.mocked(toast.success).mock.calls[0]?.[0]).toBe(
      "Approved 2 steps",
    );
    expect(useUndoStore.getState().stack).toEqual([
      {
        actionId: sentActionId(server.approve),
        label: "Approved 2 steps",
        runIds: [RUN],
      },
    ]);
  });

  // M4: an action that decided nothing (an empty action, or a replay of one)
  // has nothing to undo: no undo entry, no Undo button, an info toast.
  it.each([
    ["approved", "Nothing left to approve"],
    ["rejected", "Nothing left to reject"],
  ] as const)(
    "an action that decided nothing (%s) says so, with nothing to undo",
    async (kind, message) => {
      seed();
      const mock = kind === "approved" ? server.approve : server.reject;
      mock.mockResolvedValueOnce({ ...decided(), decided: [] });
      const { result, run } = setup();

      await run(() =>
        result.current.decide({
          runId: RUN,
          kind,
          label: (r) => `Decided ${r.decided.length} steps`,
        }),
      );

      expect(toast.success).not.toHaveBeenCalled();
      expect(toast.info).toHaveBeenCalledTimes(1);
      expect(vi.mocked(toast.info).mock.calls[0]).toEqual([message]);
      expect(useUndoStore.getState().stack).toEqual([]);
    },
  );

  it("a build approval that decided nothing still ends the call for its caller", async () => {
    seed();
    server.approveBuild.mockResolvedValueOnce({
      ...decided([]),
      decided: [],
    });
    const onSuccess = vi.fn();
    const { result, run } = setup();

    await run(() =>
      result.current.approveBuild({
        buildId: BUILD,
        expectedCount: 0,
        label: "Approved",
        onConflict: vi.fn(),
        onSuccess,
      }),
    );

    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(toast.info).toHaveBeenCalledWith("Nothing left to approve");
    expect(useUndoStore.getState().stack).toEqual([]);
  });

  describe("a label function that throws", () => {
    const boom = () => {
      throw new Error("label bug");
    };

    it("cannot turn a committed decision into an error: the toast, its Undo and the undo entry stay, worded plainly", async () => {
      seed();
      const warn = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);
      const { result, run } = setup();

      await run(() =>
        result.current.decide({
          runId: RUN,
          checkpointIds: [A],
          kind: "approved",
          label: boom,
        }),
      );

      expect(toast.error).not.toHaveBeenCalled();
      expect(vi.mocked(toast.success).mock.calls[0]?.[0]).toBe("Approved");
      expect(toastAction().action.label).toBe("Undo");
      expect(useUndoStore.getState().stack).toEqual([
        {
          actionId: sentActionId(server.approve),
          label: "Approved",
          runIds: [RUN],
        },
      ]);
      // The decision stands: it was not rolled back as a failure.
      expect(
        (itemsCache() as { id: string; state: string }[]).find(
          (i) => i.id === A,
        )?.state,
      ).toBe("approved");
      // And the bug is not hidden outside production.
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("label"),
        expect.any(Error),
      );
      warn.mockRestore();
    });

    it("words a rejection plainly", async () => {
      seed();
      const warn = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);
      const { result, run } = setup();

      await run(() =>
        result.current.decide({
          runId: RUN,
          checkpointIds: [A],
          kind: "rejected",
          label: boom,
        }),
      );

      expect(vi.mocked(toast.success).mock.calls[0]?.[0]).toBe("Rejected");
      warn.mockRestore();
    });

    it("still tells the caller of a build approval that it succeeded", async () => {
      seed();
      const warn = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);
      const onSuccess = vi.fn();
      const onSettled = vi.fn();
      const { result, run } = setup();

      await run(() =>
        result.current.approveBuild({
          buildId: BUILD,
          expectedCount: 5,
          label: boom,
          onConflict: vi.fn(),
          onSuccess,
          onSettled,
        }),
      );

      expect(toast.error).not.toHaveBeenCalled();
      expect(vi.mocked(toast.success).mock.calls[0]?.[0]).toBe("Approved");
      expect(onSuccess).toHaveBeenCalledTimes(1);
      expect(onSettled).toHaveBeenCalledTimes(1);
      warn.mockRestore();
    });

    it("words a group rejection plainly", async () => {
      seed();
      const warn = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);
      const { result, run } = setup();

      await run(() =>
        result.current.decideGroup({
          runId: RUN,
          checkpointId: A,
          kind: "rejected",
          label: boom,
        }),
      );

      expect(vi.mocked(toast.success).mock.calls[0]?.[0]).toBe("Rejected");
      expect(useUndoStore.getState().stack[0]?.label).toBe("Rejected");
      warn.mockRestore();
    });
  });

  it("does not evaluate a function label when the call fails", async () => {
    seed();
    server.approve.mockRejectedValueOnce(new Error("offline"));
    const label = vi.fn(() => "never");
    const { result, run } = setup();

    await run(() =>
      result.current.decide({
        runId: RUN,
        checkpointIds: [A],
        kind: "approved",
        label,
      }),
    );

    expect(label).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("calls review.revert with the same action id when Undo is clicked", async () => {
    seed();
    const { result, run } = setup();
    await run(() =>
      result.current.decide({
        runId: RUN,
        checkpointIds: [A],
        kind: "approved",
        label: "Approved home",
      }),
    );

    await run(() => toastAction().action.onClick());

    expect(server.revert).toHaveBeenCalledTimes(1);
    expect(server.revert).toHaveBeenCalledWith({
      actionId: sentActionId(server.approve),
    });
  });

  it("makes an action id even where crypto.randomUUID is unavailable", async () => {
    vi.stubGlobal("crypto", {
      getRandomValues: (array: Uint8Array) => randomFillSync(array),
    });
    seed();
    const { result, run } = setup();

    await run(() =>
      result.current.decide({
        runId: RUN,
        checkpointIds: [A],
        kind: "approved",
        label: "Approved home",
      }),
    );

    expect(sentActionId(server.approve)).toMatch(UUID_V4);
  });
});

describe("useReviewMutations: errors", () => {
  const decideA = (result: {
    current: ReturnType<typeof useReviewMutations>;
  }) =>
    result.current.decide({
      runId: RUN,
      checkpointIds: [A],
      kind: "approved",
      label: "Approved home",
    });

  it("rolls every patched cache back and names the winner on already_decided", async () => {
    seed();
    const before = snapshotCaches();
    server.approve.mockRejectedValueOnce(
      trpcError("already_decided", "CONFLICT", {
        reasons: [{ checkpointId: A, reason: "already_decided" }],
        winner: { checkpointId: A, kind: "rejected", actorName: "Grace" },
      }),
    );
    const { result, run } = setup();

    await run(() => decideA(result));

    expect(toast.error).toHaveBeenCalledWith("Grace already rejected home");
    expect(snapshotCaches()).toEqual(before);
    expect(toast.success).not.toHaveBeenCalled();
    expect(useUndoStore.getState().stack).toEqual([]);
  });

  it("keeps a decision the cache already showed when the decide is refused as already_decided", async () => {
    const PRIOR = "55555555-5555-4555-8555-555555555555";
    seedApproved(PRIOR);
    const before = snapshotCaches();
    server.reject.mockRejectedValueOnce(
      trpcError("already_decided", "CONFLICT", {
        reasons: [{ checkpointId: A, reason: "already_decided" }],
        winner: { checkpointId: A, kind: "approved", actorName: "Grace" },
      }),
    );
    const { result, run } = setup();

    await run(() =>
      result.current.decide({
        runId: RUN,
        checkpointIds: [A],
        kind: "rejected",
        label: "Rejected home",
      }),
    );

    // The step still shows the approval it had, not a blank "unresolved".
    expect(itemState(A)).toBe("approved");
    expect(itemsCache()?.find((i) => i.id === A)?.decision).toMatchObject({
      actionId: PRIOR,
      kind: "approved",
    });
    expect(stepCache(A)?.review).toMatchObject({
      state: "approved",
      decision: { actionId: PRIOR },
    });
    expect(snapshotCaches()).toEqual(before);
  });

  it("falls back to the refusal text when the server names no winner", async () => {
    seed();
    server.approve.mockRejectedValueOnce(
      trpcError("already_decided", "CONFLICT", {
        reasons: [{ checkpointId: A, reason: "already_decided" }],
      }),
    );
    const { result, run } = setup();

    await run(() => decideA(result));

    expect(toast.error).toHaveBeenCalledWith("Already decided — undo it first");
  });

  it("falls back to plain words when the winner or step name is unknown", async () => {
    seed();
    server.approve.mockRejectedValueOnce(
      trpcError("already_decided", "CONFLICT", {
        winner: {
          checkpointId: "elsewhere",
          kind: "approved",
          actorName: null,
        },
      }),
    );
    const { result, run } = setup();

    await run(() => decideA(result));

    expect(toast.error).toHaveBeenCalledWith(
      "Someone already approved this step",
    );
  });

  it("explains a refusal in plain English on PRECONDITION_FAILED", async () => {
    seed();
    const before = snapshotCaches();
    server.approve.mockRejectedValueOnce(
      trpcError("run_overridden", "PRECONDITION_FAILED", {
        reasons: [{ checkpointId: A, reason: "run_overridden" }],
      }),
    );
    const { result, run } = setup();

    await run(() => decideA(result));

    expect(toast.error).toHaveBeenCalledWith(
      "Clear the run override to review steps",
    );
    expect(snapshotCaches()).toEqual(before);
  });

  it("shows one generic message for anything else", async () => {
    seed();
    const before = snapshotCaches();
    server.approve.mockRejectedValueOnce(new Error("socket hang up"));
    const { result, run } = setup();

    await run(() => decideA(result));

    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't save your review. Try again.",
    );
    expect(snapshotCaches()).toEqual(before);
  });

  it("does not trust an unknown refusal word", async () => {
    seed();
    server.approve.mockRejectedValueOnce(
      trpcError("something_new", "PRECONDITION_FAILED"),
    );
    const { result, run } = setup();

    await run(() => decideA(result));

    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't save your review. Try again.",
    );
  });
});

describe("useReviewMutations: undo", () => {
  const ACTION = "33333333-3333-4333-8333-333333333333";
  const OLDER = "44444444-4444-4444-8444-444444444444";

  function seedDecided() {
    seedApproved(ACTION);
    useUndoStore
      .getState()
      .push({ actionId: ACTION, label: "Approved home", runIds: [RUN] });
  }

  it("takes the newest entry when called without an id", async () => {
    useUndoStore
      .getState()
      .push({ actionId: OLDER, label: "Older", runIds: [RUN] });
    useUndoStore
      .getState()
      .push({ actionId: ACTION, label: "Newest", runIds: [RUN] });
    const { result, run } = setup();

    await run(() => result.current.undo());

    expect(server.revert).toHaveBeenCalledTimes(1);
    expect(server.revert).toHaveBeenCalledWith({ actionId: ACTION });
    expect(useUndoStore.getState().stack.map((e) => e.actionId)).toEqual([
      OLDER,
    ]);
  });

  it("keeps a failed undo on top of the stack, so the next undo retries the same action", async () => {
    useUndoStore
      .getState()
      .push({ actionId: OLDER, label: "Older", runIds: [RUN] });
    useUndoStore
      .getState()
      .push({ actionId: ACTION, label: "Newest", runIds: [RUN] });
    server.revert.mockRejectedValueOnce(new Error("offline"));
    const { result, run } = setup();

    await run(() => result.current.undo());
    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't save your review. Try again.",
    );
    expect(useUndoStore.getState().stack.map((e) => e.actionId)).toEqual([
      OLDER,
      ACTION,
    ]);

    await run(() => result.current.undo());
    expect(server.revert).toHaveBeenCalledTimes(2);
    expect(server.revert).toHaveBeenNthCalledWith(1, { actionId: ACTION });
    expect(server.revert).toHaveBeenNthCalledWith(2, { actionId: ACTION });
    expect(useUndoStore.getState().stack.map((e) => e.actionId)).toEqual([
      OLDER,
    ]);
  });

  it("forgets an undo that can never succeed", async () => {
    for (const refusal of [
      trpcError("not_decider", "FORBIDDEN"),
      // Membership removed since the action was made.
      trpcError("FORBIDDEN", "FORBIDDEN"),
      trpcError("NOT_FOUND", "NOT_FOUND"),
      trpcError("action_spans_projects", "BAD_REQUEST"),
    ]) {
      useUndoStore.setState({ stack: [] });
      useUndoStore
        .getState()
        .push({ actionId: OLDER, label: "Older", runIds: [RUN] });
      useUndoStore
        .getState()
        .push({ actionId: ACTION, label: "Newest", runIds: [RUN] });
      server.revert.mockRejectedValueOnce(refusal);
      const { result, run } = setup();

      await run(() => result.current.undo());

      expect(useUndoStore.getState().stack.map((e) => e.actionId)).toEqual([
        OLDER,
      ]);
      cleanup();
    }
  });

  it("keeps an undo that failed for a reason that may pass", async () => {
    for (const failure of [
      trpcError("boom", "INTERNAL_SERVER_ERROR"),
      trpcError("slow", "TIMEOUT"),
      trpcError("already_decided", "CONFLICT"),
      new Error("offline"),
    ]) {
      useUndoStore.setState({ stack: [] });
      useUndoStore
        .getState()
        .push({ actionId: OLDER, label: "Older", runIds: [RUN] });
      useUndoStore
        .getState()
        .push({ actionId: ACTION, label: "Newest", runIds: [RUN] });
      server.revert.mockRejectedValueOnce(failure);
      const { result, run } = setup();

      await run(() => result.current.undo());

      expect(useUndoStore.getState().stack.map((e) => e.actionId)).toEqual([
        OLDER,
        ACTION,
      ]);
      cleanup();
    }
  });

  it("leaves the stack alone when the newest action's undo is already in flight", async () => {
    useUndoStore
      .getState()
      .push({ actionId: OLDER, label: "Older", runIds: [RUN] });
    useUndoStore
      .getState()
      .push({ actionId: ACTION, label: "Newest", runIds: [RUN] });
    const pending = deferred();
    server.revert.mockReturnValueOnce(pending.promise);
    const { result, run } = setup();

    // The toast's Undo button, then ⌘Z while that is still out.
    await run(() => result.current.undo(ACTION));
    await run(() => result.current.undo());

    expect(server.revert).toHaveBeenCalledTimes(1);
    expect(useUndoStore.getState().stack.map((e) => e.actionId)).toEqual([
      OLDER,
      ACTION,
    ]);

    pending.resolve(reverted());
    await run();
    expect(useUndoStore.getState().stack.map((e) => e.actionId)).toEqual([
      OLDER,
    ]);
  });

  it("does nothing when there is nothing to undo", async () => {
    const { result, run } = setup();

    await run(() => result.current.undo());

    expect(server.revert).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("puts the decision back on screen before the server answers, then drops the entry", async () => {
    seedDecided();
    const pending = deferred();
    server.revert.mockReturnValueOnce(pending.promise);
    const { result, run } = setup();

    await run(() => result.current.undo(ACTION));

    expect(itemState(A)).toBe("unresolved");
    expect(stepCache(A)?.review).toMatchObject({
      state: "unresolved",
      decision: null,
    });
    expect(runCache()?.status).toBe("unresolved");
    expect(buildCache()?.pendingCheckpoints).toBe(6);
    expect(useUndoStore.getState().stack).toHaveLength(1);

    pending.resolve(reverted());
    await run();
    expect(useUndoStore.getState().stack).toEqual([]);
    expect(toast.success).toHaveBeenCalledWith("Undone");
  });

  it("says so when everything was already undone", async () => {
    seedDecided();
    server.revert.mockResolvedValueOnce(
      reverted({
        reverted: 0,
        skipped: [
          { checkpointId: A, reason: "already_undone" },
          { checkpointId: B, reason: "already_undone" },
        ],
      }),
    );
    const { result, run } = setup();

    await run(() => result.current.undo(ACTION));

    expect(toast.info).toHaveBeenCalledWith("Already undone");
    expect(toast.warning).not.toHaveBeenCalled();
    expect(useUndoStore.getState().stack).toEqual([]);
  });

  it("warns with the reasons when only part of an action could be undone", async () => {
    seedDecided();
    server.revert.mockResolvedValueOnce(
      reverted({
        reverted: 1,
        skipped: [
          { checkpointId: B, reason: "superseded_newer_capture" },
          { checkpointId: C, reason: "history_expired" },
          { checkpointId: "d", reason: "superseded_newer_capture" },
        ],
      }),
    );
    const { result, run } = setup();

    await run(() => result.current.undo(ACTION));

    expect(toast.warning).toHaveBeenCalledWith(
      "Undid 1 of 4: a newer capture of this step exists; its baseline was cleaned up",
    );
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("restores the decision and says who can undo it on not_decider", async () => {
    seedDecided();
    const before = snapshotCaches();
    server.revert.mockRejectedValueOnce(trpcError("not_decider", "FORBIDDEN"));
    const { result, run } = setup();

    await run(() => result.current.undo(ACTION));

    expect(toast.error).toHaveBeenCalledWith(
      "only the reviewer who decided or an admin can undo this",
    );
    expect(snapshotCaches()).toEqual(before);
  });

  it("restores the decision and shows the generic message when undo fails", async () => {
    seedDecided();
    const before = snapshotCaches();
    server.revert.mockRejectedValueOnce(new Error("offline"));
    const { result, run } = setup();

    await run(() => result.current.undo(ACTION));

    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't save your review. Try again.",
    );
    expect(snapshotCaches()).toEqual(before);
  });

  it("puts a cache shared by several runs back to where it started", async () => {
    seedDecided();
    qc.setQueryData(keyOf(["runs", "listCheckpoints"], { runId: RUN_2 }), {
      items: [
        {
          id: "cp-d",
          name: "settings",
          ...review("unresolved", "approved"),
          decision: { actionId: ACTION, kind: "approved" },
        },
      ],
    });
    // The second run's only step is approved, so the run reads as passed.
    qc.setQueryData(
      keyOf(["runs", "list"], { projectId: "p-1", buildId: BUILD }),
      {
        items: [
          { id: RUN, buildId: BUILD, status: "new", statusOverride: null },
          { id: RUN_2, buildId: BUILD, status: "passed", statusOverride: null },
        ],
        nextCursor: null,
      },
    );
    useUndoStore.setState({
      stack: [{ actionId: ACTION, label: "Approved 2", runIds: [RUN, RUN_2] }],
    });
    const before = snapshotCaches();
    const pending = deferred();
    server.revert.mockReturnValueOnce(pending.promise);
    const { result, run } = setup();

    await run(() => result.current.undo(ACTION));
    // Two runs each gave a step back to the build's pending count.
    expect(buildCache()?.pendingCheckpoints).toBe(7);

    pending.reject(new Error("offline"));
    await run();

    expect(buildCache()).toEqual(before.build);
    expect(snapshotCaches()).toEqual(before);
  });

  it("finds the runs of an action it has no entry for in the loaded caches, and patches them", async () => {
    seedDecided();
    useUndoStore.setState({ stack: [] });
    const pending = deferred();
    server.revert.mockReturnValueOnce(pending.promise);
    const { result, run } = setup();

    await run(() => result.current.undo(ACTION));

    // A decision from before a reload has no stack entry, and still reverts
    // on screen at once.
    expect(itemState(A)).toBe("unresolved");
    expect(runCache()?.status).toBe("unresolved");
    expect(buildCache()?.pendingCheckpoints).toBe(6);
    expect(result.current.isInFlight(A)).toBe(true);

    pending.resolve(reverted());
    await run();
    expect(server.revert).toHaveBeenCalledWith({ actionId: ACTION });
    expect(toast.success).toHaveBeenCalledWith("Undone");
    expect(result.current.isInFlight(A)).toBe(false);
  });

  it("does not touch a run whose caches hold no decision of that action", async () => {
    seed();
    useUndoStore.setState({ stack: [] });
    const { result, run } = setup();

    await run(() => result.current.undo(ACTION));

    expect(server.revert).toHaveBeenCalledWith({ actionId: ACTION });
    expect(utils.runs.listCheckpoints.setData).not.toHaveBeenCalled();
    expect(utils.runs.getById.setData).not.toHaveBeenCalled();
  });

  it("ignores a decide on a step whose undo is still out", async () => {
    seedDecided();
    const pending = deferred();
    server.revert.mockReturnValueOnce(pending.promise);
    const { result, run } = setup();

    await run(() => result.current.undo(ACTION));
    await run(() =>
      result.current.decide({
        runId: RUN,
        checkpointIds: [A],
        kind: "rejected",
        label: "Rejected home",
      }),
    );
    await run(() =>
      result.current.decide({
        runId: RUN,
        kind: "approved",
        label: "Approved 2",
      }),
    );

    expect(server.reject).not.toHaveBeenCalled();
    expect(server.approve).not.toHaveBeenCalled();

    pending.resolve(reverted());
    await run();
  });

  it("puts back only what a failed undo cleared, leaving a decide still in flight alone", async () => {
    seedDecided();
    const undoCall = deferred();
    const decideCall = deferred();
    server.revert.mockReturnValueOnce(undoCall.promise);
    server.approve.mockReturnValueOnce(decideCall.promise);
    const { result, run } = setup();

    await run(() => result.current.undo(ACTION));
    await run(() =>
      result.current.decide({
        runId: RUN,
        checkpointIds: [B],
        kind: "approved",
        label: "Approved pricing",
      }),
    );
    expect(itemState(A)).toBe("unresolved");
    expect(itemState(B)).toBe("approved");

    undoCall.reject(new Error("offline"));
    await run();

    // A's decision is back, with its original action; B's is still on screen.
    expect(itemsCache()?.find((i) => i.id === A)).toMatchObject({
      state: "approved",
      decision: { actionId: ACTION },
    });
    expect(itemState(B)).toBe("approved");
    expect(stepCache(A)?.review).toMatchObject({
      state: "approved",
    });
    expect(stepCache(B)?.review).toMatchObject({
      state: "approved",
    });
    expect(runCache()?.status).toBe("passed");
    // A pending again, then not again; B no longer pending: 5 - 1.
    expect(buildCache()?.pendingCheckpoints).toBe(4);

    decideCall.resolve(decided());
    await run();
  });
});

describe("useReviewMutations: Go to the undone step", () => {
  /** Where the viewer shows step A, with the review context it was decided in. */
  const HOME =
    "/projects/p-1/runs/run-1/checkpoints/cp-a?status=failed&os=macOS";
  const goTo = { href: HOME, name: "home" };

  /** The options handed to the last call of a toast. */
  const optionsOf = (fn: unknown) =>
    vi.mocked(fn as typeof toast.success).mock.calls.at(-1)?.[1] as
      { action?: { label: string; onClick: () => void } } | undefined;

  it("Undone toast offers Go to 'home' for a single-step action", async () => {
    seed();
    const { result, run } = setup();
    await run(() =>
      result.current.decide({
        runId: RUN,
        checkpointIds: [A],
        kind: "approved",
        label: "Approved 'home'",
        goTo,
      }),
    );
    // The undo entry remembers where its step is.
    expect(useUndoStore.getState().stack).toEqual([
      expect.objectContaining({ label: "Approved 'home'", goTo }),
    ]);
    vi.mocked(toast.success).mockClear();

    // ⌘Z from another step: the Undone toast can take the reviewer back.
    await run(() => result.current.undo());

    expect(toast.success).toHaveBeenCalledOnce();
    expect(vi.mocked(toast.success).mock.calls[0]![0]).toBe("Undone");
    const action = optionsOf(toast.success)?.action;
    expect(action?.label).toBe("Go to 'home'");
    expect(nav.router.push).not.toHaveBeenCalled();
    action!.onClick();
    expect(nav.router.push).toHaveBeenCalledOnce();
    // The exact step, with the review context it was decided in.
    expect(nav.router.push).toHaveBeenCalledWith(HOME);
    expect(useUndoStore.getState().stack).toEqual([]);
  });

  it("no Go to for multi-step actions", async () => {
    seed();
    const { result, run } = setup();
    // A run-wide decision (Approve pending steps) and one of several steps
    // keep no goTo, even when handed one.
    await run(() =>
      result.current.decide({
        runId: RUN,
        kind: "approved",
        label: "Approved 2 steps",
        goTo,
      }),
    );
    await run(() =>
      result.current.decide({
        runId: RUN,
        checkpointIds: [A, B],
        kind: "rejected",
        label: "Rejected 2 steps",
        goTo,
      }),
    );
    // A group decision, and the batch's Approve pending.
    await run(() =>
      result.current.decideGroup({
        runId: RUN,
        checkpointId: A,
        kind: "approved",
        label: "Approved 3 similar steps",
      }),
    );
    await run(() =>
      result.current.approveBuild({
        buildId: BUILD,
        expectedCount: 2,
        label: "Approved 2 steps",
        onConflict: vi.fn(),
      }),
    );
    const stack = useUndoStore.getState().stack;
    expect(stack).toHaveLength(4);
    for (const entry of stack) expect(entry).not.toHaveProperty("goTo");

    vi.mocked(toast.success).mockClear();
    for (let i = 0; i < 4; i++) await run(() => result.current.undo());
    expect(server.revert).toHaveBeenCalledTimes(4);
    expect(vi.mocked(toast.success).mock.calls).toEqual([
      ["Undone"],
      ["Undone"],
      ["Undone"],
      ["Undone"],
    ]);

    // A decision from before a reload, undone from its step's chip: there is
    // no entry, so nothing says where it is.
    const CHIP = "55555555-5555-4555-8555-555555555555";
    seedApproved(CHIP);
    vi.mocked(toast.success).mockClear();
    await run(() => result.current.undo(CHIP));
    expect(server.revert).toHaveBeenLastCalledWith({ actionId: CHIP });
    expect(vi.mocked(toast.success).mock.calls).toEqual([["Undone"]]);
    expect(nav.router.push).not.toHaveBeenCalled();
  });

  it("no Go to while the reviewer is on that step already", async () => {
    seed();
    nav.pathname = "/projects/p-1/runs/run-1/checkpoints/cp-a";
    const { result, run } = setup();
    await run(() =>
      result.current.decide({
        runId: RUN,
        checkpointIds: [A],
        kind: "approved",
        label: "Approved 'home'",
        goTo,
      }),
    );
    vi.mocked(toast.success).mockClear();
    await run(() => result.current.undo());
    expect(vi.mocked(toast.success).mock.calls).toEqual([["Undone"]]);
  });

  it("a partial or already-done undo offers no Go to", async () => {
    for (const [answer, shown] of [
      [
        reverted({
          reverted: 0,
          skipped: [{ checkpointId: A, reason: "already_undone" }],
        }),
        toast.info,
      ],
      [
        reverted({
          reverted: 1,
          skipped: [{ checkpointId: B, reason: "history_expired" }],
        }),
        toast.warning,
      ],
    ] as const) {
      useUndoStore.setState({ stack: [] });
      seed();
      server.revert.mockResolvedValueOnce(answer);
      const { result, run } = setup();
      await run(() =>
        result.current.decide({
          runId: RUN,
          checkpointIds: [A],
          kind: "approved",
          label: "Approved 'home'",
          goTo,
        }),
      );
      vi.mocked(shown).mockClear();
      await run(() => result.current.undo());
      expect(shown).toHaveBeenCalledOnce();
      expect(vi.mocked(shown).mock.calls[0]).toHaveLength(1);
      cleanup();
    }
  });
});

describe("useReviewMutations: group and build actions", () => {
  it("decides a group through the server without touching the caches", async () => {
    seed();
    const { result, run } = setup();

    await run(() =>
      result.current.decideGroup({
        runId: RUN,
        checkpointId: A,
        kind: "rejected",
        label: "Rejected 3 like home",
      }),
    );

    expect(server.rejectGroup).toHaveBeenCalledWith({
      runId: RUN,
      checkpointId: A,
      actionId: expect.stringMatching(UUID_V4) as string,
    });
    expect(server.approveGroup).not.toHaveBeenCalled();
    expect(utils.runs.listCheckpoints.setData).not.toHaveBeenCalled();
    expect(toastAction().action.label).toBe("Undo");
    expect(useUndoStore.getState().stack).toEqual([
      {
        actionId: sentActionId(server.rejectGroup),
        label: "Rejected 3 like home",
        runIds: [RUN],
      },
    ]);
  });

  it("holds the seed checkpoint of a group while the call is out", async () => {
    seed();
    const pending = deferred();
    server.approveGroup.mockReturnValueOnce(pending.promise);
    const { result, run } = setup();
    const args = {
      runId: RUN,
      checkpointId: A,
      kind: "approved",
      label: "Approved 3 like home",
    } as const;

    await run(() => result.current.decideGroup(args));
    await run(() => result.current.decideGroup(args));

    expect(result.current.isInFlight(A)).toBe(true);
    expect(server.approveGroup).toHaveBeenCalledTimes(1);
    pending.resolve(decided());
    await run();
    expect(result.current.isInFlight(A)).toBe(false);
  });

  it("approves a build without patching, and undo covers every run it touched", async () => {
    seed();
    const { result, run } = setup();

    await run(() =>
      result.current.approveBuild({
        buildId: BUILD,
        expectedCount: 5,
        label: "Approved 5 steps",
        onConflict: vi.fn(),
      }),
    );

    expect(server.approveBuild).toHaveBeenCalledWith({
      buildId: BUILD,
      expectedCount: 5,
      actionId: expect.stringMatching(UUID_V4) as string,
    });
    expect(utils.runs.listCheckpoints.setData).not.toHaveBeenCalled();
    expect(utils.builds.getById.setData).not.toHaveBeenCalled();
    expect(toastAction().action.label).toBe("Undo");
    expect(useUndoStore.getState().stack).toEqual([
      {
        actionId: sentActionId(server.approveBuild),
        label: "Approved 5 steps",
        runIds: [RUN, RUN_2],
      },
    ]);
    expect(utils.builds.getById.invalidate).toHaveBeenCalled();
  });

  it("words a group's toast from what the server decided", async () => {
    seed();
    server.rejectGroup.mockResolvedValueOnce({
      ...decided([RUN, RUN_2]),
      decided: [{ checkpointId: A, runId: RUN, state: "rejected" }],
    });
    const { result, run } = setup();

    await run(() =>
      result.current.decideGroup({
        runId: RUN,
        checkpointId: A,
        kind: "rejected",
        label: (r) => `Rejected ${r.decided.length} steps`,
      }),
    );

    expect(vi.mocked(toast.success).mock.calls[0]?.[0]).toBe(
      "Rejected 1 steps",
    );
    expect(useUndoStore.getState().stack[0]?.label).toBe("Rejected 1 steps");
  });

  it("words a build approval's toast from what the server decided", async () => {
    seed();
    server.approveBuild.mockResolvedValueOnce({
      ...decided([RUN, RUN_2]),
      decided: [
        { checkpointId: A, runId: RUN, state: "approved" },
        { checkpointId: B, runId: RUN_2, state: "approved" },
      ],
    });
    const { result, run } = setup();

    await run(() =>
      result.current.approveBuild({
        buildId: BUILD,
        expectedCount: 5,
        label: (r) => `Approved ${r.decided.length} in ${r.runs.length}`,
        onConflict: vi.fn(),
      }),
    );

    expect(vi.mocked(toast.success).mock.calls[0]?.[0]).toBe("Approved 2 in 2");
    expect(useUndoStore.getState().stack[0]?.label).toBe("Approved 2 in 2");
  });

  it("hands the fresh preview to onConflict on batch_changed, with no toast", async () => {
    seed();
    const preview: ApproveBuildPreview = {
      pendingCheckpoints: 7,
      tests: 3,
      rejectedLeftAsIs: 1,
      notReviewableTests: 0,
      capped: false,
      cap: 500,
    };
    server.approveBuild.mockRejectedValueOnce(
      trpcError("batch_changed", "CONFLICT", { preview }),
    );
    const onConflict = vi.fn();
    const { result, run } = setup();

    await run(() =>
      result.current.approveBuild({
        buildId: BUILD,
        expectedCount: 5,
        label: "Approved 5 steps",
        onConflict,
      }),
    );

    expect(onConflict).toHaveBeenCalledTimes(1);
    expect(onConflict).toHaveBeenCalledWith(preview);
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    expect(useUndoStore.getState().stack).toEqual([]);
  });

  it("tells the caller the batch was approved, then that the call is over", async () => {
    seed();
    const order: string[] = [];
    const { result, run } = setup();

    await run(() =>
      result.current.approveBuild({
        buildId: BUILD,
        expectedCount: 5,
        label: "Approved 5 steps",
        onConflict: vi.fn(),
        onSuccess: () => order.push("success"),
        onSettled: () => order.push("settled"),
      }),
    );

    expect(order).toEqual(["success", "settled"]);
    expect(toast.success).toHaveBeenCalled();
  });

  it("tells the caller the call is over after a conflict, without calling it a success", async () => {
    seed();
    const preview: ApproveBuildPreview = {
      pendingCheckpoints: 7,
      tests: 3,
      rejectedLeftAsIs: 0,
      notReviewableTests: 0,
      capped: false,
      cap: 500,
    };
    server.approveBuild.mockRejectedValueOnce(
      trpcError("batch_changed", "CONFLICT", { preview }),
    );
    const onSuccess = vi.fn();
    const onSettled = vi.fn();
    const { result, run } = setup();

    await run(() =>
      result.current.approveBuild({
        buildId: BUILD,
        expectedCount: 5,
        label: "Approved 5 steps",
        onConflict: vi.fn(),
        onSuccess,
        onSettled,
      }),
    );

    expect(onSuccess).not.toHaveBeenCalled();
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("tells the caller the call is over after a failure, without calling it a success", async () => {
    seed();
    server.approveBuild.mockRejectedValueOnce(new Error("offline"));
    const onSuccess = vi.fn();
    const onSettled = vi.fn();
    const { result, run } = setup();

    await run(() =>
      result.current.approveBuild({
        buildId: BUILD,
        expectedCount: 5,
        label: "Approved 5 steps",
        onConflict: vi.fn(),
        onSuccess,
        onSettled,
      }),
    );

    expect(onSuccess).not.toHaveBeenCalled();
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("shows the generic message when approving a build fails for another reason", async () => {
    seed();
    server.approveBuild.mockRejectedValueOnce(new Error("offline"));
    const onConflict = vi.fn();
    const { result, run } = setup();

    await run(() =>
      result.current.approveBuild({
        buildId: BUILD,
        expectedCount: 5,
        label: "Approved 5 steps",
        onConflict,
      }),
    );

    expect(onConflict).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't save your review. Try again.",
    );
  });
});
