import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: toastMock }));
// The route (a server component) reads the project and the viewer's role.
vi.mock("@/lib/get-project", () => ({
  getProject: vi.fn(async () => ({
    status: 200,
    data: { id: "p1", name: "Project" },
  })),
}));
vi.mock("@/lib/get-viewer", () => ({
  canReviewRole: (role: string) => role === "editor" || role === "admin",
  getViewerRole: vi.fn(async () => "editor"),
}));
vi.mock("@/hooks/useProjectEvents", () => ({
  useProjectEvents: () => undefined,
}));
// Step cards (rendered by RunResults) fetch their thumbnail through this hook;
// stub it so the page test never hits the network. It also counts the cards'
// renders (each card calls it once per render), by image key.
const cardRenders = vi.hoisted(() => new Map<string, number>());
vi.mock("@/hooks/use-authed-image", () => ({
  useAuthedImage: (key: string | null) => {
    if (key) cardRenders.set(key, (cardRenders.get(key) ?? 0) + 1);
    return null;
  },
}));

const getByIdMock = vi.fn();
const listMock = vi.fn();
const listCheckpointsMock = vi.fn();
const facetsMock = vi.fn();
const previewMock = vi.fn();
const nextMock = vi.fn();
const fetchNext = vi.fn();
const invalidateNext = vi.fn();
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      review: { next: { fetch: fetchNext, invalidate: invalidateNext } },
    }),
    builds: { getById: { useQuery: (...a: unknown[]) => getByIdMock(...a) } },
    runs: {
      list: { useQuery: (...a: unknown[]) => listMock(...a) },
      listCheckpoints: {
        useQuery: (...a: unknown[]) => listCheckpointsMock(...a),
      },
      facets: { useQuery: (...a: unknown[]) => facetsMock(...a) },
    },
    review: {
      previewApproveBuild: {
        useQuery: (...a: unknown[]) => previewMock(...a),
      },
      next: { useQuery: (...a: unknown[]) => nextMock(...a) },
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

const routerMock = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
const urlState = vi.hoisted(() => ({ search: "" }));
const notFoundMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
  usePathname: () => "/projects/p1/builds/b1",
  useSearchParams: () => new URLSearchParams(urlState.search),
  redirect: vi.fn(),
  notFound: () => {
    notFoundMock();
    throw new Error("NEXT_NOT_FOUND");
  },
}));

import { BatchPage } from "@/app/(protected)/projects/[projectId]/builds/[buildId]/_components/batch-page";
import BuildDetailPage from "@/app/(protected)/projects/[projectId]/builds/[buildId]/page";
import { parseReviewContext } from "@/lib/review-context";

/** The page as the server hands it over for a request with this query string. */
function batchPage(search = "", canReview = true) {
  urlState.search = search;
  return (
    <BatchPage
      projectId="p1"
      buildId="b1"
      canReview={canReview}
      context={parseReviewContext(new URLSearchParams(search))}
    />
  );
}

const NO_FACETS = { browser: [], viewport: [], os: [], device: [] };

/** What `review.next` answers for this batch: `pending` steps in it. */
function nextAnswer(
  pending: number,
  over: {
    nextBatch?: {
      buildId: string;
      name: string;
      number: number | null;
      branch: string | null;
      pending: number;
    } | null;
  } = {},
) {
  return {
    target:
      pending > 0 ? { buildId: "b1", runId: "r1", checkpointId: "c1" } : null,
    scope: pending > 0 ? "batch" : over.nextBatch ? "nextBatch" : "none",
    remaining: {
      run: 0,
      batch: pending,
      batchUnfiltered: pending,
      projectBatches: 1,
    },
    nextBatch: over.nextBatch ?? null,
  };
}

/**
 * Arrives with this hash, as a page load does: no `hashchange` fires for it
 * (assigning `location.hash` would, a task later, in jsdom).
 */
const arriveAt = (hash: string) =>
  window.history.replaceState(null, "", `${window.location.pathname}${hash}`);

