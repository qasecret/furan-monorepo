import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/hooks/useProjectEvents", () => ({
  useProjectEvents: () => undefined,
}));
vi.mock("@/app/(protected)/_components/current-project-provider", () => ({
  useCurrentProject: () => ({
    currentProjectId: "p1",
    currentProject: null,
    projects: [],
  }),
}));
const listMock = vi.fn();
vi.mock("@/lib/trpc", () => ({
  trpc: { builds: { list: { useQuery: () => listMock() } } },
}));

import { InboxPage } from "@/app/(protected)/inbox/_components/inbox-page";

afterEach(cleanup);

const build = {
  id: "b1",
  projectId: "p1",
  ciBuildId: "c",
  number: 42,
  branchName: "feature/new-nav",
  name: null,
  properties: {},
  runCount: 2,
  runningCount: 0,
  unresolvedCount: 1,
  failedCount: 0,
  passedCount: 0,
  abortedCount: 0,
  emptyCount: 0,
  aggregateStatus: "unresolved",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe("InboxPage (batches table)", () => {
  test("renders a batch row with status badge, branch, and unresolved count", () => {
    listMock.mockReturnValue({
      data: { items: [build], nextCursor: null },
      isLoading: false,
      isFetching: false,
      refetch: vi.fn(),
    });
    render(<InboxPage initialStatus="all" />);

    expect(screen.getByTestId("inbox-batch-row-b1")).toBeDefined();
    expect(screen.getByTestId("build-status-unresolved")).toBeDefined();
    expect(screen.getByText("feature/new-nav")).toBeDefined();
    // run count 2 with the "(1)" unresolved marker
    expect(screen.getByText("(1)")).toBeDefined();
  });

  test("renders the status filter pills", () => {
    listMock.mockReturnValue({
      data: { items: [], nextCursor: null },
      isLoading: false,
      isFetching: false,
      refetch: vi.fn(),
    });
    render(<InboxPage initialStatus="all" />);
    for (const label of ["All", "Unresolved", "Failed", "Running", "Passed"]) {
      expect(screen.getByRole("button", { name: label })).toBeDefined();
    }
  });

  test("shows an empty state when there are no batches", () => {
    listMock.mockReturnValue({
      data: { items: [], nextCursor: null },
      isLoading: false,
      isFetching: false,
      refetch: vi.fn(),
    });
    render(<InboxPage initialStatus="all" />);
    expect(screen.getByText(/No batches yet/i)).toBeDefined();
  });
});
