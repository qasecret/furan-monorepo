import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

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
vi.mock("@/lib/review/use-review-mutations", () => ({
  useReviewMutations: () => ({ decide: vi.fn(), undo: vi.fn() }),
  useIsInFlight: () => false,
}));
vi.mock("@/hooks/use-authed-image", () => ({ useAuthedImage: () => null }));
const pushMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

import { RunResults } from "@/app/(protected)/projects/[projectId]/builds/[buildId]/_components/run-results";

afterEach(cleanup);

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
) {
  listCheckpointsMock.mockReturnValue({ data: { items }, isLoading: false });
  render(
    <RunResults
      projectId="p1"
      runId="r1"
      testName="Login"
      branchName="main"
      fallbackStatus={fallbackStatus as never}
      statusOverride={statusOverride}
      view="list"
      canReview={true}
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

describe("RunResults review gating", () => {
  test("a pending step can be approved while the run takes decisions", () => {
    renderRun([cp({ id: "c1", verdict: "new", state: "new" })], "new");
    expect(
      (screen.getByTestId("step-approve-c1") as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  test("an overridden run holds its steps' actions back", () => {
    renderRun(
      [cp({ id: "c1", verdict: "unresolved", state: "unresolved" })],
      "passed",
      "passed",
    );
    expect(
      (screen.getByTestId("step-approve-c1") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  test("a step cannot be decided while another step of its run has no verdict", () => {
    // The two steps are in different rows (environments), but one run.
    renderRun([
      cp({ id: "c1", verdict: "unresolved", state: "unresolved", os: "linux" }),
      cp({ id: "c2", verdict: null, state: null, os: "windows" }),
    ]);
    expect(
      (screen.getByTestId("step-approve-c1") as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