afterEach(() => {
  cleanup();
  arriveAt("");
});
beforeEach(() => {
  urlState.search = "";
  cardRenders.clear();
  listMock.mockReset();
  getByIdMock.mockReset();
  routerMock.push.mockReset();
  routerMock.replace.mockReset();
  toastMock.info.mockReset();
  toastMock.error.mockReset();
  reviewSpies.approveBuild.mockReset();
  previewMock.mockReturnValue({
    data: PREVIEW,
    isLoading: false,
    isFetching: false,
    isError: false,
  });
  facetsMock.mockReset();
  facetsMock.mockReturnValue({ data: NO_FACETS, isLoading: false });
  nextMock.mockReset();
  nextMock.mockReturnValue({ data: nextAnswer(2), isLoading: false });
  fetchNext.mockReset();
  fetchNext.mockResolvedValue(nextAnswer(2));
  // Default: runs have no resolvable checkpoints yet, so each renders as a
  // single fallback result row carrying the test name.
  listCheckpointsMock.mockReset();
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

/** The input of the most recent `runs.list` query. */
const lastListInput = (): Record<string, unknown> => {
  const calls = listMock.mock.calls;
  return calls[calls.length - 1]?.[0] as Record<string, unknown>;
};

function emptyList() {
  return {
    data: { items: [], nextCursor: null },
    isLoading: false,
    isError: false,
    isPlaceholderData: false,
    refetch: vi.fn(),
  };
}

/** A `runs.list` row. */
const runItem = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: `Test ${id}`,
  status: "unresolved",
  statusOverride: null,
  pendingCount: 1,
  stepCount: 1,
  ...over,
});

/** A page of `runs.list`. */
const listOf = (
  items: unknown[],
  nextCursor: string | null = null,
  over: Record<string, unknown> = {},
) => ({
  data: { items, nextCursor },
  isLoading: false,
  isError: false,
  isPlaceholderData: false,
  refetch: vi.fn(),
  ...over,
});

