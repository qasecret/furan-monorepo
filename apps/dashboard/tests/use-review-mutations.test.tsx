import { randomFillSync } from "node:crypto";

import type { ApproveBuildPreview } from "@furan/shared-types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
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
    list: procedureUtils(["runs", "list"]),
  },
  builds: { getById: procedureUtils(["builds", "getById"]) },
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

  const mutationFor = (name: keyof typeof server) => ({
    useMutation: (opts: Lifecycle) => ({
      mutate: (vars: unknown) => {
        void runMutation(name, opts, vars);
      },
      isPending: false,
    }),
  });

  return { server, mutationFor };
});

vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => utils,
    runs: {
      list: { _def: () => ({ path: ["runs", "list"] }) },
      listCheckpoints: { _def: () => ({ path: ["runs", "listCheckpoints"] }) },
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
  /** The legacy alias of the state; the patches keep it in step. */
  status: string;
  verdict: string;
  state: string;
  decision: { actionId: string; kind: string } | null;
}

const seedItems = (): Item[] => [
  { id: A, name: "home", status: "unresolved", ...review("unresolved") },
  { id: B, name: "pricing", status: "new", ...review("new") },
  { id: C, name: "footer", status: "passed", ...review("passed") },
];

/** What `runs.getById` carries per checkpoint: the review fields, no name or alias. */
const contextOf = ({ verdict, state, decision }: Item) => ({
  verdict,
  state,
  decision,
  newerCapture: null,
});

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
      checkpointContexts: Object.fromEntries(
        seedItems().map((i) => [i.id, contextOf(i)]),
      ),
    });
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
    });
  }
}

/** The seed, with step A already approved under `actionId` in every cache. */
function seedApproved(actionId: string) {
  seed();
  const decision = { actionId, kind: "approved" };
  qc.setQueryData(keyOf(["runs", "listCheckpoints"], { runId: RUN }), {
    items: seedItems().map((i) =>
      i.id === A ? { ...i, state: "approved", status: "passed", decision } : i,
    ),
  });
  qc.setQueryData(keyOf(["runs", "getById"], { runId: RUN }), {
    id: RUN,
    buildId: BUILD,
    status: "new",
    statusOverride: null,
    checkpointContexts: Object.fromEntries(
      seedItems().map((i) => [
        i.id,
        contextOf(i.id === A ? { ...i, state: "approved", decision } : i),
      ]),
    ),
  });
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
 * Makes the run detail the patch reads come back without its checkpoint
 * contexts. The first read is the hook noting what it is about to overwrite,
 * so it gets the real cache; the second is the patch itself.
 */
function breakNextPatchRead() {
  utils.runs.getById.getData
    .mockReturnValueOnce(
      qc.getQueryData(keyOf(["runs", "getById"], { runId: RUN })),
    )
    .mockReturnValueOnce({ status: "unresolved" });
}

const itemsCache = () =>
  qc.getQueryData<{ items: Item[] }>(
    keyOf(["runs", "listCheckpoints"], { runId: RUN }),
  )?.items;
const runCache = () =>
  qc.getQueryData<{
    status: string;
    checkpointContexts: Record<
      string,
      Pick<Item, "verdict" | "state" | "decision">
    >;
  }>(keyOf(["runs", "getById"], { runId: RUN }));
const listRows = () =>
  qc.getQueryData<{ items: Array<{ id: string; status: string }> }>(
    keyOf(["runs", "list"], { projectId: "p-1", buildId: BUILD }),
  )?.items;
const buildCache = () =>
  qc.getQueryData<{ pendingCheckpoints: number }>(
    keyOf(["builds", "getById"], { buildId: BUILD }),
  );
const itemState = (id: string) => itemsCache()?.find((i) => i.id === id)?.state;

function snapshotCaches() {
  return structuredClone({
    items: itemsCache(),
    run: runCache(),
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

const decided = (runs: string[] = [RUN]) => ({
  actionId: "server-echo",
  decided: [],
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
  useInFlightStore.setState({ ids: new Set() });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useReviewMutations: optimistic decide", () => {
  it("patches every loaded cache before the server answers", async () => {
    seed();
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

    // The call is out, nothing has come back, and the screen already shows it.
    expect(server.approve).toHaveBeenCalledTimes(1);
    expect(toast.success).not.toHaveBeenCalled();
    expect(itemsCache()?.find((i) => i.id === A)).toMatchObject({
      state: "approved",
      decision: { kind: "approved" },
    });
    expect(itemState(B)).toBe("new");
    expect(runCache()?.checkpointContexts[A]).toMatchObject({
      state: "approved",
    });
    // A was the only unresolved step: the run is now "new" (B), not unresolved.
    expect(runCache()?.status).toBe("new");
    expect(listRows()?.find((r) => r.id === RUN)?.status).toBe("new");
    expect(listRows()?.find((r) => r.id === RUN_2)?.status).toBe("failed");
    expect(buildCache()?.pendingCheckpoints).toBe(4);
    expect(utils.runs.listCheckpoints.cancel).toHaveBeenCalledWith({
      runId: RUN,
    });
    expect(utils.runs.getById.cancel).toHaveBeenCalledWith({ runId: RUN });

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
    expect(utils.runs.list.invalidate).toHaveBeenCalled();
    expect(utils.builds.getById.invalidate).toHaveBeenCalled();
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
    expect(runCache()?.checkpointContexts[A]).toMatchObject({
      state: "unresolved",
    });
    expect(runCache()?.checkpointContexts[B]).toMatchObject({
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
    expect(runCache()?.checkpointContexts[A]).toMatchObject({
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
    expect(runCache()?.checkpointContexts[A]).toMatchObject({
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
          status: "passed",
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
    expect(runCache()?.checkpointContexts[A]).toMatchObject({
      state: "approved",
    });
    expect(runCache()?.checkpointContexts[B]).toMatchObject({
      state: "approved",
    });
    expect(runCache()?.status).toBe("passed");
    // A pending again, then not again; B no longer pending: 5 - 1.
    expect(buildCache()?.pendingCheckpoints).toBe(4);

    decideCall.resolve(decided());
    await run();
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
