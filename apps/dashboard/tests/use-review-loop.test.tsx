import { act, cleanup, render, renderHook } from "@testing-library/react";
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
import {
  leftInBatchLabel,
  loopHandoff,
  useLoopCue,
  useReviewLoop,
} from "@/lib/review/use-review-loop";
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
    getStep: { prefetch: vi.fn() },
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
    // The step on screen is settled (decided, passed, read-only) unless a
    // test says it still needs review.
    stepPending: false,
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
  utils.runs.getStep.prefetch.mockReset();
  // A target run that is already cached, with a name.
  utils.runs.getById.getData.mockReturnValue({ name: "Checkout" });
  useReviewAnnouncer.setState({ text: "", seq: 0 });
  useLoopCue.setState({ cue: null });
  loopHandoff.slot = null;
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

    test("with facets, nothing left in the filter anywhere: Batch done, not All caught up", () => {
      // Steps outside the filter may wait elsewhere: only the batch is
      // known to be done.
      query.data = answer({
        target: null,
        scope: "none",
        remaining: { run: 0, batch: 0, batchUnfiltered: 0, projectBatches: 0 },
      });
      const { result } = setup({
        context: { status: "needs-review", facets: { os: "macOS" } },
      });
      act(() => result.current[move]());
      expect(result.current.card).toBe("batch");
    });

    test("none: shows the filtered card when steps are left outside the filters", () => {
      // Nothing is left anywhere inside the filters, but this batch still has
      // steps outside them: the filtered set is done, not everything.
      query.data = answer({
        target: null,
        scope: "none",
        remaining: { run: 0, batch: 0, batchUnfiltered: 2, projectBatches: 0 },
      });
      const { result } = setup({
        context: { status: "needs-review", facets: { os: "macOS" } },
      });
      act(() => result.current[move]());
      expect(result.current.card).toBe("filtered");
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

  test("the comparison mode travels too, after the context (spec §6.3)", async () => {
    const context: ReviewContext = { status: "failed", facets: {} };
    query.data = answer({
      target: { buildId: BUILD, runId: OTHER_RUN, checkpointId: "step-9" },
      scope: "batch",
    });
    const { result } = setup({ context, view: "swipe" });
    act(() => result.current.goNext());
    expect(router.push).toHaveBeenLastCalledWith(
      `/projects/${PROJECT}/runs/${OTHER_RUN}/checkpoints/step-9?status=failed&view=swipe`,
    );
    cleanup();

    // K's answer comes later: it carries the view the reviewer has then.
    const prev = deferred<Answer>();
    utils.review.next.fetch.mockReturnValue(prev.promise);
    const k = setup({ context, view: "swipe" });
    act(() => k.result.current.goPrev());
    k.rerender(args({ context, view: "diff" }));
    await act(async () =>
      prev.resolve(
        answer({
          target: { buildId: BUILD, runId: RUN, checkpointId: "step-0" },
        }),
      ),
    );
    expect(router.replace).toHaveBeenLastCalledWith(
      `/projects/${PROJECT}/runs/${RUN}/checkpoints/step-0?status=failed&view=diff`,
    );
  });

  test("with the view, the step on screen is still not opened again", () => {
    query.data = answer({
      target: { buildId: BUILD, runId: RUN, checkpointId: STEP },
    });
    const { result } = setup({ view: "overlay" });
    act(() => result.current.goNext());
    expect(router.replace).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
  });
});