/** A `listCheckpoints` step. */
const step = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: id,
  verdict: "unresolved",
  state: "unresolved",
  decision: null,
  viewport: "1280x720",
  browser: "chromium",
  os: "linux",
  imageKey: null,
  ...over,
});

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
    render(batchPage());
    await waitFor(() => expect(screen.getByText("Checkout")).toBeDefined());
    expect(screen.getByText("Search")).toBeDefined();
    expect(screen.getByText(/#42/)).toBeDefined();
  });

  test("defaults to Needs review (pending: true) and the chip lives in ?status", async () => {
    getByIdMock.mockReturnValue({
      data: build,
      isLoading: false,
      isError: false,
    });
    listMock.mockClear();
    listMock.mockReturnValue(emptyList());
    const view = render(batchPage());
    expect(lastListInput()).toMatchObject({
      buildId: "b1",
      projectId: "p1",
      pending: true,
    });
    // Needs review is the server's pending rule, not a run status.
    expect(lastListInput()).not.toHaveProperty("status");
    expect(screen.getByTestId("batch-filter-trigger").textContent).toContain(
      "Needs review",
    );

    // Choosing a chip writes the URL (a replace, never a push); the default is
    // the one value that is left out of it.
    const user = userEvent.setup();
    await user.click(screen.getByTestId("batch-filter-trigger"));
    await user.click(screen.getByTestId("batch-chip-failed"));
    expect(routerMock.replace).toHaveBeenLastCalledWith(
      "/projects/p1/builds/b1?status=failed",
      { scroll: false },
    );
    expect(routerMock.push).not.toHaveBeenCalled();

    // The URL comes back with it: the list asks for that chip's rule.
    view.rerender(batchPage("status=failed"));
    expect(lastListInput()).toMatchObject({ status: ["failed"] });
    await user.click(screen.getByTestId("batch-filter-trigger"));
    await user.click(screen.getByTestId("batch-chip-needs-review"));
    expect(routerMock.replace).toHaveBeenLastCalledWith(
      "/projects/p1/builds/b1",
      {
        scroll: false,
      },
    );
  });

  test("each chip asks the list for its own rule", () => {
    getByIdMock.mockReturnValue({
      data: build,
      isLoading: false,
      isError: false,
    });
    listMock.mockReturnValue(emptyList());
    const sent = (search: string) => {
      cleanup();
      listMock.mockClear();
      render(batchPage(search));
      return lastListInput();
    };
    expect(sent("status=failed")).toMatchObject({ status: ["failed"] });
    expect(sent("status=failed")).not.toHaveProperty("pending");
    expect(sent("status=running")).toMatchObject({ status: ["running"] });
    expect(sent("status=passed")).toMatchObject({ status: ["passed"] });
    const all = sent("status=all");
    expect(all).not.toHaveProperty("status");
    expect(all).not.toHaveProperty("pending");
  });

  test("rows are requested in capture order", () => {
    getByIdMock.mockReturnValue({
      data: build,
      isLoading: false,
      isError: false,
    });
    listMock.mockReturnValue(emptyList());
    render(batchPage());
    expect(lastListInput()).toMatchObject({ order: "capture" });
    cleanup();
    // Whatever the chip: the order does not change with it.
    render(batchPage("status=all&browser=firefox"));
    expect(lastListInput()).toMatchObject({
      order: "capture",
      browser: "firefox",
    });
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
    expect(() => render(batchPage())).toThrow(/NEXT_NOT_FOUND/);
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
    render(batchPage());
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
    render(batchPage());
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
    render(batchPage());
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
    render(batchPage());
    const button = screen.getByTestId("batch-approve-all") as HTMLButtonElement;
    expect(button.textContent).toContain("Approve pending (0)");
    expect(button.getAttribute("aria-disabled")).toBe("true");
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
    render(batchPage());
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
    render(batchPage());
    await waitFor(() => expect(screen.getByText("Page1Card")).toBeDefined());
    fireEvent.click(screen.getByText("Load more"));
    await waitFor(() => expect(screen.getByText("Page2Card")).toBeDefined());
    expect(lastListInput()).toMatchObject({ cursor: "cur1" });

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
    expect(lastListInput().cursor).toBeUndefined();
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
    render(batchPage());
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

  test("after the last pending step is approved the toolbar button keeps focus and reports itself unavailable", async () => {
    const withPending = (n: number) => ({
      data: { ...build, pendingCheckpoints: n },
      isLoading: false,
      isError: false,
    });
    getByIdMock.mockReturnValue(withPending(2));
    listMock.mockReturnValue({
      data: { items: [], nextCursor: null },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    const view = render(batchPage());
    const trigger = screen.getByTestId("batch-approve-all");
    trigger.focus();
    fireEvent.click(trigger);
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
    await waitFor(() => expect(document.activeElement).toBe(trigger));

    // The refetch of the build brings the count down to nothing.
    getByIdMock.mockReturnValue(withPending(0));
    view.rerender(batchPage());

    const after = screen.getByTestId("batch-approve-all");
    expect(after).toBe(trigger);
    expect(document.activeElement).toBe(trigger);
    expect(after.getAttribute("aria-disabled")).toBe("true");
    expect(after.textContent).toContain("Approve pending (0)");
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
    render(batchPage());
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
    render(batchPage("", false));
    await waitFor(() => expect(screen.getByText("Checkout")).toBeDefined());
    expect(screen.queryByTestId("batch-approve-all")).toBeNull();
    // The rows stay; a reader who may not review gets no review controls.
    expect(screen.getByTestId("result-row-r1")).toBeDefined();
  });
});

const withBuild = () =>
  getByIdMock.mockReturnValue({
    data: build,
    isLoading: false,
    isError: false,
  });

describe("BatchPage environment facets", () => {
  const FACETS = {
    ...NO_FACETS,
    browser: [
      { value: "chromium", pending: 3 },
      { value: "firefox", pending: 1 },
    ],
    viewport: [{ value: "1280x720", pending: 4 }],
  };

  test("facet selects list runs.facets values with pending counts and write the URL", async () => {
    withBuild();
    facetsMock.mockReturnValue({ data: FACETS, isLoading: false });
    listMock.mockReturnValue(emptyList());
    const view = render(batchPage());
    expect(facetsMock).toHaveBeenCalledWith({ buildId: "b1" });

    fireEvent.click(screen.getByRole("combobox", { name: /browser/i }));
    const options = await screen.findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      "Any browser",
      "chromium · 3 pending",
      "firefox · 1 pending",
    ]);
    fireEvent.click(
      screen.getByRole("option", { name: "firefox · 1 pending" }),
    );
    expect(routerMock.replace).toHaveBeenLastCalledWith(
      "/projects/p1/builds/b1?browser=firefox",
      { scroll: false },
    );
    expect(routerMock.push).not.toHaveBeenCalled();

    // The URL comes back with it: the list asks for the facet, and the select
    // shows it.
    view.rerender(batchPage("browser=firefox"));
    expect(lastListInput()).toMatchObject({
      browser: "firefox",
      pending: true,
    });
    expect(
      screen.getByRole("combobox", { name: /browser/i }).textContent,
    ).toContain("firefox");
  });

  test("a facet is written next to the chip and clears on its own", async () => {
    withBuild();
    facetsMock.mockReturnValue({ data: FACETS, isLoading: false });
    listMock.mockReturnValue(emptyList());
    render(batchPage("status=failed&browser=firefox&viewport=1280x720"));
    fireEvent.click(screen.getByRole("combobox", { name: /browser/i }));
    fireEvent.click(await screen.findByRole("option", { name: "Any browser" }));
    expect(routerMock.replace).toHaveBeenLastCalledWith(
      "/projects/p1/builds/b1?status=failed&viewport=1280x720",
      { scroll: false },
    );
  });

  test("a facet value missing from the batch shows '(not in this batch)' and the list's 'No tests match these filters.' + Clear filters", () => {
    withBuild();
    facetsMock.mockReturnValue({ data: FACETS, isLoading: false });
    // The batch has no such steps: the server answers with an empty page.
    listMock.mockReturnValue(emptyList());
    render(batchPage("viewport=9999x9999"));

    expect(
      screen.getByRole("combobox", { name: /viewport/i }).textContent,
    ).toContain("9999x9999 (not in this batch)");
    expect(lastListInput()).toMatchObject({ viewport: "9999x9999" });
    expect(screen.getByText("No tests match these filters.")).toBeDefined();
    // It is a filtered list, not a batch with nothing to review.
    expect(screen.queryByText("Nothing to review in this batch.")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(routerMock.replace).toHaveBeenLastCalledWith(
      "/projects/p1/builds/b1",
      { scroll: false },
    );
  });

  test("Clear filters returns to the default view, whichever chip was on", () => {
    withBuild();
    listMock.mockReturnValue(emptyList());
    render(batchPage("status=passed&os=linux"));
    expect(screen.getByText("No tests match these filters.")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(routerMock.replace).toHaveBeenLastCalledWith(
      "/projects/p1/builds/b1",
      { scroll: false },
    );
  });

  test("a batch with no tests at all says so, without a filter to clear", () => {
    withBuild();
    listMock.mockReturnValue(emptyList());
    render(batchPage("status=all"));
    expect(screen.getByText("No tests in this batch.")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
  });

  test("a chip with nothing in it is a filtered list, not 'nothing to review'", () => {
    withBuild();
    listMock.mockReturnValue(emptyList());
    render(batchPage("status=failed"));
    expect(screen.getByText("No tests match these filters.")).toBeDefined();
    expect(screen.getByRole("button", { name: "Clear filters" })).toBeDefined();
  });

  test("a run with steps in two viewports: facet narrows the steps, n of m counts per step, one #run anchor", () => {
    withBuild();
    listMock.mockReturnValue(
      listOf([runItem("r1", { pendingCount: 1, stepCount: 3 })]),
    );
    listCheckpointsMock.mockReturnValue({
      data: {
        items: [
          step("c1", { name: "home" }),
          step("c2", { name: "cart", verdict: "passed", state: "passed" }),
          step("c3", { name: "home", viewport: "390x844" }),
        ],
      },
      isLoading: false,
    });
    const anchors = () => document.querySelectorAll('[id="run-r1"]');

    const view = render(batchPage("viewport=1280x720"));
    // The facet narrows the steps to the ones in that viewport.
    expect(screen.getByTestId("step-card-c1")).toBeDefined();
    expect(screen.getByTestId("step-card-c2")).toBeDefined();
    expect(screen.queryByTestId("step-card-c3")).toBeNull();
    // n of m counts the steps it leaves.
    expect(screen.getByTestId("result-pending-r1").textContent).toBe(
      "1 of 2 pending",
    );
    expect(anchors()).toHaveLength(1);

    // Without it: a row per viewport, each with its own count, and still one
    // anchor for the run.
    view.rerender(batchPage("status=all"));
    const [wide, narrow] = screen.getAllByTestId("result-row-r1");
    expect(within(wide!).getByText("1 of 2 pending")).toBeDefined();
    expect(within(narrow!).getByText("1 of 1 pending")).toBeDefined();
    expect(screen.getByTestId("step-card-c3")).toBeDefined();
    expect(anchors()).toHaveLength(1);
  });
});

describe("BatchPage Start reviewing", () => {
  test("Start reviewing (N) opens the first pending step inside the filter", async () => {
    withBuild();
    listMock.mockReturnValue(listOf([runItem("r3")]));
    // 4 pending steps in this batch inside the filter.
    nextMock.mockReturnValue({ data: nextAnswer(4), isLoading: false });
    fetchNext.mockResolvedValue({
      ...nextAnswer(4),
      target: { buildId: "b1", runId: "r3", checkpointId: "c9" },
    });
    render(batchPage("status=failed&browser=firefox"));

    const input = {
      projectId: "p1",
      at: { buildId: "b1" },
      facets: { browser: "firefox" },
    };
    expect(nextMock).toHaveBeenCalledWith(
      input,
      expect.objectContaining({ enabled: true }),
    );
    const button = screen.getByTestId("batch-start-reviewing");
    expect(button.textContent).toBe("Start reviewing (4)");

    fireEvent.click(button);
    // The target is asked for afresh (the count may be old by now) with the
    // same scope; the viewer opens on it with the page's context.
    await waitFor(() =>
      expect(routerMock.push).toHaveBeenCalledWith(
        "/projects/p1/runs/r3/checkpoints/c9?status=failed&browser=firefox",
      ),
    );
    expect(fetchNext).toHaveBeenCalledWith(input);
  });

  test("with no facet the batch is the scope and no facets are sent", async () => {
    withBuild();
    listMock.mockReturnValue(listOf([runItem("r1")]));
    render(batchPage());
    const input = nextMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(input).toEqual({ projectId: "p1", at: { buildId: "b1" } });
    expect(input).not.toHaveProperty("facets");
    fireEvent.click(screen.getByTestId("batch-start-reviewing"));
    await waitFor(() =>
      expect(routerMock.push).toHaveBeenCalledWith(
        "/projects/p1/runs/r1/checkpoints/c1",
      ),
    );
  });

  test("is unavailable, with the reason, when nothing in this batch is pending", () => {
    withBuild();
    listMock.mockReturnValue(emptyList());
    nextMock.mockReturnValue({ data: nextAnswer(0), isLoading: false });
    render(batchPage());
    const button = screen.getByTestId("batch-start-reviewing");
    expect(button.textContent).toBe("Start reviewing (0)");
    expect(button.getAttribute("aria-disabled")).toBe("true");
    const reason = document.getElementById(
      button.getAttribute("aria-describedby") ?? "",
    );
    expect(reason?.textContent).toBe("Nothing to review in this batch");
    fireEvent.click(button);
    expect(fetchNext).not.toHaveBeenCalled();
    expect(routerMock.push).not.toHaveBeenCalled();
  });

  test("is unavailable when only the next batch has something (the filter leaves this one empty)", () => {
    withBuild();
    listMock.mockReturnValue(emptyList());
    nextMock.mockReturnValue({
      data: nextAnswer(0, {
        nextBatch: {
          buildId: "b43",
          name: "#43",
          number: 43,
          branch: "main",
          pending: 5,
        },
      }),
      isLoading: false,
    });
    render(batchPage("os=linux"));
    expect(
      screen.getByTestId("batch-start-reviewing").getAttribute("aria-disabled"),
    ).toBe("true");
  });

  test("a count gone stale: nothing found at the click says so and goes nowhere", async () => {
    withBuild();
    listMock.mockReturnValue(listOf([runItem("r1")]));
    fetchNext.mockResolvedValue(nextAnswer(0));
    render(batchPage());
    fireEvent.click(screen.getByTestId("batch-start-reviewing"));
    await waitFor(() =>
      expect(toastMock.info).toHaveBeenCalledWith(
        "Nothing to review in this batch.",
      ),
    );
    expect(routerMock.push).not.toHaveBeenCalled();
    expect(invalidateNext).toHaveBeenCalled();
  });

  test("a failed lookup is reported, and the button comes back", async () => {
    withBuild();
    listMock.mockReturnValue(listOf([runItem("r1")]));
    fetchNext.mockRejectedValue(new Error("boom"));
    render(batchPage());
    fireEvent.click(screen.getByTestId("batch-start-reviewing"));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalled());
    expect(routerMock.push).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(
        screen
          .getByTestId("batch-start-reviewing")
          .hasAttribute("aria-disabled"),
      ).toBe(false),
    );
  });

  test("a reader who may not review gets no Start reviewing and no review.next call", () => {
    withBuild();
    listMock.mockReturnValue(listOf([runItem("r1")]));
    render(batchPage("", false));
    expect(screen.queryByTestId("batch-start-reviewing")).toBeNull();
    expect(nextMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ enabled: false }),
    );
  });
});

