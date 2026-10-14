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

const routerMock = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
const urlState = vi.hoisted(() => ({ search: "" }));
vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
  usePathname: () => "/inbox",
  useSearchParams: () => new URLSearchParams(urlState.search),
}));
const toastMock = vi.hoisted(() => ({
  info: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: toastMock }));
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
const pendingMock = vi.fn();
const fetchNext = vi.fn();
const invalidate = vi.hoisted(() => ({ list: vi.fn(), pendingCount: vi.fn() }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      review: { next: { fetch: fetchNext } },
      builds: {
        list: { invalidate: invalidate.list },
        pendingCount: { invalidate: invalidate.pendingCount },
      },
    }),
    builds: {
      list: { useQuery: (...a: unknown[]) => listMock(...a) },
      pendingCount: { useQuery: (...a: unknown[]) => pendingMock(...a) },
    },
  },
}));

import { InboxPage } from "@/app/(protected)/inbox/_components/inbox-page";
import Page from "@/app/(protected)/inbox/page";
import { parseReviewContext, type ReviewContext } from "@/lib/review-context";

const ctxOf = (search = ""): ReviewContext => {
  urlState.search = search;
  return parseReviewContext(new URLSearchParams(search));
};

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);

const build = (over: Record<string, unknown> = {}) => ({
  id: "b1",
  projectId: "p1",
  ciBuildId: "c",
  number: 42,
  branchName: "feature/new-nav",
  name: null,
  testName: null,
  properties: {},
  runCount: 2,
  runningCount: 0,
  unresolvedCount: 1,
  failedCount: 0,
  passedCount: 0,
  abortedCount: 0,
  emptyCount: 0,
  pendingCheckpoints: 5,
  aggregateStatus: "unresolved",
  createdAt: hoursAgo(1),
  updatedAt: hoursAgo(1),
  ...over,
});

const result = (items: unknown[], over: Record<string, unknown> = {}) => ({
  data: { items, nextCursor: null as string | null },
  isLoading: false,
  isFetching: false,
  isError: false,
  refetch: vi.fn(),
  ...over,
});

/** The main list and the one-batch "latest" probe are the same procedure. */
function serve(opts: {
  main?: ReturnType<typeof result>;
  latest?: ReturnType<typeof result>;
  pending?: number | null;
}) {
  const main = opts.main ?? result([build()]);
  const latest = opts.latest ?? result([build()]);
  listMock.mockImplementation((input: { limit?: number }) =>
    input.limit === 1 ? latest : main,
  );
  pendingMock.mockReturnValue(
    opts.pending === null
      ? { data: undefined, isLoading: true, refetch: vi.fn() }
      : {
          data: { total: opts.pending ?? 3 },
          isLoading: false,
          refetch: vi.fn(),
        },
  );
}

/** The main list's input of the most recent render (the one without `limit: 1`). */
const mainInput = (): Record<string, unknown> => {
  const calls = listMock.mock.calls.filter(
    (c) => (c[0] as { limit?: number }).limit !== 1,
  );
  return calls[calls.length - 1]?.[0] as Record<string, unknown>;
};

