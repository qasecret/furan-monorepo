import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// A review decision must not redraw the cards beside it: one card changes, the
// rest of a long batch stays put. Cards are counted through the thumbnail
// hook, which each card calls once per render.
const { renders, listCheckpointsMock, hookSpies } = vi.hoisted(() => ({
  renders: new Map<string, number>(),
  listCheckpointsMock: vi.fn(),
  hookSpies: { decide: vi.fn(), undo: vi.fn() },
}));
vi.mock("@/hooks/use-authed-image", () => ({
  useAuthedImage: (key: string | null) => {
    if (key) renders.set(key, (renders.get(key) ?? 0) + 1);
    return null;
  },
}));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    runs: {
      listCheckpoints: {
        useQuery: (...a: unknown[]) => listCheckpointsMock(...a),
      },
    },
  },
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
// The real in-flight store and `useIsInFlight`. The hook subscribes to the
// whole in-flight set, as the real one does, and returns the same functions
// every time, as the real one does.
vi.mock("@/lib/review/use-review-mutations", async (importActual) => {
  const actual =
    await importActual<typeof import("@/lib/review/use-review-mutations")>();
  return {
    ...actual,
    useReviewMutations: () => {
      actual.useInFlightStore((s) => s.ids);
      return hookSpies;
    },
  };
});

import { RunResults } from "@/app/(protected)/projects/[projectId]/builds/[buildId]/_components/run-results";
import { useInFlightStore } from "@/lib/review/use-review-mutations";

type Item = Record<string, unknown> & { id: string; imageKey: string };

const item = (id: string, over: Record<string, unknown> = {}): Item => ({
  id,
  name: id,
  imageKey: `k-${id}`,
  verdict: "unresolved",
  state: "unresolved",
  decision: null,
  viewport: "1280x720",
  browser: "chromium",
  os: "linux",
  ...over,
});

const A = item("a");
const B = item("b");
const C = item("c");
// Another environment, so another result row of the same run.
const D = item("d", { os: "windows", browser: "firefox" });

const view = (items: Item[]) => {
  listCheckpointsMock.mockReturnValue({ data: { items }, isLoading: false });
  return (
    <RunResults
      projectId="p1"
      runId="r1"
      testName="Login"
      branchName="main"
      fallbackStatus="unresolved"
      view="list"
      canReview={true}
    />
  );
};

const count = (id: string) => renders.get(`k-${id}`) ?? 0;
const counts = () => ({
  a: count("a"),
  b: count("b"),
  c: count("c"),
  d: count("d"),
});

beforeEach(() => {
  renders.clear();
  useInFlightStore.setState({ ids: new Set() });
});
afterEach(() => {
  cleanup();
  useInFlightStore.setState({ ids: new Set() });
});

describe("step cards redraw only for their own step", () => {
  test("every card draws once to begin with", () => {
    render(view([A, B, C, D]));
    expect(counts()).toEqual({ a: 1, b: 1, c: 1, d: 1 });
  });

  test("a decision on its way redraws its own card, not its siblings", () => {
    render(view([A, B, C, D]));
    const before = counts();

    act(() => useInFlightStore.getState().hold(["a"]));
    expect(count("a")).toBeGreaterThan(before.a);
    expect({ b: count("b"), c: count("c"), d: count("d") }).toEqual({
      b: before.b,
      c: before.c,
      d: before.d,
    });

    const held = count("a");
    act(() => useInFlightStore.getState().release(["a"]));
    expect(count("a")).toBeGreaterThan(held);
    expect({ b: count("b"), c: count("c"), d: count("d") }).toEqual({
      b: before.b,
      c: before.c,
      d: before.d,
    });
  });

  test("a decision made on one card redraws only that card", () => {
    const { rerender } = render(view([A, B, C, D]));
    const before = counts();

    // What the optimistic patch does: the decided step is a new object, the
    // others are the objects they were.
    const approved = {
      ...A,
      state: "approved",
      decision: {
        actionId: "x",
        kind: "approved",
        undo: { allowed: true },
      },
    };
    rerender(view([approved as Item, B, C, D]));

    expect(count("a")).toBeGreaterThan(before.a);
    expect({ b: count("b"), c: count("c"), d: count("d") }).toEqual({
      b: before.b,
      c: before.c,
      d: before.d,
    });
  });

  test("a card in another result row of the run is left alone too", () => {
    render(view([A, B, C, D]));
    const before = counts();
    act(() => useInFlightStore.getState().hold(["d"]));
    expect(count("d")).toBeGreaterThan(before.d);
    expect({ a: count("a"), b: count("b"), c: count("c") }).toEqual({
      a: before.a,
      b: before.b,
      c: before.c,
    });
  });
});
