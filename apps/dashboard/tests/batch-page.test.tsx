import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/useProjectEvents", () => ({
  useProjectEvents: () => undefined,
}));

const getByIdMock = vi.fn();
const listMock = vi.fn();
const approveMock = vi.fn();
const rejectMock = vi.fn();
const bulkApproveMock = vi.fn();
vi.mock("@/lib/trpc", () => ({
  trpc: {
    builds: { getById: { useQuery: (...a: unknown[]) => getByIdMock(...a) } },
    runs: {
      list: { useQuery: (...a: unknown[]) => listMock(...a) },
      approve: {
        useMutation: () => ({ mutate: approveMock, isPending: false }),
      },
      reject: { useMutation: () => ({ mutate: rejectMock, isPending: false }) },
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
  aggregateStatus: "unresolved",
  createdAt: new Date().toISOString(),
};

describe("BatchPage", () => {
  test("renders the header from getById and a card grid from runs.list", async () => {
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

  test("defaults the runs.list query to the needs-review statuses", async () => {
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
        status: ["unresolved", "failed"],
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

  test("Approve all calls bulkApproveByBuild with the buildId", async () => {
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
    render(<BatchPage projectId="p1" buildId="b1" canReview={true} />);
    fireEvent.click(screen.getByTestId("batch-approve-all"));
    expect(bulkApproveMock).toHaveBeenCalledWith(
      { buildId: "b1" },
      expect.anything(),
    );
  });

  test("canReview=false hides per-card approve/reject and the Approve-all button", async () => {
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
    expect(screen.queryByTestId("test-card-approve-r1")).toBeNull();
    expect(screen.queryByTestId("test-card-reject-r1")).toBeNull();
  });
});