beforeEach(() => {
  routerMock.push.mockReset();
  routerMock.replace.mockReset();
  fetchNext.mockReset();
  listMock.mockReset();
  pendingMock.mockReset();
  invalidate.list.mockReset();
  invalidate.pendingCount.mockReset();
  for (const fn of Object.values(toastMock)) fn.mockReset();
  urlState.search = "";
  serve({});
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const chipNames = ["Needs review", "Failed", "Running", "Passed", "All"];
const chip = (name: string) => screen.getByRole("button", { name });

describe("Batches: the status chips", () => {
  test("defaults to Needs review and sends needsReview: true", () => {
    render(<InboxPage context={ctxOf()} />);

    expect(mainInput()).toMatchObject({ projectId: "p1", needsReview: true });
    expect(mainInput()).not.toHaveProperty("status");
    expect(mainInput()).not.toHaveProperty("anyFailed");
    expect(chip("Needs review").getAttribute("aria-pressed")).toBe("true");
    for (const other of chipNames.slice(1)) {
      expect(chip(other).getAttribute("aria-pressed")).toBe("false");
    }
  });

  test("shows the chips in order: Needs review · Failed · Running · Passed · All", () => {
    render(<InboxPage context={ctxOf()} />);
    const group = screen.getByRole("group", { name: /status/i });
    expect(
      within(group)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(chipNames);
  });

  test("chips Needs review · Failed · Running · Passed · All write ?status (default omitted)", () => {
    const written = (name: string): unknown => {
      cleanup();
      routerMock.replace.mockReset();
      render(<InboxPage context={ctxOf()} />);
      fireEvent.click(chip(name));
      return routerMock.replace.mock.calls.at(-1);
    };
    expect(written("Failed")).toEqual([
      "/inbox?status=failed",
      { scroll: false },
    ]);
    expect(written("Running")).toEqual([
      "/inbox?status=running",
      { scroll: false },
    ]);
    expect(written("Passed")).toEqual([
      "/inbox?status=passed",
      { scroll: false },
    ]);
    expect(written("All")).toEqual(["/inbox?status=all", { scroll: false }]);

    // The default is omitted from the URL: going back to Needs review leaves
    // no `status` at all.
    cleanup();
    routerMock.replace.mockReset();
    render(<InboxPage context={ctxOf("status=passed")} />);
    fireEvent.click(chip("Needs review"));
    expect(routerMock.replace).toHaveBeenCalledWith("/inbox", {
      scroll: false,
    });
  });

  test("each chip asks the list for its own rule: filters, not a partition", () => {
    const sent = (search: string) => {
      cleanup();
      listMock.mockClear();
      render(<InboxPage context={ctxOf(search)} />);
      return mainInput();
    };
    expect(sent("status=failed")).toMatchObject({ anyFailed: true });
    expect(sent("status=failed")).not.toHaveProperty("status");
    expect(sent("status=failed")).not.toHaveProperty("needsReview");
    expect(sent("status=running")).toMatchObject({ status: "running" });
    expect(sent("status=passed")).toMatchObject({ status: "passed" });
    const all = sent("status=all");
    expect(all).not.toHaveProperty("status");
    expect(all).not.toHaveProperty("needsReview");
    expect(all).not.toHaveProperty("anyFailed");
  });

  test("each chip's tooltip states its rule", () => {
    render(<InboxPage context={ctxOf()} />);
    const rules: Record<string, string> = {
      "Needs review": "Batches with at least one step waiting for review",
      Failed: "Batches with at least one failed test",
      Running: "Batches still running",
      Passed: "Batches where every test passed",
      All: "Every batch",
    };
    for (const [name, rule] of Object.entries(rules)) {
      const id = chip(name).getAttribute("aria-describedby");
      expect(id, `${name} has a description`).toBeTruthy();
      expect(document.getElementById(id ?? "")?.textContent).toBe(rule);
    }
  });

  test("hovering a chip shows its rule", async () => {
    render(<InboxPage context={ctxOf()} />);
    fireEvent.focus(chip("Failed"));
    const tip = await screen.findByRole("tooltip");
    expect(tip.textContent).toBe("Batches with at least one failed test");
  });
});

describe("Batches: branch and search in the URL", () => {
  test("branch filter and search live in the URL", () => {
    vi.useFakeTimers();
    render(<InboxPage context={ctxOf()} />);

    fireEvent.change(screen.getByLabelText("Filter by branch"), {
      target: { value: "feature/new-nav" },
    });
    // Debounced: nothing is written while the reviewer is still typing.
    expect(routerMock.replace).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(routerMock.replace).toHaveBeenLastCalledWith(
      "/inbox?branch=feature%2Fnew-nav",
      { scroll: false },
    );

    fireEvent.change(screen.getByTestId("inbox-search-input"), {
      target: { value: "  nav " },
    });
    act(() => {
      vi.advanceTimersByTime(400);
    });
    // The search is trimmed, and joins the branch already written (the mocked
    // router does not move the URL, so this is the setter composing patches).
    expect(routerMock.replace).toHaveBeenLastCalledWith(
      "/inbox?branch=feature%2Fnew-nav&q=nav",
      { scroll: false },
    );
  });

  test("Enter writes the branch at once", () => {
    vi.useFakeTimers();
    render(<InboxPage context={ctxOf()} />);
    const input = screen.getByLabelText("Filter by branch");
    fireEvent.change(input, { target: { value: "main" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(routerMock.replace).toHaveBeenLastCalledWith("/inbox?branch=main", {
      scroll: false,
    });
  });

  test("a branch in the URL fills the field and is sent to the list", () => {
    render(<InboxPage context={ctxOf("branch=release%2F2")} />);
    expect(
      (screen.getByLabelText("Filter by branch") as HTMLInputElement).value,
    ).toBe("release/2");
    expect(mainInput()).toMatchObject({
      needsReview: true,
      branch: "release/2",
    });
  });

  test("the URL catching up with an earlier write does not overwrite what is being typed", () => {
    vi.useFakeTimers();
    const { rerender } = render(<InboxPage context={ctxOf()} />);
    const input = screen.getByTestId("inbox-search-input") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "ab" } });
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(routerMock.replace).toHaveBeenLastCalledWith("/inbox?q=ab", {
      scroll: false,
    });

    // Typing on while the server answers the first write.
    fireEvent.change(input, { target: { value: "abc" } });
    rerender(<InboxPage context={ctxOf("q=ab")} />);
    expect(input.value).toBe("abc");

    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(routerMock.replace).toHaveBeenLastCalledWith("/inbox?q=abc", {
      scroll: false,
    });

    // A change from elsewhere (Back, a link) is followed.
    rerender(<InboxPage context={ctxOf("q=zzz")} />);
    expect(input.value).toBe("zzz");
  });

  test("a search in the URL fills the field and narrows the loaded rows", () => {
    serve({
      main: result([
        build({ id: "b1", number: 1, branchName: "feature/alpha" }),
        build({ id: "b2", number: 2, branchName: "feature/beta" }),
      ]),
    });
    render(<InboxPage context={ctxOf("q=beta")} />);
    expect(
      (screen.getByTestId("inbox-search-input") as HTMLInputElement).value,
    ).toBe("beta");
    expect(screen.queryByTestId("inbox-batch-row-b1")).toBeNull();
    expect(screen.getByTestId("inbox-batch-row-b2")).toBeDefined();
    // Search is client-side: the list is not asked to search.
    expect(mainInput()).not.toHaveProperty("q");
  });

  test("a search narrows the rows as the reviewer types, before the URL catches up", () => {
    vi.useFakeTimers();
    serve({
      main: result([
        build({ id: "b1", number: 1, branchName: "feature/alpha" }),
        build({ id: "b2", number: 2, branchName: "feature/beta" }),
      ]),
    });
    render(<InboxPage context={ctxOf()} />);
    fireEvent.change(screen.getByTestId("inbox-search-input"), {
      target: { value: "alpha" },
    });
    expect(screen.getByTestId("inbox-batch-row-b1")).toBeDefined();
    expect(screen.queryByTestId("inbox-batch-row-b2")).toBeNull();
  });
});

describe("Batches: rows", () => {
  test("renders a batch row with status word, branch and run count", () => {
    render(<InboxPage context={ctxOf("status=all")} />);
    const row = screen.getByTestId("inbox-batch-row-b1");
    expect(within(row).getByText("Unresolved")).toBeDefined();
    expect(within(row).getByText("feature/new-nav")).toBeDefined();
    expect(within(row).getByText("#42")).toBeDefined();
  });

  test("rows show ‹N› pending", () => {
    serve({
      main: result([
        build({ id: "b1", pendingCheckpoints: 5 }),
        build({ id: "b2", number: 43, pendingCheckpoints: 0 }),
      ]),
    });
    render(<InboxPage context={ctxOf("status=all")} />);

    expect(
      within(screen.getByTestId("inbox-batch-row-b1")).getByText(/5 pending/),
    ).toBeDefined();
    // Nothing pending: no count, and no leftover "(1)" unresolved marker.
    const quiet = screen.getByTestId("inbox-batch-row-b2");
    expect(within(quiet).queryByText(/pending/)).toBeNull();
    expect(within(quiet).queryByText("(1)")).toBeNull();
  });

  test("a row opens its batch, carrying the status", () => {
    render(<InboxPage context={ctxOf()} />);
    const row = screen.getByTestId("inbox-batch-row-b1");
    expect(within(row).getByRole("link").getAttribute("href")).toBe(
      "/projects/p1/builds/b1",
    );
    fireEvent.click(row);
    expect(routerMock.push).toHaveBeenLastCalledWith("/projects/p1/builds/b1");

    cleanup();
    render(<InboxPage context={ctxOf("status=failed")} />);
    const failedRow = screen.getByTestId("inbox-batch-row-b1");
    expect(within(failedRow).getByRole("link").getAttribute("href")).toBe(
      "/projects/p1/builds/b1?status=failed",
    );
    fireEvent.click(failedRow);
    expect(routerMock.push).toHaveBeenLastCalledWith(
      "/projects/p1/builds/b1?status=failed",
    );
  });

  test("shows skeleton rows while loading", () => {
    serve({ main: result([], { data: undefined, isLoading: true }) });
    render(<InboxPage context={ctxOf()} />);
    expect(screen.queryByText(/nothing needs review/i)).toBeNull();
    expect(screen.queryByTestId("inbox-empty-none")).toBeNull();
  });

  test("a failed load says so and offers Try again", () => {
    const refetch = vi.fn();
    serve({
      main: result([], { data: undefined, isError: true, refetch }),
    });
    render(<InboxPage context={ctxOf()} />);
    expect(screen.getByText("Couldn't load batches.")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(refetch).toHaveBeenCalled();
  });
});

describe("Batches: paging", () => {
  const page = (items: unknown[], nextCursor: string | null) => ({
    ...result(items),
    data: { items, nextCursor },
  });

  test("Load more asks for the next page and keeps the rows already loaded", () => {
    serve({
      main: page([build({ id: "b1" })], "cursor-2"),
    });
    const { rerender } = render(<InboxPage context={ctxOf()} />);
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));

    serve({ main: page([build({ id: "b2", number: 41 })], null) });
    rerender(<InboxPage context={ctxOf()} />);
    expect(mainInput()).toMatchObject({ cursor: "cursor-2" });
    expect(screen.getByTestId("inbox-batch-row-b1")).toBeDefined();
    expect(screen.getByTestId("inbox-batch-row-b2")).toBeDefined();
  });

  test("changing a filter starts the pages over", () => {
    serve({ main: page([build({ id: "b1" })], "cursor-2") });
    const { rerender } = render(<InboxPage context={ctxOf()} />);
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(mainInput()).toMatchObject({ cursor: "cursor-2" });

    serve({ main: page([build({ id: "b3", number: 40 })], null) });
    rerender(<InboxPage context={ctxOf("status=failed")} />);
    expect(mainInput().cursor).toBeUndefined();
    expect(screen.queryByTestId("inbox-batch-row-b1")).toBeNull();
    expect(screen.getByTestId("inbox-batch-row-b3")).toBeDefined();

    // And back again: the old pages are not resurrected.
    serve({ main: page([build({ id: "b1" })], "cursor-2") });
    rerender(<InboxPage context={ctxOf()} />);
    expect(mainInput().cursor).toBeUndefined();
  });
});

describe("Batches: Start reviewing", () => {
  const target = { buildId: "b1", runId: "r1", checkpointId: "c1" };

  test("Start reviewing (N) opens review.next's target with the context", async () => {
    serve({ pending: 7 });
    fetchNext.mockResolvedValue({ target, scope: "nextBatch" });
    render(<InboxPage context={ctxOf()} />);

    const button = screen.getByRole("button", { name: "Start reviewing (7)" });
    expect(button.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(button);

    // Asked for the project's first pending step: no `at`.
    await waitFor(() =>
      expect(routerMock.push).toHaveBeenCalledWith(
        "/projects/p1/runs/r1/checkpoints/c1",
      ),
    );
    expect(fetchNext).toHaveBeenCalledTimes(1);
    expect(fetchNext).toHaveBeenCalledWith({ projectId: "p1" });
  });

  test("the status travels to the viewer (the Batches page has no facets)", async () => {
    serve({ pending: 2 });
    fetchNext.mockResolvedValue({ target, scope: "nextBatch" });
    render(<InboxPage context={ctxOf("status=failed&browser=firefox")} />);

    fireEvent.click(
      screen.getByRole("button", { name: "Start reviewing (2)" }),
    );
    await waitFor(() =>
      expect(routerMock.push).toHaveBeenCalledWith(
        "/projects/p1/runs/r1/checkpoints/c1?status=failed",
      ),
    );
  });

  test("does not ask twice while it is opening", async () => {
    serve({ pending: 2 });
    let finish: (v: unknown) => void = () => undefined;
    fetchNext.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    render(<InboxPage context={ctxOf()} />);

    fireEvent.click(
      screen.getByRole("button", { name: "Start reviewing (2)" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Start reviewing (2)" }),
    );
    expect(fetchNext).toHaveBeenCalledTimes(1);
    finish({ target, scope: "nextBatch" });
    await waitFor(() => expect(routerMock.push).toHaveBeenCalledTimes(1));
  });

  test("Start reviewing is disabled with a reason when nothing is pending", () => {
    serve({ pending: 0 });
    render(<InboxPage context={ctxOf()} />);

    const button = screen.getByTestId("inbox-start-reviewing");
    expect(button.textContent).toContain("Start reviewing (0)");
    expect(button.getAttribute("aria-disabled")).toBe("true");
    const reason = document.getElementById(
      button.getAttribute("aria-describedby") ?? "",
    );
    expect(reason?.textContent).toBe("Nothing needs review");

    fireEvent.click(button);
    expect(fetchNext).not.toHaveBeenCalled();
    expect(routerMock.push).not.toHaveBeenCalled();
  });

  test("waits quietly for the count to load", () => {
    serve({ pending: null });
    render(<InboxPage context={ctxOf()} />);
    const button = screen.getByTestId("inbox-start-reviewing");
    expect(button.textContent?.trim()).toBe("Start reviewing");
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  test("stays usable when only the count failed to load", async () => {
    serve({ pending: null });
    pendingMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      refetch: vi.fn(),
    });
    fetchNext.mockResolvedValue({
      target: { buildId: "b1", runId: "r1", checkpointId: "c1" },
      scope: "nextBatch",
    });
    render(<InboxPage context={ctxOf()} />);

    fireEvent.click(screen.getByRole("button", { name: "Start reviewing" }));
    await waitFor(() =>
      expect(routerMock.push).toHaveBeenCalledWith(
        "/projects/p1/runs/r1/checkpoints/c1",
      ),
    );
  });

  test("when the count was stale and nothing is left, says so and refreshes the counts", async () => {
    serve({ pending: 4 });
    fetchNext.mockResolvedValue({ target: null, scope: "none" });
    render(<InboxPage context={ctxOf()} />);

    fireEvent.click(
      screen.getByRole("button", { name: "Start reviewing (4)" }),
    );
    await waitFor(() =>
      expect(toastMock.info).toHaveBeenCalledWith("Nothing needs review."),
    );
    expect(routerMock.push).not.toHaveBeenCalled();
    expect(invalidate.pendingCount).toHaveBeenCalled();
    expect(invalidate.list).toHaveBeenCalled();
  });

  test("a failed lookup says so and leaves the button usable", async () => {
    serve({ pending: 4 });
    fetchNext.mockRejectedValue(new Error("offline"));
    render(<InboxPage context={ctxOf()} />);

    fireEvent.click(
      screen.getByRole("button", { name: "Start reviewing (4)" }),
    );
    await waitFor(() => expect(toastMock.error).toHaveBeenCalled());
    expect(routerMock.push).not.toHaveBeenCalled();
    expect(
      screen
        .getByRole("button", { name: "Start reviewing (4)" })
        .getAttribute("aria-disabled"),
    ).toBeNull();
  });
});

describe("Batches: empty states name a next action", () => {
  test("empty Needs review shows the latest batch and Show all batches", () => {
    serve({
      main: result([]),
      latest: result([
        build({
          id: "b42",
          number: 42,
          aggregateStatus: "passed",
          pendingCheckpoints: 0,
          createdAt: hoursAgo(3),
        }),
      ]),
    });
    render(<InboxPage context={ctxOf()} />);

    expect(screen.getByText("Nothing needs review.")).toBeDefined();
    // The latest batch is asked for with a limit of one and no status.
    const probe = listMock.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .find((i) => i.limit === 1);
    expect(probe).toEqual({ projectId: "p1", limit: 1 });

    const link = screen.getByRole("link", { name: /Latest batch #42/ });
    expect(link.getAttribute("href")).toBe(
      "/projects/p1/builds/b42?status=all",
    );
    expect(within(link).getByText("Passed")).toBeDefined();
    expect(within(link).getByText("3h ago")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Show all batches" }));
    expect(routerMock.replace).toHaveBeenCalledWith("/inbox?status=all", {
      scroll: false,
    });
  });

  test("names the latest batch by its display name when it has no number", () => {
    serve({
      main: result([]),
      latest: result([
        build({ id: "bx", number: null, name: "nightly", ciBuildId: null }),
      ]),
    });
    render(<InboxPage context={ctxOf()} />);
    expect(
      screen.getByRole("link", { name: /Latest batch nightly/ }),
    ).toBeDefined();
  });

  test("does not ask for the latest batch while the list has rows", () => {
    render(<InboxPage context={ctxOf()} />);
    const probe = listMock.mock.calls.find(
      (c) => (c[0] as { limit?: number }).limit === 1,
    );
    expect((probe?.[1] as { enabled?: boolean }).enabled).toBe(false);
  });

  test("filtered empty shows Clear filters", () => {
    serve({
      main: result([]),
      latest: result([build({ id: "b42", number: 42 })]),
    });
    render(<InboxPage context={ctxOf("status=failed&branch=release%2F2")} />);

    expect(screen.getByText("No batches match these filters.")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    // Every filter goes, the chip too: what is left is every batch.
    expect(routerMock.replace).toHaveBeenCalledWith("/inbox?status=all", {
      scroll: false,
    });
  });

  test("a search that matches nothing is a filtered empty too, and Clear filters empties the field", () => {
    render(<InboxPage context={ctxOf("status=all&q=zzz")} />);
    expect(screen.getByText("No batches match these filters.")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(routerMock.replace).toHaveBeenCalledWith("/inbox?status=all", {
      scroll: false,
    });
    expect(
      (screen.getByTestId("inbox-search-input") as HTMLInputElement).value,
    ).toBe("");
  });

  test("an empty Needs review with a branch filter is a filtered empty, not 'nothing needs review'", () => {
    serve({
      main: result([]),
      latest: result([build({ id: "b42", number: 42 })]),
    });
    render(<InboxPage context={ctxOf("branch=release%2F2")} />);
    expect(screen.getByText("No batches match these filters.")).toBeDefined();
    expect(screen.queryByText("Nothing needs review.")).toBeNull();
  });

  test("no batches shows the SDK quick start", () => {
    serve({ main: result([]), latest: result([]) });
    render(<InboxPage context={ctxOf()} />);

    expect(screen.getByText("No batches yet")).toBeDefined();
    expect(
      screen.getByText(/io\.github\.qasecret:furan-selenium:/),
    ).toBeDefined();
    const link = screen.getByRole("link", {
      name: /create a personal access token/i,
    });
    expect(link.getAttribute("href")).toBe("/account/tokens");
    expect(screen.queryByText("Nothing needs review.")).toBeNull();
  });

  test("no batches at all stays the quick start even with filters set", () => {
    serve({ main: result([]), latest: result([]) });
    render(<InboxPage context={ctxOf("status=failed")} />);
    expect(screen.getByText("No batches yet")).toBeDefined();
  });
});

describe("Batches: the server page", () => {
  test("parses the request's search params and hands the context to the page", async () => {
    const tree = (await Page({
      searchParams: Promise.resolve({
        status: "failed",
        branch: "main",
        q: ["first", "second"],
        junk: "x",
      }),
    })) as { props: { children: Array<{ type: unknown; props: unknown }> } };

    const pageEl = tree.props.children.find((c) => c.type === InboxPage);
    expect(pageEl?.props).toEqual({
      context: { status: "failed", facets: {}, branch: "main", q: "first" },
    });
  });

  test("a bad status falls back to Needs review", async () => {
    const tree = (await Page({
      searchParams: Promise.resolve({ status: "unresolved" }),
    })) as { props: { children: Array<{ type: unknown; props: unknown }> } };
    const pageEl = tree.props.children.find((c) => c.type === InboxPage);
    expect(pageEl?.props).toEqual({
      context: { status: "needs-review", facets: {} },
    });
  });
});
