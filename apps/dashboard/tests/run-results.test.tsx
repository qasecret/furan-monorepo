import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const listCheckpointsMock = vi.fn();
vi.mock("@/lib/trpc", () => ({
  trpc: {
    runs: {
      listCheckpoints: {
        useQuery: (...a: unknown[]) => listCheckpointsMock(...a),
      },
    },
  },
}));
// The review hook is mocked: its own suite covers the decisions. The step
// cards below only need it to exist.
const reviewSpies = vi.hoisted(() => ({ decide: vi.fn(), undo: vi.fn() }));
vi.mock("@/lib/review/use-review-mutations", () => ({
  useReviewMutations: () => reviewSpies,
  useIsInFlight: () => false,
}));
vi.mock("@/hooks/use-authed-image", () => ({ useAuthedImage: () => null }));
const pushMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

import { RunResults } from "@/app/(protected)/projects/[projectId]/builds/[buildId]/_components/run-results";
import { parseReviewContext, type ReviewContext } from "@/lib/review-context";

/** A review context from a query string: the status and the facets. */
const ctxOf = (search = ""): ReviewContext =>
  parseReviewContext(new URLSearchParams(search));

/** Natively disabled, or `aria-disabled` (an unavailable action that explains itself). */
const unavailable = (el: HTMLElement): boolean =>
  (el as HTMLButtonElement).disabled ||
  el.getAttribute("aria-disabled") === "true";

afterEach(() => {
  cleanup();
  reviewSpies.decide.mockReset();
  reviewSpies.undo.mockReset();
});

type CP = {
  id: string;
  name: string;
  verdict: "new" | "passed" | "unresolved" | null;
  state: "new" | "passed" | "unresolved" | "approved" | "rejected" | null;
  decision: {
    kind: "approved" | "rejected";
    actionId: string;
    undo: { allowed: boolean };
  } | null;
  viewport: string;
  browser: string;
  os: string | null;
  device: string | null;
  imageKey: string | null;
};

function cp(over: Partial<CP> = {}): CP {
  return {
    id: "c1",
    name: "Home",
    verdict: "passed",
    state: "passed",
    decision: null,
    viewport: "1280x720",
    browser: "chromium",
    os: "linux",
    device: null,
    imageKey: "k1",
    ...over,
  };
}

/** A step a reviewer decided: the verdict stays, the state is the decision. */
function decided(kind: "approved" | "rejected", over: Partial<CP> = {}): CP {
  return cp({
    verdict: "unresolved",
    state: kind,
    decision: { kind, actionId: `a-${kind}`, undo: { allowed: true } },
    ...over,
  });
}

function renderRun(
  items: CP[],
  fallbackStatus = "passed",
  statusOverride: "passed" | "failed" | null = null,
  extra: Partial<ComponentProps<typeof RunResults>> = {},
) {
  listCheckpointsMock.mockReturnValue({ data: { items }, isLoading: false });
  return render(
    <RunResults
      projectId="p1"
      runId="r1"
      testName="Login"
      branchName="main"
      fallbackStatus={fallbackStatus as never}
      statusOverride={statusOverride}
      ctx={ctxOf()}
      view="list"
      canReview={true}
      {...extra}
    />,
  );
}

