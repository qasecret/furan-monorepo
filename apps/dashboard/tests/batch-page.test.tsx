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
const invalidateFacets = vi.fn();
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      review: { next: { fetch: fetchNext, invalidate: invalidateNext } },
      runs: { facets: { invalidate: invalidateFacets } },
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

import {
  BATCH_LIST,
  BATCH_LIST_ATTR,
} from "@/app/(protected)/projects/[projectId]/builds/[buildId]/_components/batch-commands";
import { BatchPage } from "@/app/(protected)/projects/[projectId]/builds/[buildId]/_components/batch-page";
import BuildDetailPage from "@/app/(protected)/projects/[projectId]/builds/[buildId]/page";
import { usePaletteStore } from "@/components/cmdk/use-command-palette";
import { ShortcutsSheet } from "@/components/shortcuts/shortcuts-sheet";
import { useShortcutsSheet } from "@/components/shortcuts/use-shortcuts-sheet";
import { CommandDispatcher } from "@/lib/commands/dispatcher";
import { GlobalCommands } from "@/lib/commands/global-commands";
import { useSingleKeyStore } from "@/lib/commands/prefs";
import {
  CommandRoleProvider,
  resolveCommands,
  useCommandRegistry,
} from "@/lib/commands/registry";
import { parseReviewContext } from "@/lib/review-context";
import type { ViewerRole } from "@/lib/roles";

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
  invalidateNext.mockReset();
  invalidateFacets.mockReset();
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
  device: null,
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

  test("a batch with no tests offers Back to batches, keeping the status", () => {
    withBuild();
    listMock.mockReturnValue(emptyList());
    render(batchPage("status=all"));
    const back = screen.getByRole("link", { name: "Back to batches" });
    expect(back.getAttribute("href")).toBe("/inbox?status=all");
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

describe("BatchPage environment facets: device", () => {
  test("a run with steps on two devices: the device facet narrows the steps, n of m counts the matching ones, one #run anchor", () => {
    withBuild();
    listMock.mockReturnValue(
      listOf([runItem("r1", { pendingCount: 1, stepCount: 3 })]),
    );
    listCheckpointsMock.mockReturnValue({
      data: {
        items: [
          step("c1", { name: "home", device: "iPhone 15" }),
          step("c2", {
            name: "cart",
            device: "iPhone 15",
            verdict: "passed",
            state: "passed",
          }),
          step("c3", { name: "home", device: "Pixel 8" }),
        ],
      },
      isLoading: false,
    });
    const anchors = () => document.querySelectorAll('[id="run-r1"]');

    const view = render(batchPage("device=iPhone%2015"));
    expect(lastListInput()).toMatchObject({ device: "iPhone 15" });
    expect(screen.getByTestId("step-card-c1")).toBeDefined();
    expect(screen.getByTestId("step-card-c2")).toBeDefined();
    expect(screen.queryByTestId("step-card-c3")).toBeNull();
    expect(screen.getByTestId("result-pending-r1").textContent).toBe(
      "1 of 2 pending",
    );
    expect(anchors()).toHaveLength(1);

    view.rerender(batchPage("status=all"));
    expect(screen.getByTestId("step-card-c3")).toBeDefined();
    expect(screen.getByTestId("result-pending-r1").textContent).toBe(
      "2 of 3 pending",
    );
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

  test("when the review queue cannot be read it says so, stays pressable and asks again", () => {
    withBuild();
    listMock.mockReturnValue(listOf([runItem("r1")]));
    const refetch = vi.fn();
    nextMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      refetch,
    });
    render(batchPage());
    const button = screen.getByTestId(
      "batch-start-reviewing",
    ) as HTMLButtonElement;
    // Never a dead, silent button: it is not disabled, it names the problem
    // (to the eye as a tooltip, to a screen reader as its name) and the way on.
    expect(button.disabled).toBe(false);
    expect(button.getAttribute("title")).toBe("Couldn't load the review queue");
    expect(button.getAttribute("aria-label")).toBe(
      "Start reviewing: Couldn't load the review queue. Press to try again.",
    );

    fireEvent.click(button);
    expect(refetch).toHaveBeenCalledOnce();
    // It retries; it does not open the viewer on a queue it does not have.
    expect(fetchNext).not.toHaveBeenCalled();
    expect(routerMock.push).not.toHaveBeenCalled();
  });

  test("once the queue loads again the button is Start reviewing (N) as ever", async () => {
    withBuild();
    listMock.mockReturnValue(listOf([runItem("r1")]));
    nextMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      refetch: vi.fn(),
    });
    const view = render(batchPage());
    nextMock.mockReturnValue({ data: nextAnswer(3), isLoading: false });
    view.rerender(batchPage());
    const button = screen.getByTestId("batch-start-reviewing");
    expect(button.textContent).toBe("Start reviewing (3)");
    expect(button.hasAttribute("title")).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(routerMock.push).toHaveBeenCalled());
  });

  test("an error that leaves an earlier answer in place does not hide the count", () => {
    withBuild();
    listMock.mockReturnValue(listOf([runItem("r1")]));
    nextMock.mockReturnValue({
      data: nextAnswer(4),
      isLoading: false,
      isError: true,
      refetch: vi.fn(),
    });
    render(batchPage());
    expect(screen.getByTestId("batch-start-reviewing").textContent).toBe(
      "Start reviewing (4)",
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

describe("BatchPage Refresh", () => {
  test("starts the list over and refreshes the environment filter counts of this batch", () => {
    getByIdMock.mockReturnValue({
      data: build,
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    const refetchList = vi.fn();
    listMock.mockReturnValue(
      listOf([runItem("r1")], null, { refetch: refetchList }),
    );
    render(batchPage());
    fireEvent.click(screen.getByTestId("batch-refresh"));
    expect(refetchList).toHaveBeenCalled();
    expect(invalidateNext).toHaveBeenCalled();
    expect(invalidateFacets).toHaveBeenCalledWith({ buildId: "b1" });
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

  test("a page still showing the previous filter's answer does not count toward the cap, nor load more", async () => {
    withBuild();
    arriveAt("#run-missing");
    // A batch that never ends, where each new page is first answered with the
    // previous page kept in view (`placeholderData`), as the query does while
    // it fetches; only a later look finds the real answer.
    const answered = new Set<string | undefined>([undefined]);
    let shown = listOf([runItem("r0")], "c1");
    listMock.mockImplementation((args: { cursor?: string }) => {
      if (answered.has(args.cursor)) {
        const n = args.cursor ? Number(args.cursor.slice(1)) : 0;
        shown = listOf([runItem(`r${n}`)], `c${n + 1}`);
        return shown;
      }
      answered.add(args.cursor);
      return { ...shown, isPlaceholderData: true };
    });
    const view = render(batchPage());
    // The fetches land one after another.
    for (let i = 0; i < 40; i++) {
      await act(async () => {
        view.rerender(batchPage());
      });
    }
    // Ten pages in all, none counted twice: nine more after the first. Without
    // the guard each placeholder look counted as a page, and it stopped near five.
    expect(cursorsAsked().size).toBe(10);
    expect(cursorsAsked().has("c10")).toBe(false);
    expect(scrolled).toHaveLength(0);
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

describe("BatchPage keyboard review (spec §4.3)", () => {
  // Three runs in capture order. r1 has two environments (two rows); its
  // c2 was passed by the machine. r3 has no steps: one row of its own.
  const WIDE = "linux|chromium|1280x720";
  const NARROW = "linux|chromium|390x844";
  const ORDER = [
    `run:r1:${WIDE}`,
    "step:c1",
    "step:c2",
    `run:r1:${NARROW}`,
    "step:c3",
    `run:r2:${WIDE}`,
    "step:c4",
    "step:c5",
    "run:r3:none",
  ];
  const NEWER = { runId: "rN", buildId: "b2", buildName: "#43" };

  /** Serves the batch; `over` changes a step by id. */
  function serveBatch(over: Record<string, Record<string, unknown>> = {}) {
    withBuild();
    listMock.mockReturnValue(
      listOf([
        runItem("r1", { pendingCount: 2, stepCount: 3 }),
        runItem("r2", { pendingCount: 2, stepCount: 2 }),
        runItem("r3", { pendingCount: 0, stepCount: 0 }),
      ]),
    );
    const steps: Record<string, ReturnType<typeof step>[]> = {
      r1: [
        step("c1", over.c1),
        step("c2", { verdict: "passed", state: "passed", ...over.c2 }),
        step("c3", { viewport: "390x844", ...over.c3 }),
      ],
      r2: [step("c4", over.c4), step("c5", { state: "new", ...over.c5 })],
      r3: [],
    };
    listCheckpointsMock.mockImplementation(({ runId }: { runId: string }) => ({
      data: { items: steps[runId] ?? [] },
      isLoading: false,
    }));
  }

  /** The protected layout's keyboard parts around the page. */
  function Keyboard({
    search = "",
    role = "editor",
    canReview = true,
  }: {
    search?: string;
    role?: ViewerRole;
    canReview?: boolean;
  }) {
    return (
      <CommandRoleProvider role={role}>
        <GlobalCommands />
        <CommandDispatcher />
        {batchPage(search, canReview)}
        <ShortcutsSheet />
      </CommandRoleProvider>
    );
  }

  /** A keydown on the focused element, as the browser sends it. */
  function press(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
    const e = new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
      ...init,
    });
    act(() => {
      (document.activeElement ?? document.body).dispatchEvent(e);
    });
    return e;
  }

  /** The cursor item focus is on. */
  const focused = () =>
    document.activeElement?.getAttribute("data-cursor-id") ?? null;
  /** The list's one Tab stop. */
  const tabStops = () =>
    Array.from(
      document.querySelectorAll<HTMLElement>('[data-cursor-id][tabindex="0"]'),
    ).map((el) => el.getAttribute("data-cursor-id"));
  const item = (id: string) =>
    document.querySelector<HTMLElement>(`[data-cursor-id="${id}"]`)!;
  const wideRow = () => item(`run:r1:${WIDE}`);
  /** Presses `j` until focus is on `id`. */
  function walkTo(id: string) {
    for (let i = 0; i <= ORDER.length && focused() !== id; i++) press("j");
    expect(focused()).toBe(id);
  }

  beforeEach(() => {
    useCommandRegistry.setState({ entries: [], role: "guest" });
    useSingleKeyStore.setState({ on: true });
    usePaletteStore.setState({ open: false });
    useShortcutsSheet.setState({ open: false });
    reviewSpies.decide.mockReset();
    reviewSpies.undo.mockReset();
  });

  test("registers spec §4.3's commands with their labels, keys and scope", () => {
    serveBatch();
    render(<Keyboard />);
    const table = Object.fromEntries(
      resolveCommands()
        .filter(({ scope }) => scope === "batch")
        .map(({ command }) => [
          command.id,
          {
            label: command.label,
            keys: command.keys ?? [],
            ...(command.repeat !== undefined && { repeat: command.repeat }),
            ...(command.focusWithin !== undefined && {
              focusWithin: command.focusWithin,
            }),
          },
        ]),
    );
    const inList = BATCH_LIST;
    expect(table).toEqual({
      "list.next": {
        label: "Next item",
        keys: ["j", { key: "ArrowDown", focusWithin: inList }],
        repeat: true,
      },
      "list.prev": {
        label: "Previous item",
        keys: ["k", { key: "ArrowUp", focusWithin: inList }],
        repeat: true,
      },
      "list.first": {
        label: "First item",
        keys: [{ key: "Home", focusWithin: inList, repeat: true }],
      },
      "list.last": {
        label: "Last item",
        keys: [{ key: "End", focusWithin: inList, repeat: true }],
      },
      "batch.expand": {
        label: "Expand run",
        keys: ["ArrowRight"],
        focusWithin: inList,
      },
      "batch.collapse": {
        label: "Collapse run",
        keys: ["ArrowLeft"],
        focusWithin: inList,
      },
      "batch.open": {
        label: "Open step",
        keys: [{ key: "Enter", focusWithin: inList }, "o"],
      },
      "batch.approve": {
        label: "Approve step",
        keys: ["a"],
        focusWithin: inList,
      },
      "batch.reject": {
        label: "Reject step",
        keys: ["r"],
        focusWithin: inList,
      },
      "batch.start": { label: "Start reviewing", keys: ["s"] },
    });
    // The list is the marked one, built from one attribute.
    expect(BATCH_LIST).toBe(`[${BATCH_LIST_ATTR}]`);
    expect(screen.getByTestId("batch-results").matches(BATCH_LIST)).toBe(true);
  });

  test("the scroll container leaves room for the sticky header", () => {
    serveBatch();
    render(<Keyboard />);
    const header = screen.getByText("Execution Cloud").parentElement!;
    expect(header.className).toContain("sticky");
    expect(header.className).toContain("top-0");
    // The header is py-2 + a 16px line + a 1px rule (33px); 36px clears it.
    const scroller = header.parentElement!;
    expect(scroller.className).toContain("overflow-y-auto");
    expect(scroller.className).toContain("scroll-pt-9");
    expect(scroller.contains(screen.getByTestId("batch-results"))).toBe(true);
  });

  test("j/k walk run rows and the steps of expanded runs in capture order", () => {
    serveBatch();
    render(<Keyboard />, { reactStrictMode: true });
    // One Tab stop, the first item, before any key.
    expect(tabStops()).toEqual([ORDER[0]]);

    const walked: (string | null)[] = [];
    for (let i = 0; i < ORDER.length; i++) {
      expect(press("j").defaultPrevented).toBe(true);
      walked.push(focused());
    }
    // Every row is an item of its own, even two of one run (R22).
    expect(walked).toEqual(ORDER);
    expect(tabStops()).toEqual(["run:r3:none"]);
    // The end clamps.
    press("j");
    expect(focused()).toBe("run:r3:none");

    const back: (string | null)[] = [];
    for (let i = 1; i < ORDER.length; i++) {
      press("k");
      back.push(focused());
    }
    expect(back).toEqual([...ORDER].reverse().slice(1));

    // Held down, j keeps walking (R23).
    expect(press("j", { repeat: true }).defaultPrevented).toBe(true);
    expect(focused()).toBe("step:c1");
    press("k");

    // A collapsed row's steps are not walked.
    fireEvent.click(wideRow());
    expect(wideRow().getAttribute("aria-expanded")).toBe("false");
    press("j");
    expect(focused()).toBe(`run:r1:${NARROW}`);
    // End and Home, from the list.
    press("End");
    expect(focused()).toBe("run:r3:none");
    press("Home");
    expect(focused()).toBe(`run:r1:${WIDE}`);
  });

  test("→ expands, ← collapses, ← on a step goes to its run row", () => {
    serveBatch();
    render(<Keyboard />);
    press("j");
    expect(focused()).toBe(`run:r1:${WIDE}`);

    expect(press("ArrowLeft").defaultPrevented).toBe(true);
    expect(wideRow().getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("step-card-c1")).toBeNull();
    expect(focused()).toBe(`run:r1:${WIDE}`);
    // Collapsed already: ← is the browser's.
    expect(press("ArrowLeft").defaultPrevented).toBe(false);

    // → shows the steps and stays; → again goes to the first step.
    expect(press("ArrowRight").defaultPrevented).toBe(true);
    expect(wideRow().getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("step-card-c1")).toBeDefined();
    expect(focused()).toBe(`run:r1:${WIDE}`);
    press("ArrowRight");
    expect(focused()).toBe("step:c1");
    // On a step, → is the browser's (the steps scroll sideways).
    expect(press("ArrowRight").defaultPrevented).toBe(false);

    // ← on a step goes to its own run row, which stays open.
    press("j");
    expect(focused()).toBe("step:c2");
    press("ArrowLeft");
    expect(focused()).toBe(`run:r1:${WIDE}`);
    expect(wideRow().getAttribute("aria-expanded")).toBe("true");
    walkTo("step:c3");
    press("ArrowLeft");
    expect(focused()).toBe(`run:r1:${NARROW}`);

    // A run without steps has nothing to expand.
    walkTo("run:r3:none");
    expect(press("ArrowRight").defaultPrevented).toBe(false);
    expect(press("ArrowLeft").defaultPrevented).toBe(false);

    // Outside the list, the arrows are the page's.
    act(() => (document.activeElement as HTMLElement).blur());
    expect(press("ArrowLeft").defaultPrevented).toBe(false);
    expect(press("ArrowDown").defaultPrevented).toBe(false);
  });

  test("Enter on a step card opens the viewer with the context; Enter on a run row toggles it", async () => {
    const user = userEvent.setup();
    serveBatch();
    render(<Keyboard search="status=failed&browser=chromium" />);
    walkTo("step:c1");
    await user.keyboard("{Enter}");
    expect(routerMock.push).toHaveBeenCalledOnce();
    expect(routerMock.push).toHaveBeenCalledWith(
      "/projects/p1/runs/r1/checkpoints/c1?status=failed&browser=chromium",
    );
    // `o` does the same.
    press("o");
    expect(routerMock.push).toHaveBeenCalledTimes(2);
    expect(routerMock.push).toHaveBeenLastCalledWith(
      "/projects/p1/runs/r1/checkpoints/c1?status=failed&browser=chromium",
    );

    // Enter on a run row toggles it, once: the key is the row's command,
    // and the button's own click does not follow it.
    routerMock.push.mockClear();
    press("k");
    expect(focused()).toBe(`run:r1:${WIDE}`);
    await user.keyboard("{Enter}");
    expect(wideRow().getAttribute("aria-expanded")).toBe("false");
    await user.keyboard("{Enter}");
    expect(wideRow().getAttribute("aria-expanded")).toBe("true");
    expect(routerMock.push).not.toHaveBeenCalled();

    // `o` on a run row opens the run's first step, with the context.
    press("o");
    expect(routerMock.push).toHaveBeenCalledWith(
      "/projects/p1/runs/r1/checkpoints/_first?status=failed&browser=chromium",
    );
    expect(wideRow().getAttribute("aria-expanded")).toBe("true");

    // Enter on a card's own button keeps that button's action.
    routerMock.push.mockClear();
    act(() => screen.getByTestId("step-approve-c1").focus());
    await user.keyboard("{Enter}");
    expect(reviewSpies.decide).toHaveBeenCalledOnce();
    expect(routerMock.push).not.toHaveBeenCalled();
  });

  test("a approves the focused step through the card's path and the cursor moves to the next step needing review", () => {
    serveBatch();
    render(<Keyboard />);
    walkTo("step:c1");

    const a = press("a");
    expect(a.defaultPrevented).toBe(true);
    // Exactly what the card's Approve button asks for.
    expect(reviewSpies.decide).toHaveBeenCalledOnce();
    expect(reviewSpies.decide).toHaveBeenCalledWith({
      runId: "r1",
      checkpointIds: ["c1"],
      kind: "approved",
      label: "Approved 'c1'",
      goTo: { href: "/projects/p1/runs/r1/checkpoints/c1", name: "c1" },
    });
    // c2 was passed by the machine: the cursor goes on to c3, in the run's
    // other row, with focus, so the next key works at once.
    expect(focused()).toBe("step:c3");
    expect(tabStops()).toEqual(["step:c3"]);

    press("r");
    expect(reviewSpies.decide).toHaveBeenLastCalledWith(
      expect.objectContaining({
        runId: "r1",
        checkpointIds: ["c3"],
        kind: "rejected",
        label: "Rejected 'c3'",
      }),
    );
    // On to the next run.
    expect(focused()).toBe("step:c4");
    press("a");
    expect(focused()).toBe("step:c5");
    // The last one: nothing after it needs review, so the cursor stays.
    press("a");
    expect(focused()).toBe("step:c5");
    expect(
      reviewSpies.decide.mock.calls.map(([args]) => [
        (args as { checkpointIds: string[] }).checkpointIds[0],
        (args as { kind: string }).kind,
      ]),
    ).toEqual([
      ["c1", "approved"],
      ["c3", "rejected"],
      ["c4", "approved"],
      ["c5", "approved"],
    ]);

    // On a run row, or a step nobody needs to review, a / r do nothing.
    reviewSpies.decide.mockClear();
    act(() => item("step:c2").focus());
    expect(press("a").defaultPrevented).toBe(false);
    act(() => wideRow().focus());
    expect(press("r").defaultPrevented).toBe(false);
    expect(reviewSpies.decide).not.toHaveBeenCalled();
  });

  test("a decides only the focused step: not from outside the list", () => {
    serveBatch();
    render(<Keyboard />);
    walkTo("step:c1");
    act(() => screen.getByTestId("batch-refresh").focus());
    expect(press("a").defaultPrevented).toBe(false);
    expect(press("r").defaultPrevented).toBe(false);
    expect(reviewSpies.decide).not.toHaveBeenCalled();
  });

  test("a step whose run takes no decisions has no a / r", () => {
    serveBatch();
    listMock.mockReturnValue(
      listOf([runItem("r1", { statusOverride: "passed" })]),
    );
    render(<Keyboard />);
    walkTo("step:c1");
    expect(press("a").defaultPrevented).toBe(false);
    expect(press("r").defaultPrevented).toBe(false);
    expect(reviewSpies.decide).not.toHaveBeenCalled();
    expect(focused()).toBe("step:c1");
  });

  test("a guest has no a / r", () => {
    serveBatch();
    render(<Keyboard role="guest" canReview={false} />);
    expect(screen.queryByTestId("step-approve-c1")).toBeNull();
    const ids = resolveCommands().map(({ command }) => command.id);
    expect(ids).not.toContain("batch.approve");
    expect(ids).not.toContain("batch.reject");
    expect(ids).not.toContain("batch.start");
    // Moving and opening are everyone's.
    expect(ids).toEqual(expect.arrayContaining(["list.next", "batch.open"]));

    walkTo("step:c1");
    expect(press("a").defaultPrevented).toBe(false);
    expect(press("r").defaultPrevented).toBe(false);
    expect(reviewSpies.decide).not.toHaveBeenCalled();
    expect(focused()).toBe("step:c1");

    // Nor in the sheet.
    act(() => useShortcutsSheet.getState().setOpen(true));
    const sheet = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
    expect(within(sheet).queryByText("Approve step")).toBeNull();
    expect(within(sheet).queryByText("Reject step")).toBeNull();
    expect(within(sheet).getByText("Next item")).toBeDefined();
  });

  test("s starts reviewing this batch", async () => {
    serveBatch();
    fetchNext.mockResolvedValue({
      ...nextAnswer(2),
      target: { buildId: "b1", runId: "r2", checkpointId: "c4" },
    });
    render(<Keyboard search="status=failed" />);
    const button = screen.getByTestId("batch-start-reviewing");
    expect(button.getAttribute("aria-keyshortcuts")).toBe("S");
    expect(button.getAttribute("title")).toBe("Start reviewing (S)");

    expect(press("s").defaultPrevented).toBe(true);
    await waitFor(() =>
      expect(routerMock.push).toHaveBeenCalledWith(
        "/projects/p1/runs/r2/checkpoints/c4?status=failed",
      ),
    );
    expect(fetchNext).toHaveBeenCalledOnce();
    expect(fetchNext).toHaveBeenCalledWith({
      projectId: "p1",
      at: { buildId: "b1" },
    });
  });

  test("s is unavailable with the button, and retries with it", () => {
    serveBatch();
    nextMock.mockReturnValue({ data: nextAnswer(0), isLoading: false });
    const view = render(<Keyboard />);
    expect(press("s").defaultPrevented).toBe(false);
    expect(fetchNext).not.toHaveBeenCalled();

    // The queue failed to load: the button asks again, and so does `s`.
    const refetch = vi.fn();
    nextMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      refetch,
    });
    view.rerender(<Keyboard search="status=all" />);
    expect(press("s").defaultPrevented).toBe(true);
    expect(refetch).toHaveBeenCalledOnce();
  });

  test("a on a step with a newer capture opens the stale-step question", async () => {
    serveBatch({ c1: { newerCapture: NEWER } });
    render(<Keyboard />);
    walkTo("step:c1");

    expect(press("a").defaultPrevented).toBe(true);
    const dialog = await screen.findByTestId("stale-step-dialog");
    expect(dialog.textContent).toContain("Approve an older capture?");
    expect(dialog.textContent).toContain(
      "A newer capture of this step exists in build #43.",
    );
    // Nothing is decided, and the cursor has not gone on.
    expect(reviewSpies.decide).not.toHaveBeenCalled();
    expect(tabStops()).toEqual(["step:c1"]);

    // Cancel: still nothing decided; focus is back on the card.
    fireEvent.click(screen.getByTestId("stale-step-cancel"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.queryByTestId("stale-step-dialog")).toBeNull();
    expect(reviewSpies.decide).not.toHaveBeenCalled();
    expect(focused()).toBe("step:c1");

    // Asked again and confirmed: approved, as the button's question does.
    press("a");
    fireEvent.click(await screen.findByTestId("stale-step-confirm"));
    expect(reviewSpies.decide).toHaveBeenCalledOnce();
    expect(reviewSpies.decide).toHaveBeenCalledWith(
      expect.objectContaining({ checkpointIds: ["c1"], kind: "approved" }),
    );
  });

  test("with a facet select open, j / k / a / r do nothing", async () => {
    serveBatch();
    facetsMock.mockReturnValue({
      data: {
        ...NO_FACETS,
        browser: [
          { value: "chromium", pending: 4 },
          { value: "firefox", pending: 1 },
        ],
      },
      isLoading: false,
    });
    render(<Keyboard />);
    walkTo("step:c1");

    fireEvent.click(screen.getByRole("combobox", { name: /browser/i }));
    const listbox = await screen.findByRole("listbox");
    const option = within(listbox).getByRole("option", {
      name: "firefox · 1 pending",
    });
    act(() => option.focus());
    expect(listbox.contains(document.activeElement)).toBe(true);

    for (const key of ["j", "k", "a", "r", "ArrowDown", "ArrowUp"]) {
      press(key);
      expect(reviewSpies.decide, key).not.toHaveBeenCalled();
      // The select is still open, and focus is still in it: the cursor did
      // not take it.
      expect(screen.getByRole("listbox"), key).toBeDefined();
      expect(
        screen.getByRole("listbox").contains(document.activeElement),
        key,
      ).toBe(true);
      expect(tabStops(), key).toEqual(["step:c1"]);
    }
    expect(routerMock.replace).not.toHaveBeenCalled();
  });

  test("Back to batch sets the cursor on the row it lands on", async () => {
    serveBatch();
    arriveAt("#run-r2");
    render(<Keyboard />);
    await waitFor(() => expect(focused()).toBe(`run:r2:${WIDE}`));
    expect(tabStops()).toEqual([`run:r2:${WIDE}`]);
    // j goes on from there, not from the top.
    press("j");
    expect(focused()).toBe("step:c4");
  });

  test("the list is one Tab stop, and the cursor card's own buttons follow it", async () => {
    const user = userEvent.setup();
    serveBatch();
    render(<Keyboard />);
    walkTo("step:c1");
    const list = screen.getByTestId("batch-results");

    // Into the list from the toolbar: the cursor item, nothing before it.
    act(() => screen.getByTestId("batch-approve-all").focus());
    await user.tab();
    expect(focused()).toBe("step:c1");
    // Then the card's own controls, and out of the list: no other item, and
    // no other card's buttons.
    const names: string[] = [];
    for (let i = 0; i < 4; i++) {
      await user.tab();
      names.push(document.activeElement?.getAttribute("aria-label") ?? "");
    }
    expect(names).toEqual([
      "Open c1",
      "Approve c1",
      "Reject c1",
      "Open c1 in the viewer",
    ]);
    await user.tab();
    expect(list.contains(document.activeElement)).toBe(false);
    expect(
      within(screen.getByTestId("step-card-c4"))
        .getAllByRole("button")
        .map((b) => b.getAttribute("tabindex")),
    ).toEqual(["-1", "-1", "-1", "-1"]);

    // A click on another card's button still works, and makes it the cursor.
    fireEvent.click(screen.getByTestId("step-reject-c4"));
    act(() => screen.getByTestId("step-reject-c4").focus());
    expect(tabStops()).toEqual(["step:c4"]);
    expect(reviewSpies.decide).toHaveBeenCalledWith(
      expect.objectContaining({ checkpointIds: ["c4"], kind: "rejected" }),
    );
  });

  test("with nothing to walk, the list's keys are listed and do nothing", () => {
    withBuild();
    listMock.mockReturnValue(emptyList());
    nextMock.mockReturnValue({ data: nextAnswer(0), isLoading: false });
    render(<Keyboard />);
    expect(screen.getByTestId("batch-empty-nothing-to-review")).toBeDefined();
    expect(press("j").defaultPrevented).toBe(false);
    expect(press("o").defaultPrevented).toBe(false);
    act(() => useShortcutsSheet.getState().setOpen(true));
    const sheet = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
    for (const label of ["Next item", "Open step", "Approve step"]) {
      expect(within(sheet).getByText(label)).toBeDefined();
    }
  });

  test("the card's Approve and Reject show their keys", () => {
    serveBatch();
    render(<Keyboard />);
    const approve = screen.getByTestId("step-approve-c1");
    const reject = screen.getByTestId("step-reject-c1");
    expect(approve.getAttribute("aria-keyshortcuts")).toBe("A");
    expect(approve.getAttribute("title")).toBe("Approve (A)");
    expect(reject.getAttribute("aria-keyshortcuts")).toBe("R");
    expect(reject.getAttribute("title")).toBe("Reject (R)");

    // With single-key shortcuts off, the hints go: those keys do nothing.
    act(() => useSingleKeyStore.setState({ on: false }));
    expect(approve.hasAttribute("aria-keyshortcuts")).toBe(false);
    expect(approve.hasAttribute("title")).toBe(false);
    expect(
      screen.getByTestId("batch-start-reviewing").hasAttribute("title"),
    ).toBe(false);
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
