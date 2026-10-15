import { act, cleanup, renderHook } from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
  type Mock,
} from "vitest";

import { useReviewAnnouncer } from "@/lib/review/review-announcer";
import { useLoopCue, useReviewLoop } from "@/lib/review/use-review-loop";
import type { ReviewContext } from "@/lib/review-context";
import type { RouterOutputs } from "@/lib/trpc";

// The router, the tRPC hooks and the utils are mocked: this suite is about
// what the loop decides from an answer of `review.next` (where it goes, what
// it says, which card it shows), not about the server.
const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

type Answer = RouterOutputs["review"]["next"];

/** What the live `review.next` query answers, set per test. */
const query = vi.hoisted(() => ({
  data: undefined as unknown,
  isLoading: false,
  isFetching: false,
  isError: false,
  error: null as { message: string } | null,
  refetch: vi.fn(),
  calls: [] as Array<{ input: unknown; options: { enabled?: boolean } }>,
}));
const utils = vi.hoisted(() => ({
  review: { next: { fetch: vi.fn() } },
  runs: {
    getById: { prefetch: vi.fn(), getData: vi.fn(), fetch: vi.fn() },
    listCheckpoints: { prefetch: vi.fn() },
  },
}));

vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => utils,
    review: {
      next: {
        useQuery: (input: unknown, options: { enabled?: boolean }) => {
          query.calls.push({ input, options });
          return {
            data: query.data,
            isLoading: query.isLoading,
            isFetching: query.isFetching,
            isError: query.isError,
            error: query.error,
            refetch: query.refetch,
          };
        },
      },
    },
  },
}));

const PROJECT = "p1";
const BUILD = "b1";
const RUN = "run-1";
const STEP = "step-1";
const OTHER_RUN = "run-2";

const DEFAULT_CONTEXT: ReviewContext = { status: "needs-review", facets: {} };

type Args = Parameters<typeof useReviewLoop>[0];

function args(over: Partial<Args> = {}): Args {
  return {
    projectId: PROJECT,
    buildId: BUILD,
    runId: RUN,
    checkpointId: STEP,
    context: DEFAULT_CONTEXT,
    enabled: true,
    ...over,
  };
}

function answer(over: Partial<Answer> = {}): Answer {
  return {
    target: { buildId: BUILD, runId: RUN, checkpointId: "step-2" },
    scope: "run",
    remaining: { run: 2, batch: 5, batchUnfiltered: 5, projectBatches: 3 },
    nextBatch: null,
    ...over,
  };
}

const nextBatch = {
  buildId: "b2",
  name: "Build 12",
  number: 12,
  branch: "main",
  pending: 4,
};

function setup(over: Partial<Args> = {}) {
  return renderHook((props: Args) => useReviewLoop(props), {
    initialProps: args(over),
  });
}

/** The mock was called once, with these arguments. */
function calledOnceWith(mock: Mock, ...expected: unknown[]) {
  expect(mock).toHaveBeenCalledOnce();
  expect(mock).toHaveBeenCalledWith(...expected);
}

/** The arguments `review.next.useQuery` got on the last render. */
function lastCall() {
  const call = query.calls.at(-1);
  if (!call) throw new Error("review.next.useQuery was not called");
  return call;
}

beforeEach(() => {
  query.data = undefined;
  query.isLoading = false;
  query.isFetching = false;
  query.isError = false;
  query.error = null;
  query.refetch.mockReset();
  query.calls = [];
  router.push.mockReset();
  router.replace.mockReset();
  utils.review.next.fetch.mockReset();
  utils.runs.getById.prefetch.mockReset();
  utils.runs.getById.getData.mockReset();
  utils.runs.getById.fetch.mockReset();
  utils.runs.listCheckpoints.prefetch.mockReset();
  // A target run that is already cached, with a name.
  utils.runs.getById.getData.mockReturnValue({ name: "Checkout" });
  useReviewAnnouncer.setState({ text: "", seq: 0 });
  useLoopCue.setState({ cue: null });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useReviewLoop: the query", () => {
  test("asks review.next from the step, with the context's facets", () => {
    setup({
      context: { status: "failed", facets: { browser: "chromium" } },
    });
    const { input, options } = lastCall();
    expect(input).toEqual({
      projectId: PROJECT,
      at: { buildId: BUILD, runId: RUN, checkpointId: STEP },
      facets: { browser: "chromium" },
    });
    expect(options.enabled).toBe(true);
  });

  test.each([
    ["is the _first placeholder", "_first"],
    ["is not known yet", undefined],
  ])("disabled while the checkpoint %s", (_name, checkpointId) => {
    setup({ checkpointId });
    expect(lastCall().options.enabled).toBe(false);
    // And the query never names the placeholder.
    expect(JSON.stringify(lastCall().input)).not.toContain("_first");
  });

  test("disabled until the batch is known", () => {
    setup({ buildId: undefined });
    expect(lastCall().options.enabled).toBe(false);
  });

  test("no call when enabled is false", () => {
    // Even with an answer in the cache, a loop that is off asks nothing and
    // moves nowhere.
    query.data = answer();
    const { result } = setup({ enabled: false });
    expect(lastCall().options.enabled).toBe(false);
    act(() => result.current.afterDecision());
    act(() => result.current.goNext());
    act(() => result.current.goPrev());
    expect(router.replace).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
    expect(utils.review.next.fetch).not.toHaveBeenCalled();
    expect(result.current.next).toBeUndefined();
    expect(result.current.loading).toBe(false);
  });

  test("hands back the answer and whether it is loading", () => {
    query.isLoading = true;
    const { result, rerender } = setup();
    expect(result.current.loading).toBe(true);
    expect(result.current.next).toBeUndefined();
    query.isLoading = false;
    query.data = answer();
    rerender(args());
    expect(result.current.loading).toBe(false);
    expect(result.current.next).toBe(query.data);
  });
});