describe("RunResults", () => {
  test("groups checkpoints by environment into one result row per env", () => {
    renderRun([
      cp({ id: "c1", os: "linux", browser: "chromium", viewport: "1280x720" }),
      cp({ id: "c2", os: "linux", browser: "chromium", viewport: "1280x720" }),
      cp({ id: "c3", os: "windows", browser: "firefox", viewport: "390x844" }),
    ]);
    // 3 checkpoints, 2 distinct environments -> 2 result rows.
    expect(screen.getAllByTestId("result-row-r1")).toHaveLength(2);
    expect(screen.getAllByText("Login")).toHaveLength(2);
    expect(screen.getByText("windows")).toBeDefined();
    expect(screen.getByText("firefox")).toBeDefined();
  });

  test("renders a step card per checkpoint and opens the diff viewer on click", () => {
    pushMock.mockClear();
    renderRun([cp({ id: "cX", name: "Home" })]);
    const card = screen.getByTestId("step-card-cX");
    // The image is the primary open affordance (the hover toolbar holds the
    // review / maximize actions).
    fireEvent.click(within(card).getByRole("button", { name: "Open Home" }));
    expect(pushMock).toHaveBeenCalledWith(
      "/projects/p1/runs/r1/checkpoints/cX",
    );
  });

  test("a card opens the viewer with the page's status and facets", () => {
    pushMock.mockClear();
    renderRun([cp({ id: "cX", name: "Home" })], "passed", null, {
      ctx: ctxOf("status=failed&browser=chromium"),
    });
    fireEvent.click(
      within(screen.getByTestId("step-card-cX")).getByRole("button", {
        name: "Open Home",
      }),
    );
    expect(pushMock).toHaveBeenCalledWith(
      "/projects/p1/runs/r1/checkpoints/cX?status=failed&browser=chromium",
    );
  });

  test("a step card names its state, not just its accent colour", () => {
    // Aborted and unresolved accents are near-identical yellows, so each card
    // carries the state icon with an accessible label. An aborted run's
    // undiffed step reads as aborted.
    renderRun(
      [
        cp({ id: "cA", verdict: null, state: null, os: "linux" }),
        cp({
          id: "cU",
          verdict: "unresolved",
          state: "unresolved",
          os: "windows",
        }),
      ],
      "aborted",
    );
    const aborted = screen.getByTestId("step-status-cA");
    const unresolved = screen.getByTestId("step-status-cU");
    expect(aborted.textContent).toBe("Aborted");
    expect(unresolved.textContent).toBe("Unresolved");
    expect(aborted.querySelector("svg")).not.toBeNull();
    expect(aborted.getAttribute("title")).not.toBe(
      unresolved.getAttribute("title"),
    );
  });

  test("a step card tells a reviewer's decision from the machine's verdict", () => {
    renderRun([cp({ id: "cM" }), decided("approved", { id: "cD" })]);
    expect(screen.getByTestId("step-status-cM").textContent).toBe("Passed");
    expect(screen.getByTestId("step-status-cD").textContent).toBe("Approved");
  });

  test("worst state wins for the env row (a rejected step makes the row failed)", () => {
    renderRun([cp({ id: "c1" }), decided("rejected", { id: "c2" })]);
    // Same env -> one row; its pill reflects the run rollup of its steps.
    const row = screen.getByTestId("result-row-r1");
    expect(within(row).getByText("Failed")).toBeDefined();
  });

  test("a row whose pending steps were all approved reads as passed", () => {
    renderRun([
      decided("approved", { id: "c1" }),
      decided("approved", { id: "c2" }),
    ]);
    expect(
      within(screen.getByTestId("result-row-r1")).getByText("Passed"),
    ).toBeDefined();
  });

  test("a row is running while any step of it has no verdict yet", () => {
    renderRun([cp({ id: "c1" }), cp({ id: "c2", verdict: null, state: null })]);
    expect(
      within(screen.getByTestId("result-row-r1")).getByText("Running"),
    ).toBeDefined();
  });

  test("an overridden run reads as its override on every row", () => {
    renderRun([cp({ id: "c1" })], "passed", "failed");
    expect(
      within(screen.getByTestId("result-row-r1")).getByText("Failed"),
    ).toBeDefined();
  });

  test("a run with no checkpoints shows a single fallback row", () => {
    renderRun([], "new");
    const rows = screen.getAllByTestId("result-row-r1");
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (!row) throw new Error("expected a fallback row");
    expect(within(row).getByText("Login")).toBeDefined();
    expect(within(row).getByText("New")).toBeDefined();
    expect(within(row).queryByTestId("result-pending-r1")).toBeNull();
  });
});

describe("RunResults pending counts", () => {
  test("each row says how many of its steps still need a reviewer", () => {
    renderRun([
      cp({
        id: "c1",
        verdict: "unresolved",
        state: "unresolved",
        os: "linux",
      }),
      cp({ id: "c2", verdict: "new", state: "new", os: "linux" }),
      cp({ id: "c3", os: "linux" }),
      cp({ id: "c4", os: "windows", browser: "firefox" }),
      cp({
        id: "c5",
        verdict: "unresolved",
        state: "unresolved",
        os: "windows",
        browser: "firefox",
      }),
    ]);
    const [linux, windows] = screen.getAllByTestId("result-row-r1");
    expect(within(linux!).getByText("2 of 3 pending")).toBeDefined();
    expect(within(windows!).getByText("1 of 2 pending")).toBeDefined();
  });

  test("decided and passed steps are not pending", () => {
    renderRun([
      cp({ id: "c1" }),
      decided("approved", { id: "c2" }),
      decided("rejected", { id: "c3" }),
      cp({ id: "c4", verdict: "new", state: "new" }),
    ]);
    expect(
      within(screen.getByTestId("result-row-r1")).getByText("1 of 4 pending"),
    ).toBeDefined();
  });

  test("a row with nothing pending says nothing", () => {
    renderRun([cp({ id: "c1" }), decided("approved", { id: "c2" })]);
    expect(screen.queryByText(/pending/)).toBeNull();
    expect(screen.queryByTestId("result-pending-r1")).toBeNull();
  });
});

