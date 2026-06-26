import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/useProjectEvents", () => ({
  useProjectEvents: () => undefined,
}));
// Step cards (rendered by RunResults) fetch their thumbnail through this hook;
// stub it so the page test never hits the network.
vi.mock("@/hooks/use-authed-image", () => ({ useAuthedImage: () => null }));

const getByIdMock = vi.fn();
const listMock = vi.fn();
const listCheckpointsMock = vi.fn();
const bulkApproveMock = vi.fn();
const invalidateMock = vi.fn();
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      runs: {
        list: { invalidate: invalidateMock },
        listCheckpoints: { invalidate: invalidateMock },
      },
      builds: { getById: { invalidate: invalidateMock } },
    }),
    builds: { getById: { useQuery: (...a: unknown[]) => getByIdMock(...a) } },
    runs: {
      list: { useQuery: (...a: unknown[]) => listMock(...a) },
      listCheckpoints: {
        useQuery: (...a: unknown[]) => listCheckpointsMock(...a),
      },
      bulkApproveByBuild: {
        useMutation: () => ({ mutate: bulkApproveMock, isPending: false }),
      },
    },
  },
}));

const replaceMock = vi.fn();
const notFoundMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock, push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  notFound: () => {
    notFoundMock();
    throw new Error("NEXT_NOT_FOUND");
  },
}));

import { BatchPage } from "@/app/(protected)/projects/[projectId]/builds/[buildId]/_components/batch-page";

afterEach(cleanup);
beforeEach(() => {
  // Default: runs have no resolvable checkpoints yet, so each renders as a
  // single fallback result row carrying the test name.
  listCheckpointsMock.mockReturnValue({
    data: { items: [] },
    isLoading: false,
  });
});