describe.each(["afterDecision", "goNext"] as const)(
  "useReviewLoop.%s, by scope",
  (move) => {
    test("run: replaces the URL with the next step of the run", () => {
      query.data = answer({
        target: { buildId: BUILD, runId: RUN, checkpointId: "step-2" },
        scope: "run",
      });
      const { result } = setup();
      act(() => result.current[move]());
      calledOnceWith(
        router.replace,
        `/projects/${PROJECT}/runs/${RUN}/checkpoints/step-2`,
      );
      expect(router.push).not.toHaveBeenCalled();
      // Same run: nothing to announce.
      expect(useReviewAnnouncer.getState().text).toBe("");
      expect(result.current.card).toBeNull();
    });

    test("batch: pushes the next test, and announces it", () => {
      query.data = answer({
        target: { buildId: BUILD, runId: OTHER_RUN, checkpointId: "step-9" },
        scope: "batch",
        remaining: { run: 0, batch: 4, batchUnfiltered: 4, projectBatches: 3 },
      });
      const { result } = setup();
      act(() => result.current[move]());
      calledOnceWith(
        router.push,
        `/projects/${PROJECT}/runs/${OTHER_RUN}/checkpoints/step-9`,
      );
      expect(router.replace).not.toHaveBeenCalled();
      expect(useReviewAnnouncer.getState().text).toBe(
        "Next test: Checkout · 4 left in batch",
      );
      expect(result.current.card).toBeNull();
    });

    test("nextBatch: shows the batch card when nothing is hidden by the filters", () => {
      query.data = answer({
        target: { buildId: "b2", runId: "r9", checkpointId: "s9" },
        scope: "nextBatch",
        remaining: { run: 0, batch: 0, batchUnfiltered: 0, projectBatches: 2 },
        nextBatch,
      });
      const { result } = setup();
      act(() => result.current[move]());
      expect(result.current.card).toBe("batch");
      // It does not leave the page: the card offers the next batch.
      expect(router.push).not.toHaveBeenCalled();
      expect(router.replace).not.toHaveBeenCalled();
    });

    test("nextBatch: shows the filtered card when steps are left outside the filters", () => {
      query.data = answer({
        target: { buildId: "b2", runId: "r9", checkpointId: "s9" },
        scope: "nextBatch",
        remaining: { run: 0, batch: 0, batchUnfiltered: 3, projectBatches: 2 },
        nextBatch,
      });
      const { result } = setup();
      act(() => result.current[move]());
      expect(result.current.card).toBe("filtered");
      expect(router.push).not.toHaveBeenCalled();
    });

    test("none: shows the all-done card", () => {
      query.data = answer({
        target: null,
        scope: "none",
        remaining: { run: 0, batch: 0, batchUnfiltered: 0, projectBatches: 0 },
      });
      const { result } = setup();
      act(() => result.current[move]());
      expect(result.current.card).toBe("all");
      expect(router.push).not.toHaveBeenCalled();
      expect(router.replace).not.toHaveBeenCalled();
    });
  },
);

describe("useReviewLoop: the review context travels", () => {
  test("every move carries the status and facets in the URL", () => {
    const context: ReviewContext = {
      status: "failed",
      facets: { browser: "chromium", viewport: "1280x720" },
    };
    query.data = answer({
      target: { buildId: BUILD, runId: OTHER_RUN, checkpointId: "step-9" },
      scope: "batch",
    });
    const { result, rerender } = setup({ context });
    act(() => result.current.goNext());
    expect(router.push).toHaveBeenLastCalledWith(
      `/projects/${PROJECT}/runs/${OTHER_RUN}/checkpoints/step-9?status=failed&browser=chromium&viewport=1280x720`,
    );
    // The route commits: the step on screen is the one J moved to.
    query.data = answer({
      target: { buildId: BUILD, runId: OTHER_RUN, checkpointId: "step-10" },
      scope: "run",
    });
    rerender(args({ context, runId: OTHER_RUN, checkpointId: "step-9" }));
    act(() => result.current.goNext());
    expect(router.replace).toHaveBeenLastCalledWith(
      `/projects/${PROJECT}/runs/${OTHER_RUN}/checkpoints/step-10?status=failed&browser=chromium&viewport=1280x720`,
    );
  });
});