describe("RunResults review calls", () => {
  test("a card's actions go through the list's one review instance", () => {
    renderRun([
      cp({ id: "c1", name: "home", verdict: "new", state: "new" }),
      decided("approved", { id: "c2", name: "cart" }),
    ]);
    fireEvent.click(screen.getByTestId("step-approve-c1"));
    expect(reviewSpies.decide).toHaveBeenCalledWith({
      runId: "r1",
      checkpointIds: ["c1"],
      kind: "approved",
      label: "Approved 'home'",
      goTo: { href: "/projects/p1/runs/r1/checkpoints/c1", name: "home" },
    });
    fireEvent.click(screen.getByTestId("step-undo-c2"));
    expect(reviewSpies.undo).toHaveBeenCalledWith("a-approved");
  });
});

describe("RunResults review gating", () => {
  test("a pending step can be approved while the run takes decisions", () => {
    renderRun([cp({ id: "c1", verdict: "new", state: "new" })], "new");
    expect(unavailable(screen.getByTestId("step-approve-c1"))).toBe(false);
  });

  test("an overridden run holds its steps' actions back", () => {
    renderRun(
      [cp({ id: "c1", verdict: "unresolved", state: "unresolved" })],
      "passed",
      "passed",
    );
    expect(unavailable(screen.getByTestId("step-approve-c1"))).toBe(true);
  });

  test("a step cannot be decided while another step of its run has no verdict", () => {
    // The two steps are in different rows (environments), but one run.
    renderRun([
      cp({ id: "c1", verdict: "unresolved", state: "unresolved", os: "linux" }),
      cp({ id: "c2", verdict: null, state: null, os: "windows" }),
    ]);
    expect(unavailable(screen.getByTestId("step-approve-c1"))).toBe(true);
  });
});