describe("BatchPage empty states", () => {
  const NEXT_BATCH = {
    buildId: "b43",
    name: "#43",
    number: 43,
    branch: "main",
    pending: 5,
  };

  test("Nothing to review in this batch. shows Next batch needing review: #‹n› · ‹k› pending → from review.next", () => {
    withBuild();
    listMock.mockReturnValue(emptyList());
    nextMock.mockReturnValue({
      data: nextAnswer(0, { nextBatch: NEXT_BATCH }),
      isLoading: false,
    });
    render(batchPage());
    expect(screen.getByText("Nothing to review in this batch.")).toBeDefined();
    const link = screen.getByTestId("batch-next-batch-link");
    expect(link.textContent).toBe(
      "Next batch needing review: #43 · 5 pending →",
    );
    expect(link.getAttribute("href")).toBe("/projects/p1/builds/b43");

    // The third action: see everything in this batch.
    fireEvent.click(screen.getByRole("button", { name: "Show all tests" }));
    expect(routerMock.replace).toHaveBeenLastCalledWith(
      "/projects/p1/builds/b1?status=all",
      { scroll: false },
    );
  });

  test("a next batch without a number is named by its name", () => {
    withBuild();
    listMock.mockReturnValue(emptyList());
    nextMock.mockReturnValue({
      data: nextAnswer(0, {
        nextBatch: { ...NEXT_BATCH, number: null, name: "nightly-ci" },
      }),
      isLoading: false,
    });
    render(batchPage());
    expect(screen.getByTestId("batch-next-batch-link").textContent).toBe(
      "Next batch needing review: nightly-ci · 5 pending →",
    );
  });

  test("with no other batch to review it still offers Show all tests", () => {
    withBuild();
    listMock.mockReturnValue(emptyList());
    nextMock.mockReturnValue({ data: nextAnswer(0), isLoading: false });
    render(batchPage());
    expect(screen.getByText("Nothing to review in this batch.")).toBeDefined();
    expect(screen.queryByTestId("batch-next-batch-link")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Show all tests" }),
    ).toBeDefined();
  });

  test("a reader who may not review sees no next batch (review.next is closed to them)", () => {
    withBuild();
    listMock.mockReturnValue(emptyList());
    // The mock would answer; the page must not use what it did not ask for.
    nextMock.mockReturnValue({
      data: nextAnswer(0, { nextBatch: NEXT_BATCH }),
      isLoading: false,
    });
    render(batchPage("", false));
    expect(screen.getByText("Nothing to review in this batch.")).toBeDefined();
    expect(screen.queryByTestId("batch-next-batch-link")).toBeNull();
  });

  test("a list with rows has no empty state", () => {
    withBuild();
    listMock.mockReturnValue(listOf([runItem("r1")]));
    render(batchPage());
    expect(screen.queryByText("Nothing to review in this batch.")).toBeNull();
    expect(screen.queryByText("No tests match these filters.")).toBeNull();
  });
});