describe("useReviewLoop: the cue's test name", () => {
  const batchAnswer = () =>
    answer({
      target: { buildId: BUILD, runId: OTHER_RUN, checkpointId: "step-9" },
      scope: "batch",
      remaining: { run: 0, batch: 7, batchUnfiltered: 7, projectBatches: 1 },
    });

  test("reads the name from the run already cached", () => {
    utils.runs.getById.getData.mockReturnValue({ name: "Login flow" });
    query.data = batchAnswer();
    const { result } = setup();
    act(() => result.current.goNext());
    expect(utils.runs.getById.getData).toHaveBeenCalledWith({
      runId: OTHER_RUN,
    });
    expect(utils.runs.getById.fetch).not.toHaveBeenCalled();
    expect(useReviewAnnouncer.getState().text).toBe(
      "Next test: Login flow · 7 left in batch",
    );
  });

  test("moves at once and announces when the run arrives, if it is not cached yet", async () => {
    utils.runs.getById.getData.mockReturnValue(undefined);
    let resolve!: (run: { name: string | null }) => void;
    utils.runs.getById.fetch.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    query.data = batchAnswer();
    const { result } = setup();
    act(() => result.current.goNext());
    // The move does not wait for the name.
    expect(router.push).toHaveBeenCalledOnce();
    expect(useReviewAnnouncer.getState().text).toBe("");
    await act(async () => resolve({ name: "Profile page" }));
    expect(utils.runs.getById.fetch).toHaveBeenCalledWith({
      runId: OTHER_RUN,
    });
    expect(useReviewAnnouncer.getState().text).toBe(
      "Next test: Profile page · 7 left in batch",
    );
  });

  test("falls back to the viewer's own title for a run with no name", () => {
    utils.runs.getById.getData.mockReturnValue({ name: null });
    query.data = batchAnswer();
    const { result } = setup();
    act(() => result.current.goNext());
    expect(useReviewAnnouncer.getState().text).toBe(
      "Next test: Untitled run · 7 left in batch",
    );
  });

  test("still announces when the run cannot be read", async () => {
    utils.runs.getById.getData.mockReturnValue(undefined);
    utils.runs.getById.fetch.mockRejectedValue(new Error("down"));
    query.data = batchAnswer();
    const { result } = setup();
    await act(async () => result.current.goNext());
    expect(router.push).toHaveBeenCalledOnce();
    expect(useReviewAnnouncer.getState().text).toBe(
      "Next test: Untitled run · 7 left in batch",
    );
  });
});

describe("useReviewLoop: a late answer", () => {
  test("late answer defers the transition", () => {
    query.isLoading = true;
    const { result, rerender } = setup();
    act(() => result.current.afterDecision());
    // No answer yet: nothing moves.
    expect(router.replace).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();

    // The answer arrives: now it moves, once.
    query.isLoading = false;
    query.data = answer();
    rerender(args());
    calledOnceWith(
      router.replace,
      `/projects/${PROJECT}/runs/${RUN}/checkpoints/step-2`,
    );

    // A refetch of the same answer does not move it again.
    query.data = answer();
    rerender(args());
    expect(router.replace).toHaveBeenCalledOnce();
  });

  test("a deferred move into the next batch shows its card when the answer arrives", () => {
    query.isLoading = true;
    const { result, rerender } = setup();
    act(() => result.current.afterDecision());
    expect(result.current.card).toBeNull();
    query.isLoading = false;
    query.data = answer({
      target: null,
      scope: "none",
      remaining: { run: 0, batch: 0, batchUnfiltered: 0, projectBatches: 0 },
    });
    rerender(args());
    expect(result.current.card).toBe("all");
  });

  test("an answer that arrives after the reviewer went elsewhere is ignored", () => {
    query.isLoading = true;
    const { result, rerender } = setup();
    act(() => result.current.afterDecision());

    // The reviewer opens another step before the answer comes.
    rerender(args({ checkpointId: "step-7" }));
    query.isLoading = false;
    query.data = answer({
      target: { buildId: BUILD, runId: RUN, checkpointId: "step-8" },
    });
    rerender(args({ checkpointId: "step-7" }));
    expect(router.replace).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();

    // And it does not linger: the next answer for this step is not acted on
    // either, without a new decision.
    query.data = answer({
      target: { buildId: BUILD, runId: RUN, checkpointId: "step-9" },
    });
    rerender(args({ checkpointId: "step-7" }));
    expect(router.replace).not.toHaveBeenCalled();
  });

  test("a decision with the loop off does not wait for an answer that cannot come", () => {
    const { result, rerender } = setup({ enabled: false });
    act(() => result.current.afterDecision());
    rerender(args({ enabled: true }));
    query.data = answer();
    rerender(args({ enabled: true }));
    expect(router.replace).not.toHaveBeenCalled();
  });
});