describe("RunResults environment facets", () => {
  // One run that captured `home` at two viewports (Review Focus 1).
  const TWO_VIEWPORTS = () => [
    cp({
      id: "c1",
      name: "home",
      verdict: "unresolved",
      state: "unresolved",
      viewport: "1280x720",
    }),
    cp({ id: "c2", name: "cart", viewport: "1280x720" }),
    cp({
      id: "c3",
      name: "home",
      verdict: "unresolved",
      state: "unresolved",
      viewport: "390x844",
    }),
  ];
  const anchors = () => document.querySelectorAll('[id="run-r1"]');

  test("a facet narrows the steps of a run to the ones that match", () => {
    renderRun(TWO_VIEWPORTS(), "unresolved", null, {
      ctx: ctxOf("viewport=1280x720"),
    });
    expect(screen.getByTestId("step-card-c1")).toBeDefined();
    expect(screen.getByTestId("step-card-c2")).toBeDefined();
    expect(screen.queryByTestId("step-card-c3")).toBeNull();
    // One row: the other viewport's row is gone with its steps.
    expect(screen.getAllByTestId("result-row-r1")).toHaveLength(1);
    expect(screen.queryByText("390x844")).toBeNull();
  });

  test("n of m counts the steps the facet leaves, per row", () => {
    const view = renderRun(TWO_VIEWPORTS(), "unresolved", null, {
      ctx: ctxOf("viewport=1280x720"),
    });
    // Inside the facet: c1 pending of c1 + c2.
    expect(screen.getByTestId("result-pending-r1").textContent).toBe(
      "1 of 2 pending",
    );
    view.unmount();

    // No facet: a row per viewport, each counting its own steps.
    renderRun(TWO_VIEWPORTS(), "unresolved");
    const [wide, narrow] = screen.getAllByTestId("result-row-r1");
    expect(within(wide!).getByText("1 of 2 pending")).toBeDefined();
    expect(within(narrow!).getByText("1 of 1 pending")).toBeDefined();
  });

  test("a facet never changes what the run allows: a hidden step still holds the others back", () => {
    // The 390x844 step has no verdict yet, so no step of the run can be
    // decided (the same rule as without a facet), though that step is hidden.
    renderRun(
      [
        cp({
          id: "c1",
          verdict: "unresolved",
          state: "unresolved",
          viewport: "1280x720",
        }),
        cp({ id: "c3", verdict: null, state: null, viewport: "390x844" }),
      ],
      "unresolved",
      null,
      { ctx: ctxOf("viewport=1280x720") },
    );
    expect(screen.queryByTestId("step-card-c3")).toBeNull();
    expect(unavailable(screen.getByTestId("step-approve-c1"))).toBe(true);
  });

  test("a facet matches the os of a step, and a step with none never matches", () => {
    renderRun(
      [
        cp({ id: "c1", os: "linux" }),
        cp({ id: "c2", os: "windows" }),
        cp({ id: "c3", os: null }),
      ],
      "passed",
      null,
      { ctx: ctxOf("os=linux") },
    );
    expect(screen.getByTestId("step-card-c1")).toBeDefined();
    expect(screen.queryByTestId("step-card-c2")).toBeNull();
    expect(screen.queryByTestId("step-card-c3")).toBeNull();
  });

  test("a run with steps on two devices: the device facet narrows the steps, n of m counts the matching ones, one #run anchor", () => {
    // Same viewport, browser and OS: only the device tells the steps apart.
    const onTwoDevices = () => [
      cp({
        id: "c1",
        name: "home",
        verdict: "unresolved",
        state: "unresolved",
        device: "iPhone 15",
      }),
      cp({ id: "c2", name: "cart", device: "iPhone 15" }),
      cp({
        id: "c3",
        name: "home",
        verdict: "unresolved",
        state: "unresolved",
        device: "Pixel 8",
      }),
      cp({ id: "c4", name: "cart", device: null }),
    ];

    const view = renderRun(onTwoDevices(), "unresolved", null, {
      ctx: ctxOf("device=iPhone%2015"),
    });
    expect(screen.getByTestId("step-card-c1")).toBeDefined();
    expect(screen.getByTestId("step-card-c2")).toBeDefined();
    // The other device's step, and a step with no device, are not this device.
    expect(screen.queryByTestId("step-card-c3")).toBeNull();
    expect(screen.queryByTestId("step-card-c4")).toBeNull();
    expect(screen.getByTestId("result-pending-r1").textContent).toBe(
      "1 of 2 pending",
    );
    expect(anchors()).toHaveLength(1);
    view.unmount();

    // Without the facet every step is back, counted together.
    renderRun(onTwoDevices(), "unresolved");
    expect(screen.getByTestId("step-card-c3")).toBeDefined();
    expect(screen.getByTestId("step-card-c4")).toBeDefined();
    expect(screen.getByTestId("result-pending-r1").textContent).toBe(
      "2 of 4 pending",
    );
    expect(anchors()).toHaveLength(1);
  });

  test("a device facet holds together with the others, on the same step", () => {
    renderRun(
      [
        cp({ id: "c1", browser: "safari", device: "iPhone 15" }),
        cp({ id: "c2", browser: "chrome", device: "iPhone 15" }),
        cp({ id: "c3", browser: "safari", device: "Pixel 8" }),
      ],
      "passed",
      null,
      { ctx: ctxOf("browser=safari&device=iPhone%2015") },
    );
    expect(screen.getByTestId("step-card-c1")).toBeDefined();
    expect(screen.queryByTestId("step-card-c2")).toBeNull();
    expect(screen.queryByTestId("step-card-c3")).toBeNull();
  });

  test("facets given together hold on the same step", () => {
    renderRun(
      [
        cp({ id: "c1", browser: "chromium", viewport: "1280x720" }),
        cp({ id: "c2", browser: "firefox", viewport: "1280x720" }),
        cp({ id: "c3", browser: "chromium", viewport: "390x844" }),
      ],
      "passed",
      null,
      { ctx: ctxOf("browser=chromium&viewport=390x844") },
    );
    expect(screen.queryByTestId("step-card-c1")).toBeNull();
    expect(screen.queryByTestId("step-card-c2")).toBeNull();
    expect(screen.getByTestId("step-card-c3")).toBeDefined();
  });

  test("the run's #run anchor is on its first row only, however many rows it has", () => {
    renderRun(TWO_VIEWPORTS(), "unresolved");
    expect(screen.getAllByTestId("result-row-r1")).toHaveLength(2);
    expect(anchors()).toHaveLength(1);
    // It wraps the first row: the one that comes first in the page.
    const [first, second] = screen.getAllByTestId("result-row-r1");
    expect(anchors()[0]!.contains(first!)).toBe(true);
    expect(anchors()[0]!.contains(second!)).toBe(false);
  });

  test("a run with a single row and a run with none each carry the anchor once", () => {
    const one = renderRun([cp({ id: "c1" })]);
    expect(anchors()).toHaveLength(1);
    one.unmount();
    renderRun([], "new");
    expect(anchors()).toHaveLength(1);
  });
});

