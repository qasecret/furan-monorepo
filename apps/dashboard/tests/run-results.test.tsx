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
      approveCheckpoint: {
        useMutation: () => ({ mutate: vi.fn(), isPending: false }),
      },
    },
    useUtils: () => ({
      runs: {
        listCheckpoints: { invalidate: vi.fn() },
        list: { invalidate: vi.fn() },
      },
      builds: { getById: { invalidate: vi.fn() } },
    }),
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
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
  status: string;
  viewport: string;
  browser: string;
  os: string | null;
  imageKey: string | null;
};

function cp(over: Partial<CP> = {}): CP {
  return {
    id: "c1",
    name: "Home",
    status: "passed",
    viewport: "1280x720",
    browser: "chromium",
    os: "linux",
    imageKey: "k1",
    ...over,
  };
}

function renderRun(items: CP[], fallbackStatus = "passed") {
  listCheckpointsMock.mockReturnValue({ data: { items }, isLoading: false });
  render(
    <RunResults
      projectId="p1"
      runId="r1"
      testName="Login"
      branchName="main"
      fallbackStatus={fallbackStatus as never}
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
    // approve / maximize actions).
    fireEvent.click(within(card).getByRole("button", { name: "Open Home" }));
    expect(pushMock).toHaveBeenCalledWith(
      "/projects/p1/runs/r1/checkpoints/cX",
    );
  });

  test("worst status wins for the env row (a failed step makes the row failed)", () => {
    renderRun([
      cp({ id: "c1", status: "passed" }),
      cp({ id: "c2", status: "failed" }),
    ]);
    // Same env -> one row; its pill reflects the most severe step.
    const row = screen.getByTestId("result-row-r1");
    expect(within(row).getByText("Failed")).toBeDefined();
  });

  test("a run with no checkpoints shows a single fallback row", () => {
    renderRun([], "new");
    const rows = screen.getAllByTestId("result-row-r1");
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (!row) throw new Error("expected a fallback row");
    expect(within(row).getByText("Login")).toBeDefined();
    expect(within(row).getByText("New")).toBeDefined();
  });
});
