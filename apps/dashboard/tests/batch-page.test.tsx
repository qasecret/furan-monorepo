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
vi.mock("@/app/(protected)/_components/set-breadcrumbs", async (orig) => ({
  ...(await orig()),
  SetBreadcrumbs: () => null,
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
    render(<BatchPage projectId="p1" buildId="b1" projectName="Acme" />);
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
    render(<BatchPage projectId="p1" buildId="b1" projectName="Acme" />);
    expect(listMock).toHaveBeenCalledWith(
      expect.objectContaining({
        buildId: "b1",
        projectId: "p1",
        status: ["unresolved", "failed"],
      }),
    );
  });

  test("calls notFound() when the build query errors (bad buildId)", () => {
    notFoundMock.mockClear();
    getByIdMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    });
    listMock.mockReturnValue({
      data: { items: [], nextCursor: null },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    expect(() =>
      render(<BatchPage projectId="p1" buildId="bad" projectName="Acme" />),
    ).toThrow(/NEXT_NOT_FOUND/);
    expect(notFoundMock).toHaveBeenCalled();
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
    render(<BatchPage projectId="p1" buildId="b1" projectName="Acme" />);
    fireEvent.click(screen.getByTestId("batch-approve-all"));
    expect(bulkApproveMock).toHaveBeenCalledWith(
      { buildId: "b1" },
      expect.anything(),
    );
  });
});