describe("useReviewLoop: the card", () => {
  const done = () =>
    answer({
      target: null,
      scope: "none",
      remaining: { run: 0, batch: 0, batchUnfiltered: 0, projectBatches: 0 },
    });

  test("dismissCard clears it", () => {
    query.data = done();
    const { result } = setup();
    act(() => result.current.afterDecision());
    expect(result.current.card).toBe("all");
    act(() => result.current.dismissCard());
    expect(result.current.card).toBeNull();
  });

  test("moving to another step puts it away", () => {
    query.data = done();
    const { result, rerender } = setup();
    act(() => result.current.afterDecision());
    expect(result.current.card).toBe("all");
    rerender(args({ checkpointId: "step-3" }));
    expect(result.current.card).toBeNull();
    // Coming back does not bring it back.
    rerender(args({ checkpointId: STEP }));
    expect(result.current.card).toBeNull();
  });

  test("is null before anything is decided", () => {
    query.data = done();
    const { result } = setup();
    expect(result.current.card).toBeNull();
  });
});

describe("useReviewLoop: prefetch", () => {
  test("prefetches the target", () => {
    query.data = answer({
      target: { buildId: BUILD, runId: OTHER_RUN, checkpointId: "step-9" },
      scope: "batch",
    });
    setup();
    calledOnceWith(utils.runs.getById.prefetch, {
      runId: OTHER_RUN,
    });
    calledOnceWith(utils.runs.listCheckpoints.prefetch, { runId: OTHER_RUN });
  });

  test("prefetches again when the target moves to another run, not on a refetch", () => {
    query.data = answer({
      target: { buildId: BUILD, runId: OTHER_RUN, checkpointId: "step-9" },
      scope: "batch",
    });
    const { rerender } = setup();
    query.data = answer({
      target: { buildId: BUILD, runId: OTHER_RUN, checkpointId: "step-9" },
      scope: "batch",
    });
    rerender(args());
    expect(utils.runs.getById.prefetch).toHaveBeenCalledOnce();

    query.data = answer({
      target: { buildId: BUILD, runId: "run-3", checkpointId: "step-1" },
      scope: "batch",
    });
    rerender(args());
    expect(utils.runs.getById.prefetch).toHaveBeenLastCalledWith({
      runId: "run-3",
    });
    expect(utils.runs.getById.prefetch).toHaveBeenCalledTimes(2);
  });

  test("does not refetch the run the reviewer is already in", () => {
    query.data = answer({
      target: { buildId: BUILD, runId: RUN, checkpointId: "step-2" },
      scope: "run",
    });
    setup();
    expect(utils.runs.getById.prefetch).not.toHaveBeenCalled();
    expect(utils.runs.listCheckpoints.prefetch).not.toHaveBeenCalled();
  });

  test("prefetches nothing when there is no target", () => {
    query.data = answer({ target: null, scope: "none" });
    setup();
    expect(utils.runs.getById.prefetch).not.toHaveBeenCalled();
  });
});

