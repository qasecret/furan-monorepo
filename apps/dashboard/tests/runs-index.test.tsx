/**
 * Island-level tests for the /projects/[projectId]/runs index surface.
 * Mocks the dashboard's typed tRPC client so we can drive the table
 * without spinning up a real server.
 *
 * Spec D5 acceptance: <RunsTable> renders rows, FiltersBar changes the
 * trpc input, and "Load more" pushes the previous response's cursor into
 * the next useQuery call.
 */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// next/navigation hooks used by FiltersBar to sync filter state into the URL.
const replaceMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock, push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

const listMock = vi.fn();

interface RunRow {
  id: string;
  projectId: string;
  branchName: string;
  status: string;
  diffPercent: number | null;
  pixelMisMatchCount: number | null;
  baselineSource: string | null;
  createdAt: Date;
  testVariationId: string;
  buildId: string;
  name: string;
}

const RUNS_PAGE_1: RunRow[] = [
  {
    id: "r1",
    projectId: "p1",
    branchName: "main",
    status: "passed",
    diffPercent: 0.5,
    pixelMisMatchCount: 100,
    baselineSource: "branch",
    createdAt: new Date("2026-05-16T12:00:00Z"),
    testVariationId: "v1",
    buildId: "b1",
    name: "r1",
  },
  {
    id: "r2",
    projectId: "p1",
    branchName: "feature/x",
    status: "failed",
    diffPercent: 5.2,
    pixelMisMatchCount: 5000,
    baselineSource: null,
    createdAt: new Date("2026-05-15T12:00:00Z"),
    testVariationId: "v1",
    buildId: "b1",
    name: "r2",
  },
];

vi.mock("@/lib/trpc", () => ({
  trpc: {
    runs: {
      list: {
        useQuery: (input: {
          projectId: string;
          cursor?: string;
          limit?: number;
          branch?: string;
          status?: string;
        }) => {
          listMock(input);
          return {
            data: {
              items: RUNS_PAGE_1,
              nextCursor: "2026-05-15T00:00:00.000Z",
            },
            isLoading: false,
            error: null,
          };
        },
      },
    },
  },
}));

import { RunsTable } from "../src/app/(protected)/projects/[projectId]/runs/_components/runs-table";

const PROJECT_ID = "33333333-3333-4333-8333-333333333333";

beforeEach(() => {
  listMock.mockReset();
  replaceMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("RunsTable", () => {
  test("renders the runs returned by trpc.runs.list.useQuery", () => {
    render(<RunsTable projectId={PROJECT_ID} />);
    expect(screen.getByTestId("runs-table")).toBeDefined();
    expect(screen.getByTestId("run-row-r1")).toBeDefined();
    expect(screen.getByTestId("run-row-r2")).toBeDefined();
    expect(screen.getByText("main")).toBeDefined();
    expect(screen.getByText("feature/x")).toBeDefined();
    expect(screen.getByText("passed")).toBeDefined();
    expect(screen.getByText("failed")).toBeDefined();
  });

  test("branch filter input updates the query input passed to useQuery", async () => {
    render(<RunsTable projectId={PROJECT_ID} />);
    // Initial call should have undefined branch.
    expect(listMock).toHaveBeenCalled();
    const firstCall = listMock.mock.calls[0]?.[0] as { branch?: string };
    expect(firstCall.branch).toBeUndefined();

    const branchInput = screen.getByTestId("branch-filter-input");
    fireEvent.input(branchInput, { target: { value: "release/9" } });

    // FiltersBar debounces by 300ms; waitFor handles the deferred re-render.
    await waitFor(
      () => {
        const lastCall = listMock.mock.calls.at(-1)?.[0] as {
          branch?: string;
        };
        expect(lastCall.branch).toBe("release/9");
      },
      { timeout: 1000 },
    );
  });

  test("Load more button calls useQuery with the previous response's nextCursor", async () => {
    render(<RunsTable projectId={PROJECT_ID} />);

    const loadMore = await screen.findByTestId("load-more-button");
    fireEvent.click(loadMore);

    await waitFor(() => {
      const lastCall = listMock.mock.calls.at(-1)?.[0] as { cursor?: string };
      expect(lastCall.cursor).toBe("2026-05-15T00:00:00.000Z");
    });
  });
});