describe("BatchPage Approve pending with filters", () => {
  test("Approve pending dialog adds the filters note when facets are active", () => {
    withBuild();
    listMock.mockReturnValue(emptyList());
    render(batchPage("os=linux"));
    fireEvent.click(screen.getByTestId("batch-approve-all"));
    expect(screen.getByTestId("approve-pending-dialog").textContent).toContain(
      "Filters don't apply: this approves every pending step in the build.",
    );
  });

  test("without facets there is no such note, even on another chip", () => {
    withBuild();
    listMock.mockReturnValue(emptyList());
    render(batchPage("status=failed"));
    fireEvent.click(screen.getByTestId("batch-approve-all"));
    expect(
      screen.getByTestId("approve-pending-dialog").textContent,
    ).not.toContain("Filters don't apply");
  });
});

describe("BatchPage back to batch (#run anchor)", () => {
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

  /** Serves `runs.list` page by page: `cursor -> { ids, next }`. */
  function serve(
    pages: Record<string, { ids: string[]; next: string | null }>,
  ) {
    listMock.mockImplementation((args: { cursor?: string }) => {
      const p = pages[args.cursor ?? "first"]!;
      return listOf(
        p.ids.map((id) => runItem(id)),
        p.next,
      );
    });
  }
  const cursorsAsked = () =>
    new Set(
      listMock.mock.calls.map((c) => (c[0] as { cursor?: string }).cursor),
    );

  test("#run-<id> anchor: pages are loaded until the anchored run exists (≤ 10 pages) then it is scrolled into view", async () => {
    withBuild();
    arriveAt("#run-r5");
    serve({
      first: { ids: ["r1", "r2"], next: "c1" },
      c1: { ids: ["r3", "r4"], next: "c2" },
      c2: { ids: ["r5"], next: "c3" },
      c3: { ids: ["r6"], next: null },
    });
    render(batchPage());

    await waitFor(() => expect(scrolled).toHaveLength(1));
    const anchor = scrolled[0] as HTMLElement;
    expect(anchor.id).toBe("run-r5");
    expect(scrollSpy).toHaveBeenCalledWith({ block: "center" });
    // Three pages, no more: it stops as soon as the run is there.
    expect(cursorsAsked()).toEqual(new Set([undefined, "c1", "c2"]));
    // Every row loaded on the way is still there, in order.
    expect(
      screen
        .getAllByTestId(/^result-row-/)
        .map((r) => r.getAttribute("data-testid")),
    ).toEqual(["r1", "r2", "r3", "r4", "r5"].map((id) => `result-row-${id}`));
    // Focus is on the run's row, so a keyboard user lands where they were.
    expect(document.activeElement).toBe(
      within(anchor).getByTestId("result-row-r5"),
    );
  });

  test("a run on the first page needs no more pages", async () => {
    withBuild();
    arriveAt("#run-r2");
    serve({
      first: { ids: ["r1", "r2"], next: "c1" },
      c1: { ids: ["r3"], next: null },
    });
    render(batchPage());
    await waitFor(() => expect(scrolled).toHaveLength(1));
    expect((scrolled[0] as HTMLElement).id).toBe("run-r2");
    expect(cursorsAsked()).toEqual(new Set([undefined]));
  });

  test("gives up quietly after 10 pages when the run is never found", async () => {
    withBuild();
    arriveAt("#run-missing");
    // A batch that never ends.
    listMock.mockImplementation((args: { cursor?: string }) => {
      const n = args.cursor ? Number(args.cursor.slice(1)) : 0;
      return listOf([runItem(`r${n}`)], `c${n + 1}`);
    });
    render(batchPage());

    await waitFor(() => expect(cursorsAsked().size).toBe(10));
    // Let anything still scheduled run: the count must not move.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(cursorsAsked().size).toBe(10);
    expect(cursorsAsked().has("c10")).toBe(false);
    expect(scrolled).toHaveLength(0);
    // No error, the rows are there, and the reviewer can still load more.
    expect(screen.getAllByTestId(/^result-row-/)).toHaveLength(10);
    expect(screen.getByRole("button", { name: "Load more" })).toBeDefined();
  });

  test("stops when the batch ends without the run", async () => {
    withBuild();
    arriveAt("#run-gone");
    serve({
      first: { ids: ["r1"], next: "c1" },
      c1: { ids: ["r2"], next: null },
    });
    render(batchPage());
    await waitFor(() =>
      expect(screen.getByTestId("result-row-r2")).toBeDefined(),
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(cursorsAsked()).toEqual(new Set([undefined, "c1"]));
    expect(scrolled).toHaveLength(0);
  });

  test("a hash that is not a run anchor is left alone", async () => {
    withBuild();
    arriveAt("#details");
    serve({
      first: { ids: ["r1"], next: "c1" },
      c1: { ids: ["r2"], next: null },
    });
    render(batchPage());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(cursorsAsked()).toEqual(new Set([undefined]));
    expect(scrolled).toHaveLength(0);
  });

  test("it happens once: a later filter change does not scroll or load pages again", async () => {
    withBuild();
    arriveAt("#run-r1");
    serve({
      first: { ids: ["r1", "r2"], next: "c1" },
      c1: { ids: ["r3"], next: null },
    });
    const view = render(batchPage());
    await waitFor(() => expect(scrolled).toHaveLength(1));

    listMock.mockClear();
    view.rerender(batchPage("status=all"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(scrolled).toHaveLength(1);
    expect(cursorsAsked()).toEqual(new Set([undefined]));
  });
});

describe("BatchPage back to batch: following a link on the page", () => {
  test("a #run-<id> link followed while on the page reveals that run too", async () => {
    withBuild();
    arriveAt("#run-r1");
    const scrolled: string[] = [];
    const spy = vi
      .spyOn(Element.prototype, "scrollIntoView")
      .mockImplementation(function (this: Element) {
        scrolled.push(this.id);
      });
    listMock.mockReturnValue(listOf([runItem("r1"), runItem("r2")]));
    render(batchPage());
    await waitFor(() => expect(scrolled).toEqual(["run-r1"]));

    arriveAt("#run-r2");
    act(() => {
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await waitFor(() => expect(scrolled).toEqual(["run-r1", "run-r2"]));
    spy.mockRestore();
  });
});

describe("BatchPage step cards", () => {
  test("an equal context handed over again redraws no card", () => {
    // A refresh of the route hands the page a new, equal context object. The
    // cards are memoized on the page's own, stable copy of it.
    withBuild();
    listMock.mockReturnValue(listOf([runItem("r1")]));
    listCheckpointsMock.mockReturnValue({
      data: { items: [step("c1", { imageKey: "k1" })] },
      isLoading: false,
    });
    const view = render(batchPage("status=failed&browser=chromium"));
    const drawn = cardRenders.get("k1");
    expect(drawn).toBeGreaterThan(0);

    view.rerender(batchPage("status=failed&browser=chromium"));
    expect(cardRenders.get("k1")).toBe(drawn);

    // A different filter is a different context (the cards open the viewer
    // with it), so they follow it.
    view.rerender(batchPage("status=all&browser=chromium"));
    expect(cardRenders.get("k1")).toBeGreaterThan(drawn!);
  });

  test("step cards open the viewer with the review context", () => {
    withBuild();
    listMock.mockReturnValue(listOf([runItem("r1")]));
    listCheckpointsMock.mockReturnValue({
      data: { items: [step("cX", { name: "Home", browser: "firefox" })] },
      isLoading: false,
    });
    render(batchPage("status=failed&browser=firefox&branch=main&q=nav"));
    fireEvent.click(
      within(screen.getByTestId("step-card-cX")).getByRole("button", {
        name: "Open Home",
      }),
    );
    expect(routerMock.push).toHaveBeenCalledWith(
      "/projects/p1/runs/r1/checkpoints/cX?status=failed&browser=firefox",
    );
  });
});

describe("BatchPage paging", () => {
  test("changing a filter starts the pages over: no query carries the old cursor", async () => {
    withBuild();
    listMock.mockImplementation((args: { cursor?: string }) =>
      args.cursor
        ? listOf([runItem("r2", { name: "Page2Card" })], null)
        : listOf([runItem("r1", { name: "Page1Card" })], "cur1"),
    );
    const view = render(batchPage());
    await waitFor(() => expect(screen.getByText("Page1Card")).toBeDefined());
    fireEvent.click(screen.getByText("Load more"));
    await waitFor(() => expect(screen.getByText("Page2Card")).toBeDefined());
    expect(lastListInput().cursor).toBe("cur1");

    // The chip changes (here from outside: Back / Forward would do the same).
    listMock.mockImplementation(() =>
      listOf([runItem("r9", { name: "OtherCard" })], null),
    );
    const before = listMock.mock.calls.length;
    view.rerender(batchPage("status=failed"));
    const after = listMock.mock.calls.slice(before);
    expect(after.length).toBeGreaterThan(0);
    for (const [input] of after) {
      expect((input as { cursor?: string }).cursor).toBeUndefined();
    }
    expect(screen.getByText("OtherCard")).toBeDefined();
    expect(screen.queryByText("Page1Card")).toBeNull();
    expect(screen.queryByText("Page2Card")).toBeNull();
  });

  test("Load more is held back while the previous filter's page is still showing", () => {
    withBuild();
    listMock.mockReturnValue(
      listOf([runItem("r1")], "cur-old", { isPlaceholderData: false }),
    );
    const view = render(batchPage());

    // The filter changed and the list keeps the previous filter's page in view
    // until the new one answers; its cursor belongs to the old filter.
    listMock.mockReturnValue(
      listOf([runItem("r1")], "cur-old", { isPlaceholderData: true }),
    );
    view.rerender(batchPage("status=failed"));
    const button = screen.getByRole("button", {
      name: "Load more",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    const before = listMock.mock.calls.length;
    fireEvent.click(button);
    for (const [input] of listMock.mock.calls.slice(before)) {
      expect((input as { cursor?: string }).cursor).toBeUndefined();
    }

    // The new filter answered: Load more works, with its cursor.
    listMock.mockReturnValue(
      listOf([runItem("r7")], "cur-new", { isPlaceholderData: false }),
    );
    view.rerender(batchPage("status=failed"));
    const ready = screen.getByRole("button", {
      name: "Load more",
    }) as HTMLButtonElement;
    expect(ready.disabled).toBe(false);
    fireEvent.click(ready);
    expect(lastListInput().cursor).toBe("cur-new");
  });
});

describe("the batch route", () => {
  test("hands the request's search params to the page, parsed", async () => {
    const tree = (await BuildDetailPage({
      params: Promise.resolve({ projectId: "p1", buildId: "b1" }),
      searchParams: Promise.resolve({
        status: "failed",
        viewport: ["390x844", "ignored"],
        browser: "",
        bogus: "1",
      }),
    })) as ReactElement<{
      projectId: string;
      buildId: string;
      canReview: boolean;
      context: unknown;
    }>;
    expect(tree.props).toMatchObject({
      projectId: "p1",
      buildId: "b1",
      canReview: true,
      context: { status: "failed", facets: { viewport: "390x844" } },
    });
  });

  test("a clean URL is Needs review with no facets", async () => {
    const tree = (await BuildDetailPage({
      params: Promise.resolve({ projectId: "p1", buildId: "b1" }),
      searchParams: Promise.resolve({}),
    })) as ReactElement<{ context: unknown }>;
    expect(tree.props.context).toEqual({ status: "needs-review", facets: {} });
  });
});