describe("RunResults counts from the list", () => {
  test("a run whose steps are not loaded says how many of its steps are pending, from the list", () => {
    renderRun([], "unresolved", null, { pendingCount: 2, stepCount: 5 });
    expect(screen.getByTestId("result-pending-r1").textContent).toBe(
      "2 of 5 pending",
    );
  });

  test("with a facet on, the list's counts are not both ratios: only the pending count is said", () => {
    // `pendingCount` counts inside the facets, `stepCount` all the steps, so
    // "2 of 5" would compare two different sets.
    renderRun([], "unresolved", null, {
      ctx: ctxOf("viewport=390x844"),
      pendingCount: 2,
      stepCount: 5,
    });
    expect(screen.getByTestId("result-pending-r1").textContent).toBe(
      "2 pending",
    );
  });

  test("the same holds for each facet", () => {
    for (const q of ["browser=safari", "os=iOS", "device=iPhone%2015"]) {
      cleanup();
      renderRun([], "unresolved", null, {
        ctx: ctxOf(q),
        pendingCount: 3,
        stepCount: 7,
      });
      expect(screen.getByTestId("result-pending-r1").textContent).toBe(
        "3 pending",
      );
    }
  });

  test("with nothing pending in the list it says nothing", () => {
    renderRun([], "passed", null, { pendingCount: 0, stepCount: 5 });
    expect(screen.queryByTestId("result-pending-r1")).toBeNull();
  });

  test("loaded steps win over the list: the row counts its own", () => {
    renderRun(
      [
        cp({ id: "c1", verdict: "new", state: "new" }),
        cp({ id: "c2", verdict: "new", state: "new" }),
        cp({ id: "c3" }),
      ],
      "new",
      null,
      { pendingCount: 9, stepCount: 99 },
    );
    expect(screen.getByTestId("result-pending-r1").textContent).toBe(
      "2 of 3 pending",
    );
  });
});

describe("RunResults reveal (Back to batch)", () => {
  let scrolled: Element[];
  let scrollSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    scrolled = [];
    scrollSpy = vi
      .spyOn(Element.prototype, "scrollIntoView")
      .mockImplementation(function (this: Element) {
        scrolled.push(this);
      });
  });
  afterEach(() => scrollSpy.mockRestore());

  test("scrolls the first row to the middle and focuses its toggle, then says so", () => {
    const onRevealed = vi.fn();
    renderRun(
      [
        cp({ id: "c1", os: "linux" }),
        cp({ id: "c2", os: "windows", browser: "firefox" }),
      ],
      "passed",
      null,
      { reveal: true, onRevealed },
    );
    const anchor = document.getElementById("run-r1")!;
    expect(scrolled).toEqual([anchor]);
    expect(scrollSpy).toHaveBeenCalledWith({ block: "center" });
    const [first] = screen.getAllByTestId("result-row-r1");
    expect(document.activeElement).toBe(first);
    expect(onRevealed).toHaveBeenCalledOnce();
  });

  test("does nothing unless asked", () => {
    renderRun([cp({ id: "c1" })]);
    expect(scrolled).toHaveLength(0);
    expect(document.activeElement).toBe(document.body);
  });

  test("moves focus without scrolling a second time", () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    renderRun([cp({ id: "c1" })], "passed", null, { reveal: true });
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    focus.mockRestore();
  });

  test("waits for the steps: nothing happens while they load", () => {
    listCheckpointsMock.mockReturnValue({ data: undefined, isLoading: true });
    const onRevealed = vi.fn();
    render(
      <RunResults
        projectId="p1"
        runId="r1"
        testName="Login"
        branchName="main"
        fallbackStatus="passed"
        ctx={ctxOf()}
        view="list"
        canReview={true}
        reveal
        onRevealed={onRevealed}
      />,
    );
    expect(scrolled).toHaveLength(0);
    expect(onRevealed).not.toHaveBeenCalled();
  });
});