describe("useReviewLoop.retarget: a mode change while a navigation is on its way (R20)", () => {
  const url = (runId: string, step: string, query = "") =>
    `/projects/${PROJECT}/runs/${runId}/checkpoints/${step}${query}`;
  const intoOtherTest = () =>
    answer({
      target: { buildId: BUILD, runId: OTHER_RUN, checkpointId: "step-9" },
      scope: "batch",
    });
  /** `retarget`'s answer, made inside act. */
  function retarget(
    result: { current: ReturnType<typeof useReviewLoop> },
    view: Parameters<ReturnType<typeof useReviewLoop>["retarget"]>[0],
  ): boolean {
    let made = false;
    act(() => {
      made = result.current.retarget(view);
    });
    return made;
  }

  test("with nothing on its way: false, and no navigation", () => {
    query.data = intoOtherTest();
    const { result } = setup({ view: "overlay" });
    expect(retarget(result, "diff")).toBe(false);
    expect(router.push).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
  });

  test("J's push goes again in the new mode, still a push, and is the move the loop waits for", () => {
    query.data = intoOtherTest();
    const { result, rerender } = setup({ view: "overlay" });
    act(() => result.current.goNext());
    expect(retarget(result, "diff")).toBe(true);
    expect(router.push.mock.calls).toEqual([
      [url(OTHER_RUN, "step-9", "?view=overlay")],
      [url(OTHER_RUN, "step-9", "?view=diff")],
    ]);
    expect(router.replace).not.toHaveBeenCalled();

    // The viewer re-renders in Diff. A decision now goes where the move
    // already goes: it is not made a second time. J is still latched.
    rerender(args({ view: "diff" }));
    act(() => result.current.afterDecision());
    act(() => result.current.goNext());
    expect(router.push).toHaveBeenCalledTimes(2);

    // The next test's route commits: the latch is let go, and J moves on.
    query.data = answer({
      target: { buildId: BUILD, runId: OTHER_RUN, checkpointId: "step-10" },
    });
    rerender(args({ view: "diff", runId: OTHER_RUN, checkpointId: "step-9" }));
    // Nothing of the step left is on its way any more.
    expect(retarget(result, "swipe")).toBe(false);
    act(() => result.current.goNext());
    expect(router.replace).toHaveBeenCalledOnce();
    expect(router.replace).toHaveBeenCalledWith(
      url(OTHER_RUN, "step-10", "?view=diff"),
    );
  });

  test("a decision's move in this test goes again as a replace", () => {
    query.data = answer();
    const { result } = setup({ view: "overlay" });
    act(() => result.current.afterDecision());
    expect(retarget(result, "swipe")).toBe(true);
    expect(router.replace.mock.calls).toEqual([
      [url(RUN, "step-2", "?view=overlay")],
      [url(RUN, "step-2", "?view=swipe")],
    ]);
    expect(router.push).not.toHaveBeenCalled();
  });

  test("while K only asks, nothing is on its way: its answer goes in the mode of then", async () => {
    const prev = deferred<Answer>();
    utils.review.next.fetch.mockReturnValue(prev.promise);
    const { result, rerender } = setup({ view: "overlay" });
    act(() => result.current.goPrev());
    // No navigation yet: the viewer writes its own URL, and re-renders.
    expect(retarget(result, "diff")).toBe(false);
    expect(router.replace).not.toHaveBeenCalled();
    rerender(args({ view: "diff" }));
    await act(async () =>
      prev.resolve(
        answer({
          target: { buildId: BUILD, runId: RUN, checkpointId: "step-0" },
        }),
      ),
    );
    expect(router.replace).toHaveBeenLastCalledWith(
      url(RUN, "step-0", "?view=diff"),
    );
  });

  test("Continue and Clear filter go again in the new mode, keeping their URL's context", async () => {
    const FACETED: ReviewContext = {
      status: "failed",
      facets: { browser: "chromium" },
    };
    query.data = answer({
      target: { buildId: "b2", runId: "r9", checkpointId: "s9" },
      scope: "nextBatch",
      remaining: { run: 0, batch: 0, batchUnfiltered: 2, projectBatches: 2 },
      nextBatch,
    });
    const card = setup({ context: FACETED, view: "overlay" });
    act(() => card.result.current.afterDecision());
    act(() => card.result.current.continueToNextBatch());
    expect(retarget(card.result, "flicker")).toBe(true);
    expect(router.push).toHaveBeenLastCalledWith(
      url("r9", "s9", "?status=failed&browser=chromium&view=flicker"),
    );
    // The card stays busy until the route commits.
    expect(card.result.current.cardBusy).toBe(true);
    cleanup();
    router.push.mockReset();

    utils.review.next.fetch.mockResolvedValue(
      answer({
        target: { buildId: BUILD, runId: OTHER_RUN, checkpointId: "step-9" },
        scope: "batch",
      }),
    );
    const cleared = setup({ context: FACETED, view: "overlay" });
    act(() => cleared.result.current.afterDecision());
    await act(async () => cleared.result.current.clearFilter());
    expect(retarget(cleared.result, "flicker")).toBe(true);
    expect(router.push).toHaveBeenLastCalledWith(
      url(OTHER_RUN, "step-9", "?status=failed&view=flicker"),
    );
  });

  test("leaving the viewer: the departure goes on as it is", () => {
    const { result } = setup({ view: "overlay" });
    act(() => result.current.leave("/projects/p1/builds/b1"));
    expect(retarget(result, "diff")).toBe(true);
    expect(router.push).toHaveBeenCalledOnce();
    expect(router.replace).not.toHaveBeenCalled();
  });

  test("a move given up on (5 s) is not made again", () => {
    vi.useFakeTimers();
    query.data = intoOtherTest();
    const { result } = setup({ view: "overlay" });
    act(() => result.current.goNext());
    act(() => vi.advanceTimersByTime(5_000));
    expect(retarget(result, "diff")).toBe(false);
    expect(router.push).toHaveBeenCalledOnce();
  });

  test("R22: a link's navigation to a step goes again in the new mode, a push, until its route commits", () => {
    const { result, rerender } = setup({ view: "overlay" });
    const newer = (view: string | null) =>
      url("r9", "s9", view ? `?view=${view}` : "");
    // Next makes the link's own navigation; the loop only hears of it.
    act(() => result.current.linkNavigating(newer("overlay"), newer));
    expect(router.push).not.toHaveBeenCalled();
    expect(retarget(result, "swipe")).toBe(true);
    expect(router.push.mock.calls).toEqual([[newer("swipe")]]);
    expect(router.replace).not.toHaveBeenCalled();
    // The same mode again: the navigation already goes there.
    expect(retarget(result, "swipe")).toBe(true);
    expect(router.push).toHaveBeenCalledOnce();
    // Committed: nothing is on its way from here any more.
    rerender(args({ view: "swipe", runId: "r9", checkpointId: "s9" }));
    expect(retarget(result, "diff")).toBe(false);
  });

  test("R22: a link out of the viewer goes on as it is", () => {
    const { result } = setup({ view: "overlay" });
    act(() => result.current.linkNavigating("/projects/p1/builds/b1"));
    expect(retarget(result, "diff")).toBe(true);
    expect(router.push).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
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

describe("leftInBatchLabel: the pill's and the cue's count (R33)", () => {
  const remaining = { run: 1, batch: 2, batchUnfiltered: 6, projectBatches: 1 };
  const settled = { pending: false, inFilter: true };

  test("without facets: what is left after the step, plus the step while it needs review", () => {
    const flat = { ...remaining, batchUnfiltered: 2 };
    expect(leftInBatchLabel(flat, false, settled)).toBe("2 left in batch");
    expect(
      leftInBatchLabel(flat, false, { pending: true, inFilter: true }),
    ).toBe("3 left in batch");
  });

  test("with facets: the batch and the filter, the step counted in the filter only inside it", () => {
    expect(leftInBatchLabel(remaining, true, settled)).toBe(
      "6 left in batch · 2 in filter",
    );
    expect(
      leftInBatchLabel(remaining, true, { pending: true, inFilter: true }),
    ).toBe("7 left in batch · 3 in filter");
    expect(
      leftInBatchLabel(remaining, true, { pending: true, inFilter: false }),
    ).toBe("7 left in batch · 2 in filter");
  });
});

describe("useReviewLoop: the cue's count is the one shown on arrival (R33)", () => {
  const filtered: ReviewContext = {
    status: "needs-review",
    facets: { browser: "chromium" },
  };
  const batchAnswer = () =>
    answer({
      target: { buildId: BUILD, runId: OTHER_RUN, checkpointId: "step-9" },
      scope: "batch",
      remaining: { run: 0, batch: 2, batchUnfiltered: 4, projectBatches: 1 },
    });

  test("J from a step that needs review counts it, in the filter's wording", () => {
    query.data = batchAnswer();
    const { result } = setup({ context: filtered, stepPending: true });
    act(() => result.current.goNext());
    expect(useReviewAnnouncer.getState().text).toBe(
      "Next test: Checkout · 5 left in batch · 3 in filter",
    );
  });

  test("J from a pending step outside the filter counts it in the batch only", () => {
    query.data = batchAnswer();
    const { result } = setup({
      context: filtered,
      stepPending: true,
      stepInFilter: false,
    });
    act(() => result.current.goNext());
    expect(useReviewAnnouncer.getState().text).toBe(
      "Next test: Checkout · 5 left in batch · 2 in filter",
    );
  });

  test("a decision does not count its own step, though its update has not rendered yet", () => {
    query.data = batchAnswer();
    // The decision's optimistic update comes after `afterDecision`: the step
    // still reads as pending here.
    const { result } = setup({ context: filtered, stepPending: true });
    act(() => result.current.afterDecision());
    expect(useReviewAnnouncer.getState().text).toBe(
      "Next test: Checkout · 4 left in batch · 2 in filter",
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

describe("useReviewLoop: the card's moves (R18)", () => {
  const FACETED: ReviewContext = {
    status: "failed",
    facets: { browser: "chromium" },
  };
  /** This batch is done inside the filters; `left` steps are outside them. */
  const intoNextBatch = (left = 0) =>
    answer({
      target: { buildId: "b2", runId: "r9", checkpointId: "s9" },
      scope: "nextBatch",
      remaining: {
        run: 0,
        batch: 0,
        batchUnfiltered: left,
        projectBatches: 2,
      },
      nextBatch,
    });
  /** The card is up, from a decision on the step on screen. */
  function withCard(left = 0, context: ReviewContext = FACETED) {
    query.data = intoNextBatch(left);
    const hook = setup({ context });
    act(() => hook.result.current.afterDecision());
    expect(hook.result.current.card).toBe(left > 0 ? "filtered" : "batch");
    return hook;
  }

  test("Continue opens the next batch's first pending step, keeping the facets", () => {
    const { result } = withCard();
    act(() => result.current.continueToNextBatch());
    calledOnceWith(
      router.push,
      `/projects/${PROJECT}/runs/r9/checkpoints/s9?status=failed&browser=chromium`,
    );
    expect(router.replace).not.toHaveBeenCalled();
    // No cue: the card has already said where it goes.
    expect(useReviewAnnouncer.getState().seq).toBe(0);
    expect(useLoopCue.getState().cue).toBeNull();
  });

  test("Continue keeps the card up and busy until the route commits", () => {
    const { result, rerender } = withCard();
    expect(result.current.cardBusy).toBe(false);
    act(() => result.current.continueToNextBatch());
    // Not put away: the step behind it is not the one being opened.
    expect(result.current.card).toBe("batch");
    expect(result.current.cardBusy).toBe(true);
    // Pressing again meanwhile does nothing.
    act(() => result.current.continueToNextBatch());
    act(() => result.current.clearFilter());
    expect(router.push).toHaveBeenCalledOnce();
    expect(utils.review.next.fetch).not.toHaveBeenCalled();
    // The route commits: the next batch's step is on screen, with no card.
    rerender(
      args({
        context: FACETED,
        buildId: "b2",
        runId: "r9",
        checkpointId: "s9",
      }),
    );
    expect(result.current.card).toBeNull();
    expect(result.current.cardBusy).toBe(false);
  });

  test("the card is busy for at most 5 s: a move the route never commits lets it go", () => {
    vi.useFakeTimers();
    const { result } = withCard();
    act(() => result.current.continueToNextBatch());
    act(() => vi.advanceTimersByTime(4_999));
    expect(result.current.cardBusy).toBe(true);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.cardBusy).toBe(false);
    // And Continue works again.
    act(() => result.current.continueToNextBatch());
    expect(router.push).toHaveBeenCalledTimes(2);
  });

  test("Continue does nothing unless the answer leads into another batch", () => {
    query.data = answer({
      target: null,
      scope: "none",
      remaining: { run: 0, batch: 0, batchUnfiltered: 0, projectBatches: 0 },
    });
    const { result } = setup();
    act(() => result.current.afterDecision());
    act(() => result.current.continueToNextBatch());
    // A step in this batch is not "the next batch" either.
    query.data = answer({ nextBatch });
    act(() => result.current.continueToNextBatch());
    expect(router.push).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
    expect(result.current.card).toBe("all");
  });

  test("Continue goes through the move guards: once, and it drops a K answer still on its way", async () => {
    const prev = deferred<Answer>();
    utils.review.next.fetch.mockReturnValue(prev.promise);
    const { result } = withCard();
    act(() => result.current.goPrev());
    act(() => result.current.continueToNextBatch());
    act(() => result.current.continueToNextBatch());
    expect(router.push).toHaveBeenCalledOnce();
    await act(async () => prev.resolve(previous()));
    expect(router.replace).not.toHaveBeenCalled();
    expect(router.push).toHaveBeenCalledOnce();
  });

  test("Clear filter moves to the first unfiltered pending step and drops the facets from the URL", async () => {
    utils.review.next.fetch.mockResolvedValue(
      answer({
        target: { buildId: BUILD, runId: OTHER_RUN, checkpointId: "step-9" },
        scope: "batch",
        remaining: { run: 0, batch: 3, batchUnfiltered: 3, projectBatches: 2 },
      }),
    );
    const { result } = withCard(4);
    await act(async () => result.current.clearFilter());
    // Asked from the step on screen, with no facets (and forward).
    calledOnceWith(utils.review.next.fetch, {
      projectId: PROJECT,
      at: { buildId: BUILD, runId: RUN, checkpointId: STEP },
    });
    // Into another test: pushed. The status stays, the facets go.
    calledOnceWith(
      router.push,
      `/projects/${PROJECT}/runs/${OTHER_RUN}/checkpoints/step-9?status=failed`,
    );
    expect(router.replace).not.toHaveBeenCalled();
    // The card stays up, busy, until the route commits.
    expect(result.current.card).toBe("filtered");
    expect(result.current.cardBusy).toBe(true);
  });

  test("Continue and Clear filter carry the comparison mode (spec §6.3)", async () => {
    query.data = intoNextBatch(4);
    const hook = setup({ context: FACETED, view: "flicker" });
    act(() => hook.result.current.afterDecision());
    act(() => hook.result.current.continueToNextBatch());
    calledOnceWith(
      router.push,
      `/projects/${PROJECT}/runs/r9/checkpoints/s9?status=failed&browser=chromium&view=flicker`,
    );
    cleanup();
    router.push.mockReset();

    utils.review.next.fetch.mockResolvedValue(
      answer({
        target: { buildId: BUILD, runId: OTHER_RUN, checkpointId: "step-9" },
        scope: "batch",
        remaining: { run: 0, batch: 3, batchUnfiltered: 3, projectBatches: 2 },
      }),
    );
    const cleared = setup({ context: FACETED, view: "flicker" });
    act(() => cleared.result.current.afterDecision());
    await act(async () => cleared.result.current.clearFilter());
    calledOnceWith(
      router.push,
      `/projects/${PROJECT}/runs/${OTHER_RUN}/checkpoints/step-9?status=failed&view=flicker`,
    );
  });

  test("Clear filter is busy from the press: a second press asks once", async () => {
    const cleared = deferred<Answer>();
    utils.review.next.fetch.mockReturnValue(cleared.promise);
    const { result } = withCard(3);
    act(() => result.current.clearFilter());
    expect(result.current.cardBusy).toBe(true);
    act(() => result.current.clearFilter());
    act(() => result.current.continueToNextBatch());
    expect(utils.review.next.fetch).toHaveBeenCalledOnce();
    expect(router.push).not.toHaveBeenCalled();
    // Nothing left after all: the batch card, no longer busy.
    await act(async () => cleared.resolve(intoNextBatch(0)));
    expect(result.current.card).toBe("batch");
    expect(result.current.cardBusy).toBe(false);
  });

  test("Clear filter into another run announces the next test", async () => {
    // A forward move into a test the reviewer did not pick (R26): the cue,
    // with the count outside the filter (the answer was asked without it).
    utils.runs.getById.getData.mockReturnValue({ name: "Login flow" });
    utils.review.next.fetch.mockResolvedValue(
      answer({
        target: { buildId: BUILD, runId: OTHER_RUN, checkpointId: "step-9" },
        scope: "batch",
        remaining: { run: 0, batch: 3, batchUnfiltered: 3, projectBatches: 2 },
      }),
    );
    const { result, rerender } = withCard(4);
    await act(async () => result.current.clearFilter());
    expect(useReviewAnnouncer.getState().text).toBe(
      "Next test: Login flow · 3 left in batch",
    );
    // The chip too, on the test it opens.
    rerender(
      args({ context: FACETED, runId: OTHER_RUN, checkpointId: "step-9" }),
    );
    expect(result.current.cue).toBe("Next test: Login flow · 3 left in batch");
  });

  test("Clear filter in this run says nothing", async () => {
    utils.review.next.fetch.mockResolvedValue(
      answer({
        target: { buildId: BUILD, runId: RUN, checkpointId: "step-5" },
        scope: "run",
      }),
    );
    const { result } = withCard(1);
    await act(async () => result.current.clearFilter());
    expect(router.replace).toHaveBeenCalledOnce();
    expect(useReviewAnnouncer.getState().seq).toBe(0);
  });

  test("Clear filter replaces the URL when that step is in this run", async () => {
    utils.review.next.fetch.mockResolvedValue(
      answer({
        target: { buildId: BUILD, runId: RUN, checkpointId: "step-5" },
        scope: "run",
      }),
    );
    const { result } = withCard(1);
    await act(async () => result.current.clearFilter());
    calledOnceWith(
      router.replace,
      `/projects/${PROJECT}/runs/${RUN}/checkpoints/step-5?status=failed`,
    );
    expect(router.push).not.toHaveBeenCalled();
  });

  test("Clear filter shows the batch card when nothing is left in the batch after all", async () => {
    // A teammate took the last of them meanwhile.
    utils.review.next.fetch.mockResolvedValue(intoNextBatch(0));
    const { result } = withCard(2);
    expect(result.current.card).toBe("filtered");
    await act(async () => result.current.clearFilter());
    expect(router.push).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
    expect(result.current.card).toBe("batch");
  });

  test("Clear filter shows All caught up when nothing is left anywhere", async () => {
    // Asked without the filter, so nothing is left in the project at all.
    utils.review.next.fetch.mockResolvedValue(
      answer({
        target: null,
        scope: "none",
        remaining: { run: 0, batch: 0, batchUnfiltered: 0, projectBatches: 0 },
      }),
    );
    const { result } = withCard(2);
    await act(async () => result.current.clearFilter());
    expect(router.push).not.toHaveBeenCalled();
    expect(result.current.card).toBe("all");
  });

  test("a Clear filter answer that lands after another move is dropped", async () => {
    const cleared = deferred<Answer>();
    utils.review.next.fetch.mockReturnValue(cleared.promise);
    const { result, rerender } = withCard(3);
    act(() => result.current.clearFilter());
    // Next pending (the header's) moves first: the batch filled up again.
    query.data = answer({
      target: { buildId: BUILD, runId: RUN, checkpointId: "step-4" },
      scope: "run",
    });
    rerender(args({ context: FACETED }));
    act(() => result.current.goNext());
    expect(router.replace).toHaveBeenCalledOnce();
    await act(async () =>
      cleared.resolve(
        answer({
          target: { buildId: BUILD, runId: OTHER_RUN, checkpointId: "step-9" },
          scope: "batch",
        }),
      ),
    );
    expect(router.replace).toHaveBeenCalledOnce();
    expect(router.push).not.toHaveBeenCalled();
    // Dropped, it is no longer busy.
    expect(result.current.cardBusy).toBe(false);
  });

  test("a Clear filter lookup that lands after Esc does not navigate", async () => {
    const cleared = deferred<Answer>();
    utils.review.next.fetch.mockReturnValue(cleared.promise);
    const { result } = withCard(3);
    act(() => result.current.clearFilter());
    // Esc (or a back link) leaves before the lookup comes back.
    const back = `/projects/${PROJECT}/builds/${BUILD}#run-${RUN}`;
    act(() => result.current.leave(back));
    calledOnceWith(router.push, back);
    await act(async () =>
      cleared.resolve(
        answer({
          target: { buildId: BUILD, runId: OTHER_RUN, checkpointId: "step-9" },
          scope: "batch",
        }),
      ),
    );
    expect(router.push).toHaveBeenCalledOnce();
    expect(router.replace).not.toHaveBeenCalled();
    expect(useReviewAnnouncer.getState().seq).toBe(0);
  });

  test("a Clear filter fallback that lands after an undo brings no card", async () => {
    const cleared = deferred<Answer>();
    utils.review.next.fetch.mockReturnValue(cleared.promise);
    const { result, rerender } = withCard(2);
    act(() => result.current.clearFilter());
    // ⌘Z before the lookup comes back: the step needs review again, and the
    // card goes with it, no longer busy (R30).
    rerender(args({ context: FACETED, stepPending: true }));
    expect(result.current.card).toBeNull();
    expect(result.current.cardBusy).toBe(false);
    // Nothing is left in the batch after all: the fallback would be the
    // batch card, over the step just put back.
    await act(async () => cleared.resolve(intoNextBatch(0)));
    expect(result.current.card).toBeNull();
    expect(result.current.cardBusy).toBe(false);
    expect(router.push).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
    // Settled again some other way (Mark as Bug): still none.
    rerender(args({ context: FACETED, stepPending: false }));
    expect(result.current.card).toBeNull();
  });

  test("an undo while Clear filter looks up cancels its move", async () => {
    const cleared = deferred<Answer>();
    utils.review.next.fetch.mockReturnValue(cleared.promise);
    const { result, rerender } = withCard(2);
    act(() => result.current.clearFilter());
    expect(result.current.cardBusy).toBe(true);
    // ⌘Z on the step on screen before the lookup comes back (R30).
    rerender(args({ context: FACETED, stepPending: true }));
    expect(result.current.cardBusy).toBe(false);
    // The lookup finds a step in this batch: it is not gone to.
    await act(async () =>
      cleared.resolve(
        answer({
          target: { buildId: BUILD, runId: OTHER_RUN, checkpointId: "step-9" },
          scope: "batch",
        }),
      ),
    );
    expect(router.push).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
    expect(result.current.card).toBeNull();
    expect(useReviewAnnouncer.getState().seq).toBe(0);
  });

  test("leaving drops a K answer still on its way too", async () => {
    const prev = deferred<Answer>();
    utils.review.next.fetch.mockReturnValue(prev.promise);
    const { result } = withCard();
    act(() => result.current.goPrev());
    act(() => result.current.leave("/inbox"));
    await act(async () => prev.resolve(previous()));
    calledOnceWith(router.push, "/inbox");
    expect(router.replace).not.toHaveBeenCalled();
  });

  test("Clear filter waits for a move still on its way, as K does", async () => {
    const { result } = withCard(3);
    act(() => result.current.continueToNextBatch());
    await act(async () => result.current.clearFilter());
    expect(utils.review.next.fetch).not.toHaveBeenCalled();
  });

  test("a failed Clear filter lookup stays put, and the button works again", async () => {
    utils.review.next.fetch.mockRejectedValueOnce(new Error("down"));
    const { result } = withCard(3);
    await act(async () => result.current.clearFilter());
    expect(router.push).not.toHaveBeenCalled();
    expect(result.current.card).toBe("filtered");
    expect(result.current.cardBusy).toBe(false);
    utils.review.next.fetch.mockResolvedValue(
      answer({
        target: { buildId: BUILD, runId: OTHER_RUN, checkpointId: "step-9" },
        scope: "batch",
      }),
    );
    await act(async () => result.current.clearFilter());
    expect(router.push).toHaveBeenCalledOnce();
  });

  test.each([
    ["in this run", "run", RUN, router.replace],
    ["in another test", "batch", OTHER_RUN, router.push],
  ] as const)(
    "a move from a card's step keeps the card until the step changes (%s)",
    (_name, scope, runId, navigate) => {
      // J at the batch boundary showed the card; then a step needing review
      // turns up in the batch (a teammate's undo), and Next goes there.
      query.data = intoNextBatch();
      const { result, rerender } = setup();
      act(() => result.current.goNext());
      expect(result.current.card).toBe("batch");
      query.data = answer({
        target: { buildId: BUILD, runId, checkpointId: "step-9" },
        scope,
      });
      rerender(args());
      act(() => result.current.goNext());
      expect(navigate).toHaveBeenCalledOnce();
      // Up until the route commits (R24)...
      expect(result.current.card).toBe("batch");
      // ...and gone with the step it was on.
      rerender(args({ runId, checkpointId: "step-9" }));
      expect(result.current.card).toBeNull();
    },
  );
});

describe("useReviewLoop: the batch boundary on a step that needs review (R23, R27)", () => {
  const boundary = (left = 0) =>
    answer({
      target: { buildId: "b2", runId: "r9", checkpointId: "s9" },
      scope: "nextBatch",
      remaining: {
        run: 0,
        batch: 0,
        batchUnfiltered: left,
        projectBatches: 2,
      },
      nextBatch,
    });
  const IN_BATCH = "Last step to review in this batch.";
  const IN_FILTER = "Last step to review in this filter.";

  test("J says this is the last step, shows it for about 3 s, and sets no card", () => {
    vi.useFakeTimers();
    query.data = boundary();
    const { result } = setup({ stepPending: true });
    act(() => result.current.goNext());
    expect(result.current.card).toBeNull();
    expect(router.push).not.toHaveBeenCalled();
    expect(useReviewAnnouncer.getState().text).toBe(IN_BATCH);
    // The same words on the chip, on this test.
    expect(result.current.cue).toBe(IN_BATCH);
    act(() => vi.advanceTimersByTime(3_000));
    expect(result.current.cue).toBeNull();
  });

  test.each([
    ["steps are left outside the filter", { os: "macOS" }, 2, IN_FILTER],
    ["nothing is left outside the filter", { os: "macOS" }, 0, IN_BATCH],
    ["no filter is set", {}, 0, IN_BATCH],
  ] as const)("the words when %s", (_name, facets, left, text) => {
    query.data = boundary(left);
    const { result } = setup({
      stepPending: true,
      context: { status: "needs-review", facets },
    });
    act(() => result.current.goNext());
    expect(useReviewAnnouncer.getState().text).toBe(text);
  });

  test("nothing left anywhere is the same: no All caught up over a step to review", () => {
    query.data = answer({
      target: null,
      scope: "none",
      remaining: { run: 0, batch: 0, batchUnfiltered: 0, projectBatches: 0 },
    });
    const { result } = setup({ stepPending: true });
    act(() => result.current.goNext());
    expect(result.current.card).toBeNull();
    expect(useReviewAnnouncer.getState().text).toBe(IN_BATCH);
  });

  test("J waiting for its answer says it when the answer comes", () => {
    query.isFetching = true;
    const { result, rerender } = setup({ stepPending: true });
    act(() => result.current.goNext());
    query.isFetching = false;
    query.data = boundary();
    rerender(args({ stepPending: true }));
    expect(result.current.card).toBeNull();
    expect(useReviewAnnouncer.getState().text).toBe(IN_BATCH);
  });

  test("a decision is never held to it: its own update has not landed yet", () => {
    query.data = boundary();
    const { result } = setup({ stepPending: true });
    act(() => result.current.afterDecision());
    expect(result.current.card).toBe("batch");
    expect(useReviewAnnouncer.getState().seq).toBe(0);
  });

  test("a decision waiting for its answer is not held to it either", () => {
    query.isFetching = true;
    const { result, rerender } = setup({ stepPending: true });
    act(() => result.current.afterDecision());
    query.isFetching = false;
    query.data = boundary();
    rerender(args({ stepPending: true }));
    expect(result.current.card).toBe("batch");
  });

  test("K at the boundary: the same words on a step to review, the card on a settled one", async () => {
    utils.review.next.fetch.mockResolvedValue(boundary());
    const pending = setup({ stepPending: true });
    await act(async () => pending.result.current.goPrev());
    expect(pending.result.current.card).toBeNull();
    expect(useReviewAnnouncer.getState().text).toBe(IN_BATCH);
    pending.unmount();

    const settled = setup();
    await act(async () => settled.result.current.goPrev());
    expect(settled.result.current.card).toBe("batch");
    expect(router.push).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
  });

  test("the step needing review again drops the card for good", () => {
    // The decision brought the card; ⌘Z (or a refused decision) puts the
    // step back, and the card goes with it.
    query.data = boundary();
    const { result, rerender } = setup({ stepPending: true });
    act(() => result.current.afterDecision());
    rerender(args({ stepPending: false })); // the decision lands
    expect(result.current.card).toBe("batch");
    rerender(args({ stepPending: true })); // undone
    expect(result.current.card).toBeNull();
    // Settled again by something that is not a decision here (Mark as Bug,
    // approve pending, an override): no card comes back.
    rerender(args({ stepPending: false }));
    expect(result.current.card).toBeNull();
  });

  test("a waiting decision that is undone before its answer lands brings no card", () => {
    // The answer is being refetched when the decision is made: it waits.
    query.isFetching = true;
    const { result, rerender } = setup({ stepPending: true });
    act(() => result.current.afterDecision());
    expect(result.current.pending).toBe(true);
    rerender(args({ stepPending: false })); // the decision lands
    rerender(args({ stepPending: true })); // ⌘Z, or the decision is refused
    expect(result.current.pending).toBe(false);
    // Its answer comes: the batch is done, but the step needs review again.
    query.isFetching = false;
    query.data = boundary();
    rerender(args({ stepPending: true }));
    expect(result.current.pending).toBe(false);
    expect(result.current.card).toBeNull();
    // Settled again some other way (Mark as Bug): no card comes back.
    rerender(args({ stepPending: false }));
    expect(result.current.card).toBeNull();
  });

  test("an undo while a decision waits cancels its move (run or batch answer)", () => {
    for (const later of [
      answer({
        target: { buildId: BUILD, runId: RUN, checkpointId: "step-2" },
        scope: "run",
      }),
      answer({
        target: { buildId: BUILD, runId: OTHER_RUN, checkpointId: "step-9" },
        scope: "batch",
      }),
    ]) {
      // The answer is being refetched when the decision is made: it waits.
      query.data = undefined;
      query.isFetching = true;
      const { result, rerender, unmount } = setup({ stepPending: true });
      act(() => result.current.afterDecision());
      expect(result.current.pending).toBe(true);
      rerender(args({ stepPending: false })); // the decision lands
      rerender(args({ stepPending: true })); // ⌘Z on the step on screen
      // The move is called off at once: Next pending is no longer busy...
      expect(result.current.pending).toBe(false);
      // ...and the answer, when it comes, moves the reviewer nowhere.
      query.isFetching = false;
      query.data = later;
      rerender(args({ stepPending: true }));
      expect(router.replace).not.toHaveBeenCalled();
      expect(router.push).not.toHaveBeenCalled();
      expect(result.current.card).toBeNull();
      unmount();
    }
  });
});

describe("useReviewLoop: a stale read during a decision (R36)", () => {
  // A read of the step that starts after the decision's optimistic update and
  // before the server commits it comes back with the step still pending, and
  // shows it so until the refetch after the decision lands. While a decision
  // on the step is in flight that flicker is not an undo (R30): the card
  // stays and the decision's move still happens.
  const intoNextBatch = () =>
    answer({
      target: { buildId: "b2", runId: "r9", checkpointId: "s9" },
      scope: "nextBatch",
      remaining: { run: 0, batch: 0, batchUnfiltered: 0, projectBatches: 2 },
      nextBatch,
    });
  const intoOtherRun = () =>
    answer({
      target: { buildId: BUILD, runId: OTHER_RUN, checkpointId: "step-9" },
      scope: "batch",
    });
  /** The step on screen as the viewer reads it, and its decision in flight. */
  const step = (pending: boolean, decisionInFlight: boolean) =>
    args({ stepPending: pending, decisionInFlight });

  test("a stale read while the decision is in flight does not drop its card", () => {
    query.data = intoNextBatch();
    const { result, rerender } = setup({ stepPending: true });
    // A: the decision is held in flight, then the loop hears of it.
    rerender(step(true, true));
    act(() => result.current.afterDecision());
    expect(result.current.card).toBe("batch");
    rerender(step(false, true)); // its optimistic update lands
    rerender(step(true, true)); // a read from before the commit lands
    rerender(step(false, true)); // ...and is put right
    expect(result.current.card).toBe("batch");
    // Another stale read is still on screen when the decision settles: the
    // flag dropping under it is no flip either.
    rerender(step(true, true));
    rerender(step(true, false));
    rerender(step(false, false)); // the refetch after the decision lands
    expect(result.current.card).toBe("batch");
  });

  test("a stale read while a decision waits does not cancel its move", () => {
    // The answer is being refetched when the decision is made: it waits.
    query.isFetching = true;
    const { result, rerender } = setup({ stepPending: true });
    rerender(step(true, true));
    act(() => result.current.afterDecision());
    expect(result.current.pending).toBe(true);
    rerender(step(false, true)); // its optimistic update lands
    rerender(step(true, true)); // a read from before the commit
    rerender(step(false, true));
    expect(result.current.pending).toBe(true);
    rerender(step(false, false)); // the decision settles
    // The answer comes: the decision moves, once.
    query.isFetching = false;
    query.data = intoOtherRun();
    rerender(step(false, false));
    calledOnceWith(
      router.push,
      `/projects/${PROJECT}/runs/${OTHER_RUN}/checkpoints/step-9`,
    );
    expect(router.replace).not.toHaveBeenCalled();
    expect(result.current.pending).toBe(false);
    // A later refetch of the same answer does not move again.
    rerender(step(false, false));
    expect(router.push).toHaveBeenCalledOnce();
  });

  test("an undo after the decision has landed still cancels and drops the card", () => {
    // The card: the decision lands, then ⌘Z puts the step back (R30). The
    // undo's own hold is not a decision in flight.
    query.data = intoNextBatch();
    const withCard = setup({ stepPending: true });
    withCard.rerender(step(true, true));
    act(() => withCard.result.current.afterDecision());
    withCard.rerender(step(false, true));
    withCard.rerender(step(false, false)); // landed
    expect(withCard.result.current.card).toBe("batch");
    withCard.rerender(step(true, false)); // ⌘Z
    expect(withCard.result.current.card).toBeNull();
    // Settled again some other way (Mark as Bug): no card comes back.
    withCard.rerender(step(false, false));
    expect(withCard.result.current.card).toBeNull();
    withCard.unmount();

    // The move: a decision waiting for its answer lands, then is undone.
    query.data = undefined;
    query.isFetching = true;
    const waiting = setup({ stepPending: true });
    waiting.rerender(step(true, true));
    act(() => waiting.result.current.afterDecision());
    waiting.rerender(step(false, true));
    waiting.rerender(step(false, false)); // landed
    expect(waiting.result.current.pending).toBe(true);
    waiting.rerender(step(true, false)); // ⌘Z
    expect(waiting.result.current.pending).toBe(false);
    // The answer comes: it moves the reviewer nowhere.
    query.isFetching = false;
    query.data = intoOtherRun();
    waiting.rerender(step(true, false));
    expect(router.push).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
    expect(waiting.result.current.card).toBeNull();
  });
});

describe("useReviewLoop: across the step-change remount (R37)", () => {
  // A step change (the arrows, the step list) shows the new step at once and
  // asks the router for its URL; when the route commits, Next mounts a new
  // viewer at that step. A decision made in between is heard by the old
  // instance: its card, or its move still waiting for an answer, is handed to
  // the new one.
  const S = "step-4";
  const intoNextBatch = () =>
    answer({
      target: { buildId: "b2", runId: "r9", checkpointId: "s9" },
      scope: "nextBatch",
      remaining: { run: 0, batch: 0, batchUnfiltered: 0, projectBatches: 2 },
      nextBatch,
    });
  const intoOtherRun = () =>
    answer({
      target: { buildId: BUILD, runId: OTHER_RUN, checkpointId: "step-9" },
      scope: "batch",
    });
  const OTHER_RUN_STEP = `/projects/${PROJECT}/runs/${OTHER_RUN}/checkpoints/step-9`;
  type Options = { strict?: boolean };
  const mount = (over: Partial<Args>, { strict = false }: Options = {}) =>
    renderHook((props: Args) => useReviewLoop(props), {
      initialProps: args(over),
      reactStrictMode: strict,
    });
  /**
   * The viewer opened on STEP, and the reviewer stepped to S: the old
   * instance shows S, and S's URL is still to commit.
   */
  function steppedToS(options: Options = {}) {
    const hook = mount({}, options);
    hook.rerender(args({ checkpointId: S }));
    return hook;
  }
  /** The route commits: Next mounts a new viewer at `checkpointId`. */
  const remountAt = (checkpointId = S, options: Options = {}) =>
    mount({ checkpointId }, options);

  test.each([
    ["plain", false],
    ["StrictMode", true],
  ])(
    "a keyed remount in one commit keeps the decision's card and move (%s)",
    (_mode, strict) => {
      // As Next does it: the viewer is keyed by the URL's step, so when the
      // route commits, the old instance unmounts and the new one mounts in the
      // SAME commit (the old one's cleanup runs before the new one's effects).
      let loop: ReturnType<typeof useReviewLoop> | null = null;
      function Host(props: Args) {
        loop = useReviewLoop(props);
        return null;
      }
      const current = () => {
        if (!loop) throw new Error("the host has not rendered");
        return loop;
      };
      /** The viewer for the URL's step, showing `step`. */
      const viewer = (urlStep: string, step: string) => (
        <Host key={urlStep} {...args({ checkpointId: step })} />
      );

      // The card.
      query.data = intoNextBatch();
      const withCard = render(viewer(STEP, STEP), { reactStrictMode: strict });
      withCard.rerender(viewer(STEP, S)); // →: S on screen, its URL to commit
      act(() => current().afterDecision());
      expect(current().card).toBe("batch");
      withCard.rerender(viewer(S, S)); // the route commits
      expect(current().card).toBe("batch");
      cleanup();

      // The move still waiting for its answer.
      query.data = undefined;
      query.isFetching = true;
      const waiting = render(viewer(STEP, STEP), { reactStrictMode: strict });
      waiting.rerender(viewer(STEP, S));
      act(() => current().afterDecision());
      expect(current().pending).toBe(true);
      waiting.rerender(viewer(S, S)); // the route commits
      expect(current().pending).toBe(true);
      query.isFetching = false;
      query.data = intoOtherRun();
      waiting.rerender(viewer(S, S));
      calledOnceWith(router.push, OTHER_RUN_STEP);
      waiting.rerender(viewer(S, S));
      expect(router.push).toHaveBeenCalledOnce();
    },
  );

  test("a decision just before the step-change remount keeps its card", () => {
    query.data = intoNextBatch();
    const old = steppedToS();
    act(() => old.result.current.afterDecision());
    expect(old.result.current.card).toBe("batch");
    old.unmount();
    const fresh = remountAt();
    expect(fresh.result.current.card).toBe("batch");
    // Once: the next viewer at S finds nothing.
    fresh.unmount();
    expect(remountAt().result.current.card).toBeNull();
  });

  test("a decision waiting across the remount still moves once", () => {
    // The answer is being refetched when the decision is made: it waits.
    query.isFetching = true;
    const old = steppedToS();
    act(() => old.result.current.afterDecision());
    expect(old.result.current.pending).toBe(true);
    old.unmount();
    const fresh = remountAt();
    expect(fresh.result.current.pending).toBe(true);
    // The answer comes: the decision moves, once.
    query.isFetching = false;
    query.data = intoOtherRun();
    fresh.rerender(args({ checkpointId: S }));
    calledOnceWith(router.push, OTHER_RUN_STEP);
    expect(fresh.result.current.pending).toBe(false);
    fresh.rerender(args({ checkpointId: S }));
    expect(router.push).toHaveBeenCalledOnce();
    expect(router.replace).not.toHaveBeenCalled();
  });

  test("a remount at a different step adopts nothing", () => {
    // A card, then a waiting decision, are handed off at S; the next viewer
    // opens elsewhere, and S's viewer after it finds nothing either.
    query.data = intoNextBatch();
    const withCard = steppedToS();
    act(() => withCard.result.current.afterDecision());
    withCard.unmount();
    const elsewhere = remountAt("step-7");
    expect(elsewhere.result.current.card).toBeNull();
    elsewhere.unmount();
    expect(remountAt().result.current.card).toBeNull();
    cleanup();

    query.data = undefined;
    query.isFetching = true;
    const waiting = steppedToS();
    act(() => waiting.result.current.afterDecision());
    waiting.unmount();
    const other = remountAt("step-7");
    expect(other.result.current.pending).toBe(false);
    query.isFetching = false;
    query.data = intoOtherRun();
    other.rerender(args({ checkpointId: "step-7" }));
    expect(router.push).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
  });

  test("a hand-off older than the 10 s wait is not adopted", () => {
    vi.useFakeTimers();
    query.data = intoNextBatch();
    const old = steppedToS();
    act(() => old.result.current.afterDecision());
    old.unmount();
    act(() => vi.advanceTimersByTime(10_001));
    expect(remountAt().result.current.card).toBeNull();
  });

  test("an adopted decision still waits at most 10 s from when it was made", () => {
    vi.useFakeTimers();
    query.isFetching = true;
    const old = steppedToS();
    act(() => old.result.current.afterDecision());
    act(() => vi.advanceTimersByTime(6_000));
    old.unmount();
    const fresh = remountAt();
    expect(fresh.result.current.pending).toBe(true);
    act(() => vi.advanceTimersByTime(4_001));
    expect(fresh.result.current.pending).toBe(false);
    query.isFetching = false;
    query.data = intoOtherRun();
    fresh.rerender(args({ checkpointId: S }));
    expect(router.push).not.toHaveBeenCalled();
  });

  test("a hand-off to a step that needs review again is dropped", () => {
    // ⌘Z (or a refusal) came before the new viewer: it opens on S reading
    // pending, with no decision on it in flight (R30). Nothing is adopted,
    // then or once S settles.
    query.data = intoNextBatch();
    const again = steppedToS();
    act(() => again.result.current.afterDecision());
    again.unmount();
    const pending = mount({ checkpointId: S, stepPending: true });
    pending.rerender(args({ checkpointId: S }));
    expect(pending.result.current.card).toBeNull();
    // ...unless the decision on it is still in flight (R36).
    cleanup();
    const inFlight = steppedToS();
    act(() => inFlight.result.current.afterDecision());
    inFlight.unmount();
    const flying = mount({
      checkpointId: S,
      stepPending: true,
      decisionInFlight: true,
    });
    flying.rerender(args({ checkpointId: S, decisionInFlight: true }));
    expect(flying.result.current.card).toBe("batch");
  });

  test("leaving the step on screen by hand hands nothing off", () => {
    // Not a step change still committing: the viewer opened on this step.
    // Coming back to it (Back) brings no card and no move (R19).
    query.data = intoNextBatch();
    const withCard = mount({});
    act(() => withCard.result.current.afterDecision());
    expect(withCard.result.current.card).toBe("batch");
    withCard.unmount();
    expect(remountAt(STEP).result.current.card).toBeNull();
    cleanup();

    query.data = undefined;
    query.isFetching = true;
    const waiting = mount({});
    act(() => waiting.result.current.afterDecision());
    waiting.unmount();
    const back = remountAt(STEP);
    expect(back.result.current.pending).toBe(false);
    query.isFetching = false;
    query.data = intoOtherRun();
    back.rerender(args());
    expect(router.push).not.toHaveBeenCalled();
  });

  test("the loop's own move hands nothing off", () => {
    // Continue leaves the card up, busy, until the route commits (R24): the
    // instance unmounts with it, by its own move.
    query.data = intoNextBatch();
    const old = steppedToS();
    act(() => old.result.current.afterDecision());
    act(() => old.result.current.continueToNextBatch());
    expect(router.push).toHaveBeenCalledOnce();
    expect(old.result.current.card).toBe("batch");
    old.unmount();
    expect(remountAt().result.current.card).toBeNull();
  });

  test("leaving by the card hands nothing off", () => {
    query.data = intoNextBatch();
    const old = steppedToS();
    act(() => old.result.current.afterDecision());
    act(() => old.result.current.leave(`/projects/${PROJECT}/builds/${BUILD}`));
    old.unmount();
    expect(remountAt().result.current.card).toBeNull();
  });

  test("J waiting across the remount is not handed off: only a decision is", () => {
    query.isFetching = true;
    const old = steppedToS();
    act(() => old.result.current.goNext());
    expect(old.result.current.pending).toBe(true);
    old.unmount();
    const fresh = remountAt();
    expect(fresh.result.current.pending).toBe(false);
    query.isFetching = false;
    query.data = intoOtherRun();
    fresh.rerender(args({ checkpointId: S }));
    expect(router.push).not.toHaveBeenCalled();
  });

  test("an adopted card is dropped by an undo", () => {
    query.data = intoNextBatch();
    const old = steppedToS();
    act(() => old.result.current.afterDecision());
    old.unmount();
    const fresh = remountAt();
    expect(fresh.result.current.card).toBe("batch");
    fresh.rerender(args({ checkpointId: S, stepPending: true })); // ⌘Z
    expect(fresh.result.current.card).toBeNull();
    // Settled again some other way (Mark as Bug): no card comes back.
    fresh.rerender(args({ checkpointId: S }));
    expect(fresh.result.current.card).toBeNull();
    cleanup();

    // An adopted waiting decision is called off the same way (R30).
    query.data = undefined;
    query.isFetching = true;
    const waiting = steppedToS();
    act(() => waiting.result.current.afterDecision());
    waiting.unmount();
    const adopted = remountAt();
    expect(adopted.result.current.pending).toBe(true);
    adopted.rerender(args({ checkpointId: S, stepPending: true })); // ⌘Z
    expect(adopted.result.current.pending).toBe(false);
    query.isFetching = false;
    query.data = intoOtherRun();
    adopted.rerender(args({ checkpointId: S, stepPending: true }));
    expect(router.push).not.toHaveBeenCalled();
  });

  test("StrictMode replay neither loses nor double-adopts the hand-off", () => {
    const strict = { strict: true };
    query.data = intoNextBatch();
    const old = steppedToS(strict);
    act(() => old.result.current.afterDecision());
    old.unmount();
    const fresh = remountAt(S, strict);
    expect(fresh.result.current.card).toBe("batch");
    fresh.unmount();
    expect(remountAt(S, strict).result.current.card).toBeNull();
    cleanup();

    // A waiting decision survives the replayed unmount's epoch bump, and
    // moves once.
    query.data = undefined;
    query.isFetching = true;
    const waiting = steppedToS(strict);
    act(() => waiting.result.current.afterDecision());
    waiting.unmount();
    const adopted = remountAt(S, strict);
    expect(adopted.result.current.pending).toBe(true);
    query.isFetching = false;
    query.data = intoOtherRun();
    adopted.rerender(args({ checkpointId: S }));
    calledOnceWith(router.push, OTHER_RUN_STEP);
    adopted.rerender(args({ checkpointId: S }));
    expect(router.push).toHaveBeenCalledOnce();
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
    expect(utils.runs.getStep.prefetch).not.toHaveBeenCalled();
  });

  test("prefetches the target step's own read, in this run or another, never the step on screen", () => {
    // The viewer reads one step at a time (spec 2026-10-27 §5): the step
    // the loop goes to next is warmed wherever it is.
    query.data = answer({
      target: { buildId: BUILD, runId: OTHER_RUN, checkpointId: "step-9" },
      scope: "batch",
    });
    const { rerender } = setup();
    expect(utils.runs.getStep.prefetch).toHaveBeenCalledOnce();
    expect(utils.runs.getStep.prefetch.mock.calls[0]![0]).toEqual({
      runId: OTHER_RUN,
      checkpointId: "step-9",
    });

    query.data = answer({
      target: { buildId: BUILD, runId: RUN, checkpointId: "step-2" },
      scope: "run",
    });
    rerender(args());
    expect(utils.runs.getStep.prefetch).toHaveBeenCalledTimes(2);
    expect(utils.runs.getStep.prefetch.mock.calls[1]![0]).toEqual({
      runId: RUN,
      checkpointId: "step-2",
    });

    query.data = answer({
      target: { buildId: BUILD, runId: RUN, checkpointId: STEP },
      scope: "run",
    });
    rerender(args());
    expect(utils.runs.getStep.prefetch).toHaveBeenCalledTimes(2);
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

  const empty = { run: 0, batch: 0, batchUnfiltered: 0, projectBatches: 0 };
  test.each([
    [
      "nothing before it",
      prev({ target: null, scope: "none", remaining: empty }),
      "all",
    ],
    [
      "only another batch before it",
      prev({
        target: { buildId: "b2", runId: "r9", checkpointId: "s9" },
        scope: "nextBatch",
        remaining: { ...empty, projectBatches: 1 },
        nextBatch,
      }),
      "batch",
    ],
  ] as const)(
    "stays in the batch when there is %s: the boundary, as for J (R27)",
    async (_name, result_, card) => {
      utils.review.next.fetch.mockResolvedValue(result_);
      const { result } = setup();
      await act(async () => result.current.goPrev());
      expect(router.push).not.toHaveBeenCalled();
      expect(router.replace).not.toHaveBeenCalled();
      // Another batch is not "previous": the step on screen is settled, so
      // the card says the batch is done.
      expect(result.current.card).toBe(card);
    },
  );

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
    // moves on as ever (only J and K wait for the route), when its answer
    // names another step than the move already on its way.
    query.data = answer();
    const { result, rerender } = setup();
    act(() => result.current.goNext());
    query.data = answer({
      target: { buildId: BUILD, runId: RUN, checkpointId: "step-5" },
    });
    rerender(args());
    act(() => result.current.afterDecision());
    expect(router.replace).toHaveBeenCalledTimes(2);
    expect(router.replace).toHaveBeenLastCalledWith(
      `/projects/${PROJECT}/runs/${RUN}/checkpoints/step-5`,
    );
  });

  test("a decision during a committing move to the same step does not navigate or cue twice", () => {
    // J has moved into the next test; before the route commits, a decision
    // on the step still on screen gets the same answer.
    query.data = intoOtherRun();
    const { result } = setup();
    act(() => result.current.goNext());
    expect(router.push).toHaveBeenCalledTimes(1);
    expect(useReviewAnnouncer.getState().seq).toBe(1);
    act(() => result.current.afterDecision());
    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.replace).not.toHaveBeenCalled();
    // The cue J made stands: not said again, not taken down.
    expect(useReviewAnnouncer.getState().seq).toBe(1);
    expect(useLoopCue.getState().cue?.text).toBe(
      "Next test: Checkout · 4 left in batch",
    );
  });

  test("an answer naming the step on screen is not navigated to", () => {
    query.data = answer({
      target: { buildId: BUILD, runId: RUN, checkpointId: STEP },
    });
    const { result, rerender } = setup();
    act(() => result.current.goNext());
    expect(router.replace).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
    // Nothing is on its way, so J is not held back.
    query.data = answer();
    rerender(args());
    act(() => result.current.goNext());
    expect(router.replace).toHaveBeenCalledOnce();
  });

  test("J works again if a move never changes the step (5 s bound)", () => {
    vi.useFakeTimers();
    query.data = answer();
    const { result } = setup();
    act(() => result.current.goNext());
    act(() => result.current.goNext());
    expect(router.replace).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(4_999));
    act(() => result.current.goNext());
    expect(router.replace).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(1));
    act(() => result.current.goNext());
    expect(router.replace).toHaveBeenCalledTimes(2);
  });

  test("leaving the viewer by hand drops a cue still loading its name", async () => {
    const slow = deferred<{ name: string | null }>();
    utils.runs.getById.getData.mockReturnValue(undefined);
    utils.runs.getById.fetch.mockReturnValue(slow.promise);
    query.data = intoOtherRun();
    const page = setup();
    act(() => page.result.current.goNext());
    // The move's own departure: its cue is for the page it opens.
    page.unmount();
    // That page opens, and the reviewer leaves it by hand (a link, another
    // step) before the name has come.
    const next = setup({ runId: OTHER_RUN, checkpointId: "step-9" });
    next.unmount();
    await act(async () => {});
    await act(async () => slow.resolve({ name: "Checkout" }));
    expect(useReviewAnnouncer.getState().text).toBe("");
    expect(useLoopCue.getState().cue).toBeNull();
  });

  test("leaving by hand after a stale move drops a cue still loading its name", async () => {
    vi.useFakeTimers();
    const slow = deferred<{ name: string | null }>();
    utils.runs.getById.getData.mockReturnValue(undefined);
    utils.runs.getById.fetch.mockReturnValue(slow.promise);
    query.data = intoOtherRun();
    const page = setup();
    act(() => page.result.current.goNext());
    expect(router.push).toHaveBeenCalledOnce();
    // The route never commits the move, which is given up on after 5 s; then
    // the reviewer leaves by hand (a link). That departure is not the move's.
    act(() => vi.advanceTimersByTime(5_000));
    page.unmount();
    await act(async () => {});
    await act(async () => slow.resolve({ name: "Checkout" }));
    expect(useReviewAnnouncer.getState().text).toBe("");
    expect(useLoopCue.getState().cue).toBeNull();
  });

  test("a move's own departure keeps its cue, still loading its name", async () => {
    const slow = deferred<{ name: string | null }>();
    utils.runs.getById.getData.mockReturnValue(undefined);
    utils.runs.getById.fetch.mockReturnValue(slow.promise);
    query.data = intoOtherRun();
    const page = setup();
    act(() => page.result.current.goNext());
    page.unmount();
    await act(async () => {});
    await act(async () => slow.resolve({ name: "Checkout" }));
    expect(useReviewAnnouncer.getState().text).toBe(
      "Next test: Checkout · 4 left in batch",
    );
  });

  test("a strict-mode remount of the page the move opened keeps its cue", async () => {
    // Development runs every effect twice on mount (`reactStrictMode` in
    // next.config): the unmount cleanup runs once while the page stays. That
    // is not leaving. StrictMode has to be the root for the effects to run
    // twice: as a `wrapper` it is not, and nothing is replayed.
    query.data = intoOtherRun();
    const page = setup();
    act(() => page.result.current.goNext());
    page.unmount();
    const next = renderHook((props: Args) => useReviewLoop(props), {
      initialProps: args({ runId: OTHER_RUN, checkpointId: "step-9" }),
      reactStrictMode: true,
    });
    await act(async () => {});
    expect(next.result.current.cue).toBe(
      "Next test: Checkout · 4 left in batch",
    );
  });
});

describe("useReviewLoop: the pending state (spec §5.4)", () => {
  test("pending while a decision waits for its answer, then not", () => {
    query.data = answer();
    query.isFetching = true;
    const { result, rerender } = setup();
    expect(result.current.pending).toBe(false);
    act(() => result.current.afterDecision());
    expect(result.current.pending).toBe(true);
    query.isFetching = false;
    query.data = answer({
      target: { buildId: BUILD, runId: RUN, checkpointId: "step-5" },
    });
    rerender(args());
    expect(result.current.pending).toBe(false);
    expect(router.replace).toHaveBeenCalledOnce();
  });

  test("not pending when the answer is in hand: the move is at once", () => {
    query.data = answer();
    const { result } = setup();
    act(() => result.current.afterDecision());
    expect(result.current.pending).toBe(false);
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

  test("a forward move into another test shows its cue there, for about 3 s from when it is first shown", () => {
    query.data = intoOtherRun();
    const { result, rerender } = setup();
    act(() => result.current.goNext());
    // Not on the test being left...
    expect(result.current.cue).toBeNull();
    // ...but on the one the move opened (a new page in the viewer), however
    // long the route took to get there.
    act(() => vi.advanceTimersByTime(2_000));
    rerender(args({ runId: OTHER_RUN, checkpointId: "step-9" }));
    expect(result.current.cue).toBe(CUE);
    act(() => vi.advanceTimersByTime(2_999));
    expect(result.current.cue).toBe(CUE);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.cue).toBeNull();
  });

  test("a page of the same test opened again does not restart the 3 s", () => {
    query.data = intoOtherRun();
    const page = setup();
    act(() => page.result.current.goNext());
    page.unmount();
    const first = setup({ runId: OTHER_RUN, checkpointId: "step-9" });
    expect(first.result.current.cue).toBe(CUE);
    act(() => vi.advanceTimersByTime(2_000));
    // The first page stops showing it, and its own take-down goes with it
    // (its loop is off; it has not left, so the cue stays up)...
    first.rerender(
      args({ runId: OTHER_RUN, checkpointId: "step-9", enabled: false }),
    );
    expect(first.result.current.cue).toBeNull();
    // ...and another page of the same test shows it: the deadline is still
    // the first one's, 3 s from when it was first shown, not from now.
    const second = setup({ runId: OTHER_RUN, checkpointId: "step-9" });
    expect(second.result.current.cue).toBe(CUE);
    act(() => vi.advanceTimersByTime(999));
    expect(second.result.current.cue).toBe(CUE);
    act(() => vi.advanceTimersByTime(1));
    expect(second.result.current.cue).toBeNull();
  });

  test("a cue its test never shows is dropped after 10 s", () => {
    query.data = intoOtherRun();
    const page = setup();
    act(() => page.result.current.goNext());
    page.unmount();
    act(() => vi.advanceTimersByTime(10_000));
    // Opening that test much later shows no stale cue.
    const later = setup({ runId: OTHER_RUN, checkpointId: "step-9" });
    expect(later.result.current.cue).toBeNull();
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