describe("useReviewLoop.goPrev", () => {
  const prev = (over: Partial<Answer> = {}) =>
    answer({
      target: { buildId: BUILD, runId: RUN, checkpointId: "step-0" },
      scope: "run",
      ...over,
    });

  test("goPrev sends direction prev", async () => {
    utils.review.next.fetch.mockResolvedValue(prev());
    const { result } = setup({
      context: { status: "needs-review", facets: { os: "macOS" } },
    });
    await act(async () => result.current.goPrev());
    calledOnceWith(utils.review.next.fetch, {
      projectId: PROJECT,
      at: { buildId: BUILD, runId: RUN, checkpointId: STEP },
      direction: "prev",
      facets: { os: "macOS" },
    });
  });

  test("replaces the URL with the previous step of the run", async () => {
    utils.review.next.fetch.mockResolvedValue(prev());
    const { result } = setup();
    await act(async () => result.current.goPrev());
    calledOnceWith(
      router.replace,
      `/projects/${PROJECT}/runs/${RUN}/checkpoints/step-0`,
    );
  });

  test("pushes the previous test when it is in another run, without the next-test cue", async () => {
    utils.review.next.fetch.mockResolvedValue(
      prev({
        target: { buildId: BUILD, runId: OTHER_RUN, checkpointId: "step-4" },
        scope: "batch",
      }),
    );
    const { result } = setup();
    await act(async () => result.current.goPrev());
    calledOnceWith(
      router.push,
      `/projects/${PROJECT}/runs/${OTHER_RUN}/checkpoints/step-4`,
    );
    expect(useReviewAnnouncer.getState().text).toBe("");
  });

  test.each([
    ["nothing before it", prev({ target: null, scope: "none" })],
    [
      "only another batch before it",
      prev({
        target: { buildId: "b2", runId: "r9", checkpointId: "s9" },
        scope: "nextBatch",
        nextBatch,
      }),
    ],
  ])("stays put when there is %s", async (_name, result_) => {
    utils.review.next.fetch.mockResolvedValue(result_);
    const { result } = setup();
    await act(async () => result.current.goPrev());
    expect(router.push).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
    expect(result.current.card).toBeNull();
  });

  test("an answer for a step the reviewer has left is ignored", async () => {
    let resolve!: (a: Answer) => void;
    utils.review.next.fetch.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const { result, rerender } = setup();
    act(() => result.current.goPrev());
    rerender(args({ checkpointId: "step-7" }));
    await act(async () => resolve(prev()));
    expect(router.replace).not.toHaveBeenCalled();
  });

  test("a second press while one is on its way does not ask again", async () => {
    let resolve!: (a: Answer) => void;
    utils.review.next.fetch.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const { result, rerender } = setup();
    act(() => {
      result.current.goPrev();
      result.current.goPrev();
    });
    expect(utils.review.next.fetch).toHaveBeenCalledOnce();
    await act(async () => resolve(prev()));
    expect(router.replace).toHaveBeenCalledOnce();
    // Once it has landed (the route has committed), the key works again.
    rerender(args({ checkpointId: "step-0" }));
    utils.review.next.fetch.mockResolvedValue(prev());
    await act(async () => result.current.goPrev());
    expect(utils.review.next.fetch).toHaveBeenCalledTimes(2);
  });

  test("a failed lookup is not an unhandled rejection, and the key works again", async () => {
    utils.review.next.fetch.mockRejectedValueOnce(new Error("down"));
    const { result } = setup();
    await act(async () => result.current.goPrev());
    expect(router.replace).not.toHaveBeenCalled();
    utils.review.next.fetch.mockResolvedValue(prev());
    await act(async () => result.current.goPrev());
    expect(router.replace).toHaveBeenCalledOnce();
  });

  test("does nothing before the step is resolved", () => {
    const { result } = setup({ checkpointId: "_first" });
    act(() => result.current.goPrev());
    expect(utils.review.next.fetch).not.toHaveBeenCalled();
  });
});