const build = {
  id: "b1",
  ciBuildId: "ci",
  number: 42,
  name: null,
  branchName: "main",
  properties: {},
  runCount: 2,
  unresolvedCount: 2,
  failedCount: 0,
  passedCount: 0,
  abortedCount: 0,
  newCount: 0,
  stepsTotal: 4,
  runByName: "Jane Doe",
  aggregateStatus: "unresolved",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe("BatchPage", () => {
  test("renders the header from getById and a result row per test from runs.list", async () => {
    getByIdMock.mockReturnValue({
      data: build,
      isLoading: false,
      isError: false,
    });
    listMock.mockReturnValue({
      data: {
        items: [
          {
            id: "r1",
            name: "Checkout",
            status: "unresolved",
            diffPercent: 2.4,
            thumbnailUrl: null,
          },
          {
            id: "r2",
            name: "Search",
            status: "unresolved",
            diffPercent: 0.9,
            thumbnailUrl: null,
          },
        ],
        nextCursor: null,
      },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    render(<BatchPage projectId="p1" buildId="b1" canReview={true} />);
    await waitFor(() => expect(screen.getByText("Checkout")).toBeDefined());
    expect(screen.getByText("Search")).toBeDefined();
    expect(screen.getByText(/#42/)).toBeDefined();
  });

  test("defaults the runs.list query to All (no status filter)", async () => {
    getByIdMock.mockReturnValue({
      data: build,
      isLoading: false,
      isError: false,
    });
    listMock.mockClear();
    listMock.mockReturnValue({
      data: { items: [], nextCursor: null },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    render(<BatchPage projectId="p1" buildId="b1" canReview={true} />);
    expect(listMock).toHaveBeenCalledWith(
      expect.objectContaining({
        buildId: "b1",
        projectId: "p1",
        status: undefined,
      }),
    );
  });

  test("calls notFound() when the build query errors with NOT_FOUND", () => {
    notFoundMock.mockClear();
    getByIdMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: { data: { code: "NOT_FOUND" } },
    });
    listMock.mockReturnValue({
      data: { items: [], nextCursor: null },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    expect(() =>
      render(<BatchPage projectId="p1" buildId="bad" canReview={true} />),
    ).toThrow(/NEXT_NOT_FOUND/);
    expect(notFoundMock).toHaveBeenCalled();
  });

  test("does not call notFound() on a non-NOT_FOUND build error; shows an error state", () => {
    notFoundMock.mockClear();
    getByIdMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: { data: { code: "FORBIDDEN" }, message: "FORBIDDEN" },
    });
    listMock.mockReturnValue({
      data: { items: [], nextCursor: null },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    render(<BatchPage projectId="p1" buildId="b1" canReview={true} />);
    expect(notFoundMock).not.toHaveBeenCalled();
    expect(screen.getByText(/Couldn’t load this build/)).toBeDefined();
  });

  test("Load more appends the next page instead of replacing it", async () => {
    getByIdMock.mockReturnValue({
      data: build,
      isLoading: false,
      isError: false,
    });
    listMock.mockImplementation((args: { cursor?: string }) =>
      args.cursor
        ? {
            data: {
              items: [
                {
                  id: "r3",
                  name: "Page2Card",
                  status: "unresolved",
                  diffPercent: 1,
                  thumbnailUrl: null,
                },
              ],
              nextCursor: null,
            },
            isLoading: false,
            isError: false,
            refetch: vi.fn(),
          }
        : {
            data: {
              items: [
                {
                  id: "r1",
                  name: "Page1Card",
                  status: "unresolved",
                  diffPercent: 1,
                  thumbnailUrl: null,
                },
              ],
              nextCursor: "cur1",
            },
            isLoading: false,
            isError: false,
            refetch: vi.fn(),
          },
    );
    render(<BatchPage projectId="p1" buildId="b1" canReview={true} />);
    await waitFor(() => expect(screen.getByText("Page1Card")).toBeDefined());
    fireEvent.click(screen.getByText("Load more"));
    await waitFor(() => expect(screen.getByText("Page2Card")).toBeDefined());
    expect(screen.getByText("Page1Card")).toBeDefined(); // page 1 still present
  });

  test("Approve all calls bulkApproveByBuild and invalidates the lists on success", async () => {
    getByIdMock.mockReturnValue({
      data: build,
      isLoading: false,
      isError: false,
    });
    listMock.mockReturnValue({
      data: { items: [], nextCursor: null },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    bulkApproveMock.mockClear();
    invalidateMock.mockClear();
    // Fire the mutation's success path so the post-approve invalidate runs —
    // this is what flips the just-approved rows out of "Unresolved".
    bulkApproveMock.mockImplementationOnce(
      (_input: unknown, opts: { onSuccess?: (r: unknown) => void }) =>
        opts?.onSuccess?.({ approved: 3, capped: false, cap: 200 }),
    );
    render(<BatchPage projectId="p1" buildId="b1" canReview={true} />);
    fireEvent.click(screen.getByTestId("batch-approve-all"));
    expect(bulkApproveMock).toHaveBeenCalledWith(
      { buildId: "b1" },
      expect.anything(),
    );
    // runs.list + runs.listCheckpoints + builds.getById all invalidated.
    expect(invalidateMock).toHaveBeenCalledTimes(3);
  });

  test("canReview=false hides the Approve-all button but still lists the test rows", async () => {
    getByIdMock.mockReturnValue({
      data: build,
      isLoading: false,
      isError: false,
    });
    listMock.mockReturnValue({
      data: {
        items: [
          {
            id: "r1",
            name: "Checkout",
            status: "unresolved",
            diffPercent: 2.4,
            thumbnailUrl: null,
          },
        ],
        nextCursor: null,
      },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    render(<BatchPage projectId="p1" buildId="b1" canReview={false} />);
    await waitFor(() => expect(screen.getByText("Checkout")).toBeDefined());
    expect(screen.queryByTestId("batch-approve-all")).toBeNull();
    // Review (approve/reject) now lives in the diff viewer, opened from a row's
    // step cards — there are no inline approve/reject controls on the rows.
    expect(screen.getByTestId("result-row-r1")).toBeDefined();
  });
});
