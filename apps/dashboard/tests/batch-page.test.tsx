import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
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
const previewMock = vi.fn();
vi.mock("@/lib/trpc", () => ({
  trpc: {
    builds: { getById: { useQuery: (...a: unknown[]) => getByIdMock(...a) } },
    runs: {
      list: { useQuery: (...a: unknown[]) => listMock(...a) },
      listCheckpoints: {
        useQuery: (...a: unknown[]) => listCheckpointsMock(...a),
      },
    },
    review: {
      previewApproveBuild: {
        useQuery: (...a: unknown[]) => previewMock(...a),
      },
    },
  },
}));

// The review hook is mocked: its own suite covers what a decision does. The
// page's job is to ask, with the right counts, and to react to the answer.
const reviewSpies = vi.hoisted(() => ({
  decide: vi.fn(),
  undo: vi.fn(),
  approveBuild: vi.fn(),
  decideGroup: vi.fn(),
  isInFlight: vi.fn(() => false),
}));
vi.mock("@/lib/review/use-review-mutations", () => ({
  useReviewMutations: () => reviewSpies,
  useIsInFlight: () => false,
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
  reviewSpies.approveBuild.mockReset();
  previewMock.mockReturnValue({
    data: PREVIEW,
    isLoading: false,
    isFetching: false,
    isError: false,
  });
  // Default: runs have no resolvable checkpoints yet, so each renders as a
  // single fallback result row carrying the test name.
  listCheckpointsMock.mockReturnValue({
    data: { items: [] },
    isLoading: false,
  });
});

const PREVIEW = {
  pendingCheckpoints: 2,
  tests: 2,
  rejectedLeftAsIs: 0,
  notReviewableTests: 0,
  capped: false,
  cap: 500,
};

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
  pendingCheckpoints: 2,
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

  test("the toolbar counts the build's pending steps", () => {
    getByIdMock.mockReturnValue({
      data: { ...build, pendingCheckpoints: 37 },
      isLoading: false,
      isError: false,
    });
    listMock.mockReturnValue({
      data: { items: [], nextCursor: null },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    render(<BatchPage projectId="p1" buildId="b1" canReview={true} />);
    const button = screen.getByTestId("batch-approve-all") as HTMLButtonElement;
    expect(button.textContent).toContain("Approve pending (37)");
    expect(button.disabled).toBe(false);
  });

  test("Approve pending is disabled when no step of the build is pending", () => {
    getByIdMock.mockReturnValue({
      data: { ...build, pendingCheckpoints: 0, unresolvedCount: 3 },
      isLoading: false,
      isError: false,
    });
    listMock.mockReturnValue({
      data: { items: [], nextCursor: null },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    render(<BatchPage projectId="p1" buildId="b1" canReview={true} />);
    const button = screen.getByTestId("batch-approve-all") as HTMLButtonElement;
    expect(button.textContent).toContain("Approve pending (0)");
    expect(button.disabled).toBe(true);
  });

  test("Approve pending asks first, with the preview's counts, and approves only on confirm", async () => {
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
    render(<BatchPage projectId="p1" buildId="b1" canReview={true} />);
    expect(screen.queryByRole("alertdialog")).toBeNull();

    fireEvent.click(screen.getByTestId("batch-approve-all"));
    expect(
      screen.getByRole("heading", { name: "Approve 2 pending steps?" }),
    ).toBeDefined();
    expect(previewMock).toHaveBeenLastCalledWith(
      { buildId: "b1" },
      expect.objectContaining({ enabled: true }),
    );
    expect(reviewSpies.approveBuild).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("approve-pending-confirm"));
    expect(reviewSpies.approveBuild).toHaveBeenCalledOnce();
    expect(reviewSpies.approveBuild).toHaveBeenCalledWith(
      expect.objectContaining({ buildId: "b1", expectedCount: 2 }),
    );
  });

  test("after the batch is approved the dialog closes and the list starts over from its first page", async () => {
    getByIdMock.mockReturnValue({
      data: build,
      isLoading: false,
      isError: false,
    });
    const page = (cursor: string | undefined) => ({
      data: cursor
        ? {
            items: [{ id: "r2", name: "Page2Card", status: "unresolved" }],
            nextCursor: null,
          }
        : {
            items: [{ id: "r1", name: "Page1Card", status: "unresolved" }],
            nextCursor: "cur1",
          },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    listMock.mockImplementation((args: { cursor?: string }) =>
      page(args.cursor),
    );
    render(<BatchPage projectId="p1" buildId="b1" canReview={true} />);
    await waitFor(() => expect(screen.getByText("Page1Card")).toBeDefined());
    fireEvent.click(screen.getByText("Load more"));
    await waitFor(() => expect(screen.getByText("Page2Card")).toBeDefined());
    expect(listMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: "cur1" }),
    );

    fireEvent.click(screen.getByTestId("batch-approve-all"));
    fireEvent.click(screen.getByTestId("approve-pending-confirm"));
    act(() => {
      const call = reviewSpies.approveBuild.mock.calls[0]![0] as {
        onSuccess?: () => void;
        onSettled?: () => void;
      };
      call.onSuccess?.();
      call.onSettled?.();
    });

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    // Back on page one: approved tests drop out of a filtered list instead of
    // lingering in the pages already loaded.
    expect(listMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: undefined }),
    );
    expect(screen.queryByText("Page2Card")).toBeNull();
  });

  test("closing the Approve-pending question returns focus to its toolbar button", async () => {
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
    render(<BatchPage projectId="p1" buildId="b1" canReview={true} />);
    const trigger = screen.getByTestId("batch-approve-all");
    // A click that leaves focus elsewhere (it does not focus the button in
    // every browser): the button is still where focus must come back to.
    fireEvent.click(trigger);
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByTestId("approve-pending-cancel"),
      ),
    );

    fireEvent.click(screen.getByTestId("approve-pending-cancel"));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  test("a run's hand-set status reaches its result rows", async () => {
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
            status: "passed",
            statusOverride: "failed",
          },
        ],
        nextCursor: null,
      },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    listCheckpointsMock.mockReturnValue({
      data: {
        items: [
          {
            id: "c1",
            name: "home",
            verdict: "passed",
            state: "passed",
            decision: null,
            viewport: "1280x720",
            browser: "chromium",
            os: "linux",
            imageKey: null,
          },
        ],
      },
      isLoading: false,
    });
    render(<BatchPage projectId="p1" buildId="b1" canReview={true} />);
    const row = await screen.findByTestId("result-row-r1");
    expect(within(row).getByText("Failed")).toBeDefined();
  });

  test("canReview=false hides the Approve-pending button but still lists the test rows", async () => {
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
    // The rows stay; a reader who may not review gets no review controls.
    expect(screen.getByTestId("result-row-r1")).toBeDefined();
  });
});