/** A promise to settle by hand, for an answer that is still on its way. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const STEP_BEFORE = `/projects/${PROJECT}/runs/${RUN}/checkpoints/step-0`;
const STEP_AFTER = `/projects/${PROJECT}/runs/${RUN}/checkpoints/step-2`;

const previous = () =>
  answer({
    target: { buildId: BUILD, runId: RUN, checkpointId: "step-0" },
    scope: "run",
  });

describe("useReviewLoop: a K answer racing a later move", () => {
  // The route commits only after the router's round trip, so the props still
  // name the old step when the K answer lands: the step-key guard cannot see
  // the move, and a navigation epoch has to.
  test("a K answer that lands after a J move is dropped", async () => {
    query.data = answer();
    const prev = deferred<Answer>();
    utils.review.next.fetch.mockReturnValue(prev.promise);
    const { result, rerender } = setup();
    act(() => result.current.goPrev());
    act(() => result.current.goNext());
    expect(router.replace).toHaveBeenCalledTimes(1);
    expect(router.replace).toHaveBeenLastCalledWith(STEP_AFTER);
    await act(async () => prev.resolve(previous()));
    expect(router.replace).toHaveBeenCalledTimes(1);
    expect(router.push).not.toHaveBeenCalled();
    // The key is free again once J's step is on screen.
    rerender(args({ checkpointId: "step-2" }));
    utils.review.next.fetch.mockResolvedValue(previous());
    await act(async () => result.current.goPrev());
    expect(router.replace).toHaveBeenLastCalledWith(STEP_BEFORE);
  });

  test("a K answer that lands after a decision's move is dropped", async () => {
    query.data = answer();
    const prev = deferred<Answer>();
    utils.review.next.fetch.mockReturnValue(prev.promise);
    const { result } = setup();
    act(() => result.current.goPrev());
    act(() => result.current.afterDecision());
    expect(router.replace).toHaveBeenLastCalledWith(STEP_AFTER);
    await act(async () => prev.resolve(previous()));
    expect(router.replace).toHaveBeenCalledTimes(1);
  });

  test("a K answer that lands after a decision's deferred move is dropped", async () => {
    query.isLoading = true;
    query.isFetching = true;
    const prev = deferred<Answer>();
    utils.review.next.fetch.mockReturnValue(prev.promise);
    const { result, rerender } = setup();
    act(() => result.current.afterDecision());
    act(() => result.current.goPrev());
    // The forward answer comes first and moves; K's, still on its way, is stale.
    query.isLoading = false;
    query.isFetching = false;
    query.data = answer();
    rerender(args());
    expect(router.replace).toHaveBeenCalledTimes(1);
    expect(router.replace).toHaveBeenLastCalledWith(STEP_AFTER);
    await act(async () => prev.resolve(previous()));
    expect(router.replace).toHaveBeenCalledTimes(1);
  });

  test("K navigating drops a waiting decision, so the late forward answer does not move again", async () => {
    query.isLoading = true;
    query.isFetching = true;
    utils.review.next.fetch.mockResolvedValue(previous());
    const { result, rerender } = setup();
    act(() => result.current.afterDecision());
    await act(async () => result.current.goPrev());
    expect(router.replace).toHaveBeenCalledTimes(1);
    expect(router.replace).toHaveBeenLastCalledWith(STEP_BEFORE);

    // The forward answer arrives for the step K left (props not changed yet).
    query.isLoading = false;
    query.isFetching = false;
    query.data = answer();
    rerender(args());
    expect(router.replace).toHaveBeenCalledTimes(1);
    expect(router.push).not.toHaveBeenCalled();
  });
});

describe("useReviewLoop: an answer being refreshed", () => {
  test("a decision waits for the refetch instead of acting on an invalidated cached answer", () => {
    // The cached answer names step-2; a refetch (after the decision
    // invalidated it) is on its way and may name another.
    query.data = answer();
    query.isFetching = true;
    const { result, rerender } = setup();
    act(() => result.current.afterDecision());
    expect(router.replace).not.toHaveBeenCalled();

    query.isFetching = false;
    query.data = answer({
      target: { buildId: BUILD, runId: RUN, checkpointId: "step-5" },
    });
    rerender(args());
    expect(router.replace).toHaveBeenCalledTimes(1);
    expect(router.replace).toHaveBeenCalledWith(
      `/projects/${PROJECT}/runs/${RUN}/checkpoints/step-5`,
    );
  });

  test("an answer that is not being refreshed is acted on at once", () => {
    query.data = answer();
    query.isFetching = false;
    const { result } = setup();
    act(() => result.current.afterDecision());
    expect(router.replace).toHaveBeenCalledTimes(1);
  });
});

describe("useReviewLoop: when review.next fails", () => {
  const boom = { message: "Something went wrong" };

  test("an error while a decision waits clears it, stays put, and is exposed", () => {
    query.isLoading = true;
    query.isFetching = true;
    const { result, rerender } = setup();
    expect(result.current.error).toBeNull();
    act(() => result.current.afterDecision());

    query.isLoading = false;
    query.isFetching = false;
    query.isError = true;
    query.error = boom;
    rerender(args());
    expect(result.current.error).toBe(boom);
    expect(router.replace).not.toHaveBeenCalled();

    // The wait is gone: a later good answer does not move it.
    query.isError = false;
    query.error = null;
    query.data = answer();
    rerender(args());
    expect(router.replace).not.toHaveBeenCalled();
    expect(result.current.error).toBeNull();
  });

  test("a decision on a query that has failed stays put and does not wait", () => {
    query.isError = true;
    query.error = boom;
    query.data = answer(); // what it knew before it failed
    const { result, rerender } = setup();
    act(() => result.current.afterDecision());
    expect(router.replace).not.toHaveBeenCalled();
    query.isError = false;
    query.error = null;
    rerender(args());
    expect(router.replace).not.toHaveBeenCalled();
  });

  test("an error is not shown while the loop is off", () => {
    query.isError = true;
    query.error = boom;
    const { result } = setup({ enabled: false });
    expect(result.current.error).toBeNull();
  });

  test("retry asks again", () => {
    const { result } = setup();
    act(() => result.current.retry());
    expect(query.refetch).toHaveBeenCalledTimes(1);
  });
});

describe("useReviewLoop: how long a decision waits", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  test("a decision whose answer takes longer than 10 s is dropped silently", () => {
    query.isLoading = true;
    query.isFetching = true;
    const { result, rerender } = setup();
    act(() => result.current.afterDecision());
    act(() => vi.advanceTimersByTime(10_001));

    query.isLoading = false;
    query.isFetching = false;
    query.data = answer();
    rerender(args());
    expect(router.replace).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
    expect(result.current.card).toBeNull();
  });

  test("an answer just inside the bound still moves", () => {
    query.isLoading = true;
    query.isFetching = true;
    const { result, rerender } = setup();
    act(() => result.current.afterDecision());
    act(() => vi.advanceTimersByTime(9_999));

    query.isLoading = false;
    query.isFetching = false;
    query.data = answer();
    rerender(args());
    expect(router.replace).toHaveBeenCalledTimes(1);
  });
});

describe("useReviewLoop: the order of cues", () => {
  test("a cue whose name arrives after a later move's cue is dropped", async () => {
    // First move: the run is not cached, so its name is on its way.
    const slow = deferred<{ name: string | null }>();
    utils.runs.getById.getData.mockReturnValueOnce(undefined);
    utils.runs.getById.fetch.mockReturnValue(slow.promise);
    query.data = answer({
      target: { buildId: BUILD, runId: OTHER_RUN, checkpointId: "step-9" },
      scope: "batch",
      remaining: { run: 0, batch: 4, batchUnfiltered: 4, projectBatches: 1 },
    });
    const { result, rerender } = setup();
    act(() => result.current.goNext());
    expect(router.push).toHaveBeenCalledTimes(1);

    // Second move, from the step the first one opened: cached, so it is said
    // at once.
    utils.runs.getById.getData.mockReturnValue({ name: "Second test" });
    query.data = answer({
      target: { buildId: BUILD, runId: "run-3", checkpointId: "step-1" },
      scope: "batch",
      remaining: { run: 0, batch: 3, batchUnfiltered: 3, projectBatches: 1 },
    });
    rerender(args({ runId: OTHER_RUN, checkpointId: "step-9" }));
    act(() => result.current.goNext());
    expect(useReviewAnnouncer.getState().text).toBe(
      "Next test: Second test · 3 left in batch",
    );

    // The first name finally arrives: too late to be said.
    await act(async () => slow.resolve({ name: "First test" }));
    expect(useReviewAnnouncer.getState().text).toBe(
      "Next test: Second test · 3 left in batch",
    );
  });
});

describe("useReviewLoop: stable callbacks", () => {
  test("the callbacks keep their identity across a re-render of the same step", () => {
    query.data = answer();
    const { result, rerender } = setup();
    const before = { ...result.current };
    // A new but equal context object, as an unmemoized caller would pass.
    rerender(
      args({
        context: { status: "needs-review", facets: {} } as ReviewContext,
      }),
    );
    expect(result.current.goNext).toBe(before.goNext);
    expect(result.current.goPrev).toBe(before.goPrev);
    expect(result.current.afterDecision).toBe(before.afterDecision);
    expect(result.current.dismissCard).toBe(before.dismissCard);
  });

  test("a new context value does change them (the links they build differ)", () => {
    query.data = answer();
    const { result, rerender } = setup();
    const before = result.current.goNext;
    rerender(args({ context: { status: "failed", facets: {} } }));
    expect(result.current.goNext).not.toBe(before);
  });

  test("a K still on its way for a step the reviewer left does not block K on the next one", () => {
    utils.review.next.fetch.mockReturnValue(new Promise(() => {}));
    const { result, rerender } = setup();
    act(() => result.current.goPrev());
    expect(utils.review.next.fetch).toHaveBeenCalledTimes(1);
    rerender(args({ checkpointId: "step-3" }));
    act(() => result.current.goPrev());
    expect(utils.review.next.fetch).toHaveBeenCalledTimes(2);
    expect(utils.review.next.fetch).toHaveBeenLastCalledWith(
      expect.objectContaining({
        at: { buildId: BUILD, runId: RUN, checkpointId: "step-3" },
      }),
    );
  });
});

describe("useReviewLoop: guards for the wired viewer", () => {
  const intoOtherRun = () =>
    answer({
      target: { buildId: BUILD, runId: OTHER_RUN, checkpointId: "step-9" },
      scope: "batch",
      remaining: { run: 0, batch: 4, batchUnfiltered: 4, projectBatches: 1 },
    });

  // In the viewer every step is a new instance of the page (the dynamic
  // segment remounts), so leaving the step by hand unmounts the hook: the K
  // answer still on its way must not take the reviewer back.
  test("a K answer that lands after the hook unmounts does not navigate", async () => {
    const prev = deferred<Answer>();
    utils.review.next.fetch.mockReturnValue(prev.promise);
    const { result, unmount } = setup();
    act(() => result.current.goPrev());
    unmount();
    await act(async () => prev.resolve(previous()));
    expect(router.replace).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
  });

  test("a cue still loading its name is not spoken after a later K move", async () => {
    // J moves into another test whose name is not cached yet.
    const slow = deferred<{ name: string | null }>();
    utils.runs.getById.getData.mockReturnValue(undefined);
    utils.runs.getById.fetch.mockReturnValue(slow.promise);
    query.data = intoOtherRun();
    const { result, rerender } = setup();
    act(() => result.current.goNext());
    expect(router.push).toHaveBeenCalledTimes(1);

    // The route commits, and K takes the reviewer back before the name comes.
    rerender(args({ runId: OTHER_RUN, checkpointId: "step-9" }));
    utils.review.next.fetch.mockResolvedValue(
      answer({
        target: { buildId: BUILD, runId: RUN, checkpointId: STEP },
        scope: "batch",
      }),
    );
    await act(async () => result.current.goPrev());
    expect(router.push).toHaveBeenCalledTimes(2);

    // The name arrives: it names a test the reviewer has already left.
    await act(async () => slow.resolve({ name: "Checkout" }));
    expect(useReviewAnnouncer.getState().text).toBe("");
  });

  test("a second J before the route commits does nothing", async () => {
    query.data = intoOtherRun();
    const { result, rerender } = setup();
    act(() => result.current.goNext());
    act(() => result.current.goNext());
    expect(router.push).toHaveBeenCalledTimes(1);
    // One move, one cue.
    expect(useReviewAnnouncer.getState().seq).toBe(1);
    // Nor does K: it would be asked from the step being left.
    await act(async () => result.current.goPrev());
    expect(utils.review.next.fetch).not.toHaveBeenCalled();

    // Once the step J opened is on screen, J works again.
    query.data = answer({
      target: { buildId: BUILD, runId: OTHER_RUN, checkpointId: "step-10" },
      scope: "run",
    });
    rerender(args({ runId: OTHER_RUN, checkpointId: "step-9" }));
    act(() => result.current.goNext());
    calledOnceWith(
      router.replace,
      `/projects/${PROJECT}/runs/${OTHER_RUN}/checkpoints/step-10`,
    );
  });

  test("a decision is not held back by a move still committing", () => {
    // The step on screen is still the one being left, and a decision on it
    // moves on as ever: only J and K wait for the route.
    query.data = answer();
    const { result } = setup();
    act(() => result.current.goNext());
    act(() => result.current.afterDecision());
    expect(router.replace).toHaveBeenCalledTimes(2);
  });
});

describe("useReviewLoop: the visible cue (R15)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  const intoOtherRun = () =>
    answer({
      target: { buildId: BUILD, runId: OTHER_RUN, checkpointId: "step-9" },
      scope: "batch",
      remaining: { run: 0, batch: 4, batchUnfiltered: 4, projectBatches: 1 },
    });
  const CUE = "Next test: Checkout · 4 left in batch";

  test("a forward move into another test shows its cue there, for about 3 s", () => {
    query.data = intoOtherRun();
    const { result, rerender } = setup();
    act(() => result.current.goNext());
    // Not on the test being left...
    expect(result.current.cue).toBeNull();
    // ...but on the one the move opened (a new page in the viewer).
    rerender(args({ runId: OTHER_RUN, checkpointId: "step-9" }));
    expect(result.current.cue).toBe(CUE);
    act(() => vi.advanceTimersByTime(2_999));
    expect(result.current.cue).toBe(CUE);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.cue).toBeNull();
  });

  test("a decision's move into another test shows the cue as well", () => {
    query.data = intoOtherRun();
    const { result, rerender } = setup();
    act(() => result.current.afterDecision());
    rerender(args({ runId: OTHER_RUN, checkpointId: "step-9" }));
    expect(result.current.cue).toBe(CUE);
  });

  test("waits for the test's name when it is not cached", async () => {
    const slow = deferred<{ name: string | null }>();
    utils.runs.getById.getData.mockReturnValue(undefined);
    utils.runs.getById.fetch.mockReturnValue(slow.promise);
    query.data = intoOtherRun();
    const { result, rerender } = setup();
    act(() => result.current.goNext());
    rerender(args({ runId: OTHER_RUN, checkpointId: "step-9" }));
    expect(result.current.cue).toBeNull();
    await act(async () => slow.resolve({ name: "Checkout" }));
    expect(result.current.cue).toBe(CUE);
  });

  test("a K move into another test shows no cue (R16)", async () => {
    utils.review.next.fetch.mockResolvedValue(intoOtherRun());
    const { result, rerender } = setup();
    await act(async () => result.current.goPrev());
    expect(router.push).toHaveBeenCalledOnce();
    rerender(args({ runId: OTHER_RUN, checkpointId: "step-9" }));
    expect(result.current.cue).toBeNull();
  });

  test("a later move takes it down at once", async () => {
    query.data = intoOtherRun();
    const { result, rerender } = setup();
    act(() => result.current.goNext());
    rerender(args({ runId: OTHER_RUN, checkpointId: "step-9" }));
    expect(result.current.cue).toBe(CUE);
    // K goes back to the step before, in this same test.
    utils.review.next.fetch.mockResolvedValue(
      answer({
        target: { buildId: BUILD, runId: OTHER_RUN, checkpointId: "step-8" },
        scope: "run",
      }),
    );
    await act(async () => result.current.goPrev());
    expect(router.replace).toHaveBeenCalledOnce();
    expect(result.current.cue).toBeNull();
  });

  test("is not shown while the loop is off", () => {
    query.data = intoOtherRun();
    const { result, rerender } = setup();
    act(() => result.current.goNext());
    rerender(
      args({ runId: OTHER_RUN, checkpointId: "step-9", enabled: false }),
    );
    expect(result.current.cue).toBeNull();
  });
});
