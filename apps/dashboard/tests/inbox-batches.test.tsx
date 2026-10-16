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
// The global commands' ⌘Z: no review session here.
vi.mock("@/lib/review/use-review-mutations", () => ({
  useReviewMutations: () => ({ undo: vi.fn() }),
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
const fetchList = vi.fn();
const invalidate = vi.hoisted(() => ({ list: vi.fn(), pendingCount: vi.fn() }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({
      review: { next: { fetch: fetchNext } },
      builds: {
        list: { invalidate: invalidate.list, fetch: fetchList },
        pendingCount: { invalidate: invalidate.pendingCount },
      },
    }),
    builds: {
      list: { useQuery: (...a: unknown[]) => listMock(...a) },
      pendingCount: { useQuery: (...a: unknown[]) => pendingMock(...a) },
    },
    // The palette's test search; nothing is typed into it here.
    variations: {
      list: {
        useQuery: () => ({
          data: undefined,
          isPending: false,
          isError: false,
          isFetching: false,
        }),
      },
    },
  },
}));

import {
  BATCHES_LIST,
  BATCHES_LIST_ATTR,
} from "@/app/(protected)/inbox/_components/batches-commands";
import { InboxPage } from "@/app/(protected)/inbox/_components/inbox-page";
import Page from "@/app/(protected)/inbox/page";
import { CommandPalette } from "@/components/cmdk/command-palette";
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
import { parseReviewContext, type ReviewContext } from "@/lib/review-context";
import type { ViewerRole } from "@/lib/roles";

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

/**
 * The main list, the one-batch "latest" probe and Start reviewing's filtered
 * Needs review list (`limit: 100`) are the same procedure.
 */
function serve(opts: {
  main?: ReturnType<typeof result>;
  latest?: ReturnType<typeof result>;
  filtered?: ReturnType<typeof result>;
  pending?: number | null;
}) {
  const main = opts.main ?? result([build()]);
  const latest = opts.latest ?? result([build()]);
  const filtered = opts.filtered ?? result([build()]);
  listMock.mockImplementation((input: { limit?: number }) =>
    input.limit === 1 ? latest : input.limit === 100 ? filtered : main,
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

/** The main list's input of the most recent render (the one without a `limit`). */
const mainInput = (): Record<string, unknown> => {
  const calls = listMock.mock.calls.filter(
    (c) => (c[0] as { limit?: number }).limit === undefined,
  );
  return calls[calls.length - 1]?.[0] as Record<string, unknown>;
};

/** Start reviewing's filtered Needs review list: its last input and options. */
const filteredCall = () => {
  const calls = listMock.mock.calls.filter(
    (c) => (c[0] as { limit?: number }).limit === 100,
  );
  const last = calls[calls.length - 1];
  return {
    input: last?.[0] as Record<string, unknown>,
    enabled: (last?.[1] as { enabled?: boolean } | undefined)?.enabled,
  };
};

beforeEach(() => {
  routerMock.push.mockReset();
  routerMock.replace.mockReset();
  fetchNext.mockReset();
  fetchList.mockReset();
  listMock.mockReset();
  pendingMock.mockReset();
  invalidate.list.mockReset();
  invalidate.pendingCount.mockReset();
  for (const fn of Object.values(toastMock)) fn.mockReset();
  urlState.search = "";
  useCommandRegistry.setState({ entries: [], role: "guest" });
  useSingleKeyStore.setState({ on: true });
  usePaletteStore.setState({ open: false });
  useShortcutsSheet.setState({ open: false });
  localStorage.clear();
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
    expect(sent("status=running")).not.toHaveProperty("noPending");
    // Passed leaves out the batches still needing review (Ruling R32).
    expect(sent("status=passed")).toMatchObject({
      status: "passed",
      noPending: true,
    });
    expect(sent("status=passed")).not.toHaveProperty("needsReview");
    const all = sent("status=all");
    expect(all).not.toHaveProperty("status");
    expect(all).not.toHaveProperty("needsReview");
    expect(all).not.toHaveProperty("noPending");
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

  test("a row link carries the status only: Batches has no facets to carry", () => {
    render(
      <InboxPage
        context={ctxOf("status=failed&browser=firefox&os=linux&branch=main")}
      />,
    );
    const row = screen.getByTestId("inbox-batch-row-b1");
    expect(within(row).getByRole("link").getAttribute("href")).toBe(
      "/projects/p1/builds/b1?status=failed",
    );
    fireEvent.click(row);
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

describe("Batches: Start reviewing follows the branch and the search (R34)", () => {
  const target = { buildId: "b2", runId: "r2", checkpointId: "c2" };

  test("without a branch or a search it is the project's count, and the filtered list is not asked for", () => {
    serve({ pending: 7 });
    render(<InboxPage context={ctxOf("status=all")} />);
    expect(
      screen.getByRole("button", { name: "Start reviewing (7)" }),
    ).toBeDefined();
    expect(filteredCall().enabled).toBe(false);
  });

  test("with a branch it counts the filtered Needs review list and opens its first batch's first pending step", async () => {
    const rows = [
      build({ id: "b2", branchName: "feature/a" }),
      build({ id: "b3", branchName: "feature/a" }),
    ];
    serve({ pending: 9, filtered: result(rows) });
    fetchList.mockResolvedValue({ items: rows, nextCursor: null });
    fetchNext.mockResolvedValue({ target, scope: "batch" });
    render(<InboxPage context={ctxOf("status=all&branch=feature%2Fa")} />);

    // The filtered list, not the project's 9: whatever chip is showing.
    expect(filteredCall()).toEqual({
      input: {
        projectId: "p1",
        needsReview: true,
        branch: "feature/a",
        limit: 100,
      },
      enabled: true,
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Start reviewing (2)" }),
    );

    await waitFor(() =>
      expect(routerMock.push).toHaveBeenCalledWith(
        "/projects/p1/runs/r2/checkpoints/c2?status=all",
      ),
    );
    // A fresh read of the same list, then that batch's first pending step.
    expect(fetchList).toHaveBeenCalledWith(filteredCall().input);
    expect(fetchNext).toHaveBeenCalledWith({
      projectId: "p1",
      at: { buildId: "b2" },
    });
  });

  test("with a search it counts and opens only the batches the search matches", async () => {
    const rows = [
      build({ id: "b9", name: "release", number: null, ciBuildId: null }),
      build({ id: "b2", name: "nightly", number: null, ciBuildId: null }),
      build({ id: "b3", name: "nightly-2", number: null, ciBuildId: null }),
    ];
    serve({ pending: 9, filtered: result(rows) });
    fetchList.mockResolvedValue({ items: rows, nextCursor: null });
    fetchNext.mockResolvedValue({ target, scope: "batch" });
    render(<InboxPage context={ctxOf("q=nightly")} />);

    expect(filteredCall().input).toEqual({
      projectId: "p1",
      needsReview: true,
      limit: 100,
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Start reviewing (2)" }),
    );
    await waitFor(() =>
      expect(fetchNext).toHaveBeenCalledWith({
        projectId: "p1",
        at: { buildId: "b2" },
      }),
    );
    await waitFor(() =>
      expect(routerMock.push).toHaveBeenCalledWith(
        "/projects/p1/runs/r2/checkpoints/c2",
      ),
    );
  });

  test("a filtered list longer than one page reads N+", () => {
    serve({
      pending: 300,
      filtered: result([build({ id: "b2" }), build({ id: "b3" })], {
        data: {
          items: [build({ id: "b2" }), build({ id: "b3" })],
          nextCursor: "more",
        },
      }),
    });
    render(<InboxPage context={ctxOf("branch=main")} />);
    expect(
      screen.getByRole("button", { name: "Start reviewing (2+)" }),
    ).toBeDefined();
  });

  test("nothing pending in the filters disables it with the filters' reason", () => {
    serve({ pending: 9, filtered: result([]) });
    render(<InboxPage context={ctxOf("branch=main")} />);

    const button = screen.getByTestId("inbox-start-reviewing");
    expect(button.textContent).toContain("Start reviewing (0)");
    expect(button.getAttribute("aria-disabled")).toBe("true");
    const reason = document.getElementById(
      button.getAttribute("aria-describedby") ?? "",
    );
    expect(reason?.textContent).toBe("Nothing in these filters needs review");
  });

  test("a batch reviewed meanwhile does not take the reviewer outside the filters", async () => {
    const rows = [build({ id: "b2", branchName: "feature/a" })];
    serve({ pending: 9, filtered: result(rows) });
    fetchList.mockResolvedValue({ items: rows, nextCursor: null });
    // b2 has nothing left: the server moves on to another batch.
    fetchNext.mockResolvedValue({
      target: { buildId: "b-other", runId: "r9", checkpointId: "c9" },
      scope: "nextBatch",
    });
    render(<InboxPage context={ctxOf("branch=feature%2Fa")} />);

    fireEvent.click(
      screen.getByRole("button", { name: "Start reviewing (1)" }),
    );
    await waitFor(() =>
      expect(toastMock.info).toHaveBeenCalledWith(
        "That batch has nothing left to review.",
      ),
    );
    expect(routerMock.push).not.toHaveBeenCalled();
    expect(invalidate.list).toHaveBeenCalled();
    expect(invalidate.pendingCount).toHaveBeenCalled();
  });

  test("a fresh read with nothing left in the filters says so and asks for no step", async () => {
    serve({ pending: 9, filtered: result([build({ id: "b2" })]) });
    fetchList.mockResolvedValue({ items: [], nextCursor: null });
    render(<InboxPage context={ctxOf("branch=main")} />);

    fireEvent.click(
      screen.getByRole("button", { name: "Start reviewing (1)" }),
    );
    await waitFor(() =>
      expect(toastMock.info).toHaveBeenCalledWith(
        "Nothing in these filters needs review.",
      ),
    );
    expect(fetchNext).not.toHaveBeenCalled();
    expect(routerMock.push).not.toHaveBeenCalled();
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
    // Branch and search go, and the chip returns to its default (Needs review,
    // which is omitted from the URL): the page's own default view.
    expect(routerMock.replace).toHaveBeenCalledWith("/inbox", {
      scroll: false,
    });
  });

  test("a search that matches nothing is a filtered empty too, and Clear filters empties the field", () => {
    render(<InboxPage context={ctxOf("status=all&q=zzz")} />);
    expect(screen.getByText("No batches match these filters.")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(routerMock.replace).toHaveBeenCalledWith("/inbox", {
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

describe("Batches: keyboard review (spec §4.2)", () => {
  const target = { buildId: "b1", runId: "r1", checkpointId: "c1" };
  const three = () => [
    build({ id: "b1", number: 3 }),
    build({ id: "b2", number: 2 }),
    build({ id: "b3", number: 1 }),
  ];

  /** The protected layout's keyboard parts around the page. */
  function Keyboard({
    context,
    role = "editor",
  }: {
    context: ReviewContext;
    role?: ViewerRole;
  }) {
    return (
      <CommandRoleProvider role={role}>
        <GlobalCommands />
        <CommandDispatcher />
        <InboxPage context={context} />
        <ShortcutsSheet />
        <CommandPalette userRole={role} userId="u1" />
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

  const row = (id: string) => screen.getByTestId(`inbox-batch-row-${id}`);
  const focusOn = (el: HTMLElement) => act(() => el.focus());
  const searchBox = () => screen.getByTestId("inbox-search-input");
  const branchBox = () => screen.getByTestId("inbox-branch-input");
  const startButton = () => screen.getByTestId("inbox-start-reviewing");

  /** Lets the palette finish closing: a picked command runs then. */
  async function settle(): Promise<void> {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  async function openPalette(): Promise<HTMLElement> {
    act(() => usePaletteStore.getState().setOpen(true));
    return screen.findByTestId("command-palette");
  }

  /** The labels of the palette's Actions, in order. */
  function actions(palette: HTMLElement): string[] {
    return within(within(palette).getByRole("group", { name: "Actions" }))
      .getAllByRole("option")
      .map((o) => o.firstElementChild?.textContent ?? "");
  }

  function openSheet(): HTMLElement {
    act(() => useShortcutsSheet.getState().setOpen(true));
    return screen.getByRole("dialog", { name: "Keyboard shortcuts" });
  }

  /** The keys of a sheet row: one entry per key, its tokens as rendered. */
  function keysOf(li: HTMLElement): string[][] {
    return Array.from(li.querySelectorAll("kbd"))
      .filter((k) => k.parentElement?.closest("kbd") == null)
      .map((outer) =>
        Array.from(outer.children).map((child) => child.textContent ?? ""),
      );
  }

  test("registers spec §4.2's commands with their labels, keys and scope", () => {
    render(<Keyboard context={ctxOf()} />);
    const table = Object.fromEntries(
      resolveCommands()
        .filter(({ scope }) => scope === "batches")
        .map(({ command }) => [
          command.id,
          {
            label: command.label,
            keys: command.keys ?? [],
            repeat: command.repeat,
          },
        ]),
    );
    const inList = BATCHES_LIST;
    expect(table).toEqual({
      "list.next": {
        label: "Next row",
        keys: ["j", { key: "ArrowDown", focusWithin: inList }],
        repeat: true,
      },
      "list.prev": {
        label: "Previous row",
        keys: ["k", { key: "ArrowUp", focusWithin: inList }],
        repeat: true,
      },
      "list.first": {
        label: "First row",
        keys: [{ key: "Home", focusWithin: inList, repeat: true }],
      },
      "list.last": {
        label: "Last row",
        keys: [{ key: "End", focusWithin: inList, repeat: true }],
      },
      "batches.open": {
        label: "Open batch",
        keys: [{ key: "Enter", focusWithin: inList }, "o"],
      },
      "batches.start": { label: "Start reviewing", keys: ["s"] },
      "search.focus": { label: "Search batches", keys: ["/"] },
      "batches.show.needs-review": { label: "Show: Needs review", keys: [] },
      "batches.show.failed": { label: "Show: Failed", keys: [] },
      "batches.show.running": { label: "Show: Running", keys: [] },
      "batches.show.passed": { label: "Show: Passed", keys: [] },
      "batches.show.all": { label: "Show: All", keys: [] },
    });
  });

  test("the rows sit in the marked list, and its scroll container leaves room for the sticky header", () => {
    serve({ main: result(three()) });
    render(<Keyboard context={ctxOf()} />);

    const list = row("b1").closest(BATCHES_LIST);
    expect(list).not.toBeNull();
    expect(list?.hasAttribute(BATCHES_LIST_ATTR)).toBe(true);
    expect(list?.contains(row("b3"))).toBe(true);
    // The selector the commands use is built from the one attribute name.
    expect(BATCHES_LIST).toBe(`[${BATCHES_LIST_ATTR}]`);
  });

  test("the scroll container leaves room for the sticky header", () => {
    serve({ main: result(three()) });
    render(<Keyboard context={ctxOf()} />);

    // Walking up, `scrollIntoView` aligns a row to the top of this container:
    // under the sticky header unless the container's scroll padding is as
    // tall as the header (an opaque row of 41px: 12 + 16 + 12 + a 1px rule).
    const header = row("b1").closest("table")?.querySelector("thead");
    expect(header?.classList.contains("sticky")).toBe(true);
    expect(header?.classList.contains("top-0")).toBe(true);
    const scroller = row("b1").closest(".overflow-auto");
    expect(scroller?.classList.contains("scroll-pt-11")).toBe(true);
  });

  test("a row is one Tab stop and its link is not tabbable", async () => {
    const user = userEvent.setup();
    serve({ main: result(three()) });
    render(<Keyboard context={ctxOf()} />);

    const list = row("b1").closest(BATCHES_LIST);

    // The focused row shows a ring (where the cursor is).
    for (const id of ["b1", "b2", "b3"]) {
      expect(row(id).classList.contains("focus-ring")).toBe(true);
    }

    // The first row is the one stop until a row is the cursor; no link is.
    expect([row("b1"), row("b2"), row("b3")].map((r) => r.tabIndex)).toEqual([
      0, -1, -1,
    ]);
    for (const id of ["b1", "b2", "b3"]) {
      const link = within(row(id)).getByRole("link");
      expect(link.tabIndex).toBe(-1);
      // Still a real link: middle-click and open-in-new-tab keep working.
      expect(link.getAttribute("href")).toContain(`/builds/${id}`);
    }

    // Tab from the search box (the last control before the table) enters
    // the list on the row, and the next Tab leaves it.
    focusOn(searchBox());
    await user.tab();
    expect(document.activeElement).toBe(row("b1"));
    await user.tab();
    expect(list?.contains(document.activeElement)).toBe(false);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(row("b1"));

    // The cursor row is the stop.
    press("j");
    expect(document.activeElement).toBe(row("b2"));
    expect([row("b1"), row("b2"), row("b3")].map((r) => r.tabIndex)).toEqual([
      -1, 0, -1,
    ]);
  });

  test("j focuses the first row, j/k move, Enter opens", () => {
    serve({ main: result(three()) });
    render(<Keyboard context={ctxOf("status=failed")} />);
    expect(document.activeElement).toBe(document.body);

    // From anywhere on the page, the first press is the first row.
    press("j");
    expect(document.activeElement).toBe(row("b1"));
    press("j");
    expect(document.activeElement).toBe(row("b2"));
    press("j");
    expect(document.activeElement).toBe(row("b3"));
    // The end holds: no wrap.
    press("j");
    expect(document.activeElement).toBe(row("b3"));
    press("k");
    expect(document.activeElement).toBe(row("b2"));

    // Enter opens the row's batch, the status kept: the row link's address.
    const enter = press("Enter");
    const href = within(row("b2")).getByRole("link").getAttribute("href");
    expect(href).toBe("/projects/p1/builds/b2?status=failed");
    expect(routerMock.push).toHaveBeenCalledTimes(1);
    expect(routerMock.push).toHaveBeenCalledWith(href);
    expect(enter.defaultPrevented).toBe(true);

    // So does o.
    routerMock.push.mockClear();
    press("k");
    const o = press("o");
    expect(routerMock.push).toHaveBeenCalledTimes(1);
    expect(routerMock.push).toHaveBeenCalledWith(
      "/projects/p1/builds/b1?status=failed",
    );
    expect(o.defaultPrevented).toBe(true);
  });

  test("the first k also focuses the first row, and a click or Tab focus sets the cursor", async () => {
    const user = userEvent.setup();
    serve({ main: result(three()) });
    render(<Keyboard context={ctxOf()} />);

    press("k");
    expect(document.activeElement).toBe(row("b1"));

    // A click on a row (which also opens it) is where j starts from.
    await user.click(row("b3"));
    expect(routerMock.push).toHaveBeenCalledWith("/projects/p1/builds/b3");
    focusOn(startButton());
    press("k");
    expect(document.activeElement).toBe(row("b2"));
  });

  test("o opens the cursor row from anywhere, Enter only from the list", () => {
    serve({ main: result(three()) });
    render(<Keyboard context={ctxOf()} />);

    // No cursor yet: nothing to open.
    const none = press("o");
    expect(routerMock.push).not.toHaveBeenCalled();
    expect(none.defaultPrevented).toBe(false);

    press("j");
    press("j");
    expect(document.activeElement).toBe(row("b2"));

    // Focus has moved on to another control: Enter is that control's.
    focusOn(screen.getByRole("button", { name: "Refresh" }));
    const enter = press("Enter");
    expect(routerMock.push).not.toHaveBeenCalled();
    expect(enter.defaultPrevented).toBe(false);

    // Nor is it the page's when nothing in particular has focus.
    act(() => (document.activeElement as HTMLElement).blur());
    expect(document.activeElement).toBe(document.body);
    expect(press("Enter").defaultPrevented).toBe(false);
    expect(routerMock.push).not.toHaveBeenCalled();

    // But o still opens the cursor row.
    press("o");
    expect(routerMock.push).toHaveBeenCalledTimes(1);
    expect(routerMock.push).toHaveBeenCalledWith("/projects/p1/builds/b2");
  });

  test("Enter on a status chip keeps the chip's own action", async () => {
    const user = userEvent.setup();
    serve({ main: result(three()) });
    render(<Keyboard context={ctxOf()} />);

    press("j");
    expect(document.activeElement).toBe(row("b1"));
    focusOn(chip("Failed"));
    await user.keyboard("{Enter}");

    // The chip was pressed; no batch was opened.
    expect(routerMock.replace).toHaveBeenLastCalledWith(
      "/inbox?status=failed",
      {
        scroll: false,
      },
    );
    expect(routerMock.push).not.toHaveBeenCalled();
  });

  test("arrows move only inside the list; outside they do nothing", () => {
    serve({ main: result(three()) });
    render(<Keyboard context={ctxOf()} />);

    // Outside the list the browser keeps them (to scroll the page).
    const outside = chip("Failed");
    focusOn(outside);
    for (const key of ["ArrowDown", "ArrowUp", "Home", "End"]) {
      const e = press(key);
      expect(e.defaultPrevented, key).toBe(false);
      expect(document.activeElement, key).toBe(outside);
    }

    // With a cursor on a row, and focus away from it: still nothing.
    press("j");
    expect(document.activeElement).toBe(row("b1"));
    focusOn(outside);
    press("ArrowDown");
    expect(document.activeElement).toBe(outside);
    press("j");
    // The arrow did not move the cursor: j went from the first row.
    expect(document.activeElement).toBe(row("b2"));

    // Inside the list they move, and the page does not scroll.
    const down = press("ArrowDown");
    expect(document.activeElement).toBe(row("b3"));
    expect(down.defaultPrevented).toBe(true);
    press("ArrowUp");
    expect(document.activeElement).toBe(row("b2"));
    press("End");
    expect(document.activeElement).toBe(row("b3"));
    press("Home");
    expect(document.activeElement).toBe(row("b1"));

    // Held, the arrows keep going.
    press("ArrowDown", { repeat: true });
    press("ArrowDown", { repeat: true });
    expect(document.activeElement).toBe(row("b3"));
    press("ArrowUp", { repeat: true });
    expect(document.activeElement).toBe(row("b2"));
  });

  test("holding j walks the rows", () => {
    serve({ main: result(three()) });
    render(<Keyboard context={ctxOf()} />);

    // The first press focuses the first row; the key held repeats from there
    // (Ruling R23), and k walks back the same way.
    press("j");
    expect(document.activeElement).toBe(row("b1"));
    const held = press("j", { repeat: true });
    expect(document.activeElement).toBe(row("b2"));
    expect(held.defaultPrevented).toBe(true);
    press("j", { repeat: true });
    expect(document.activeElement).toBe(row("b3"));
    press("k", { repeat: true });
    press("k", { repeat: true });
    expect(document.activeElement).toBe(row("b1"));
  });

  test("s starts reviewing and is disabled with the button", async () => {
    serve({ pending: 7 });
    fetchNext.mockResolvedValue({ target, scope: "nextBatch" });
    render(<Keyboard context={ctxOf("status=failed")} />);
    expect(startButton().getAttribute("aria-disabled")).toBeNull();

    // The button's own call: the project's first pending step, the status kept.
    const s = press("s");
    expect(s.defaultPrevented).toBe(true);
    await waitFor(() =>
      expect(routerMock.push).toHaveBeenCalledWith(
        "/projects/p1/runs/r1/checkpoints/c1?status=failed",
      ),
    );
    expect(fetchNext).toHaveBeenCalledTimes(1);
    expect(fetchNext).toHaveBeenCalledWith({ projectId: "p1" });
  });

  test("s follows the branch and the search like the button does", async () => {
    serve({
      pending: 7,
      filtered: result([build({ id: "b2" })]),
    });
    fetchList.mockResolvedValue({ items: [build({ id: "b2" })] });
    fetchNext.mockResolvedValue({
      target: { buildId: "b2", runId: "r2", checkpointId: "c2" },
      scope: "nextBatch",
    });
    render(<Keyboard context={ctxOf("branch=feature%2Fnew-nav")} />);

    press("s");
    await waitFor(() =>
      expect(routerMock.push).toHaveBeenCalledWith(
        "/projects/p1/runs/r2/checkpoints/c2",
      ),
    );
    expect(fetchNext).toHaveBeenCalledWith({
      projectId: "p1",
      at: { buildId: "b2" },
    });
  });

  test("s does nothing, and is left to the browser, while the button is disabled", async () => {
    // Nothing is pending.
    serve({ pending: 0 });
    const { unmount } = render(<Keyboard context={ctxOf()} />);
    expect(startButton().getAttribute("aria-disabled")).toBe("true");
    const none = press("s");
    expect(none.defaultPrevented).toBe(false);
    expect(fetchNext).not.toHaveBeenCalled();
    unmount();

    // The count is still loading.
    serve({ pending: null });
    const loading = render(<Keyboard context={ctxOf()} />);
    expect((startButton() as HTMLButtonElement).disabled).toBe(true);
    expect(press("s").defaultPrevented).toBe(false);
    expect(fetchNext).not.toHaveBeenCalled();
    loading.unmount();

    // It is already opening the first step.
    serve({ pending: 2 });
    let finish: (v: unknown) => void = () => undefined;
    fetchNext.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    render(<Keyboard context={ctxOf()} />);
    expect(press("s").defaultPrevented).toBe(true);
    expect(startButton().getAttribute("aria-disabled")).toBe("true");
    expect(press("s").defaultPrevented).toBe(false);
    expect(fetchNext).toHaveBeenCalledTimes(1);
    finish({ target, scope: "nextBatch" });
    await waitFor(() => expect(routerMock.push).toHaveBeenCalledTimes(1));
  });

  test("the Start reviewing button names its key, unless single-key shortcuts are off", () => {
    serve({ pending: 3 });
    render(<Keyboard context={ctxOf()} />);
    expect(startButton().getAttribute("aria-keyshortcuts")).toBe("S");
    expect(startButton().getAttribute("title")).toBe("Start reviewing (S)");

    // Off, `s` does nothing, so the button must not promise it.
    act(() => useSingleKeyStore.setState({ on: false }));
    expect(startButton().getAttribute("aria-keyshortcuts")).toBeNull();
    expect(startButton().getAttribute("title")).toBeNull();
    expect(press("s").defaultPrevented).toBe(false);
    expect(fetchNext).not.toHaveBeenCalled();
  });

  test("/ focuses search", () => {
    serve({ main: result(three()) });
    render(<Keyboard context={ctxOf()} />);

    const slash = press("/");
    expect(document.activeElement).toBe(searchBox());
    // Taken: the slash is not typed into the box.
    expect(slash.defaultPrevented).toBe(true);
    // The page's own search, not the palette the global one opens.
    expect(usePaletteStore.getState().open).toBe(false);

    // From a row too.
    press("Escape");
    focusOn(row("b2"));
    press("/");
    expect(document.activeElement).toBe(searchBox());
  });

  test("the sheet on Batches lists these commands", () => {
    serve({ main: result(three()) });
    render(<Keyboard context={ctxOf()} />);
    const sheet = openSheet();

    const section = within(sheet).getByRole("region", {
      name: "On this page (Batches)",
    });
    const rows = within(section)
      .getAllByRole("listitem")
      .map((li) => ({
        label: li.firstElementChild?.textContent,
        keys: keysOf(li),
      }));
    expect(rows).toEqual([
      { label: "Next row", keys: [["J"], ["↓"]] },
      { label: "Previous row", keys: [["K"], ["↑"]] },
      { label: "First row", keys: [["Home"]] },
      { label: "Last row", keys: [["End"]] },
      { label: "Open batch", keys: [["Enter"], ["O"]] },
      { label: "Start reviewing", keys: [["S"]] },
      { label: "Search batches", keys: [["/"]] },
    ]);

    // The global Search keeps no `/` there: the page's takes it.
    const everywhere = within(sheet).getByRole("region", {
      name: "Everywhere",
    });
    expect(within(everywhere).queryByText("Search")).toBeNull();
  });

  test("palette lists Show: Failed and it sets the chip", async () => {
    serve({ main: result(three()), pending: 3 });
    render(<Keyboard context={ctxOf()} />);
    const palette = await openPalette();

    // The page's own actions, with no cursor yet (so no Open batch).
    expect(actions(palette)).toEqual([
      "Next row",
      "Previous row",
      "First row",
      "Last row",
      "Start reviewing",
      "Search batches",
      "Show: Needs review",
      "Show: Failed",
      "Show: Running",
      "Show: Passed",
      "Show: All",
    ]);

    fireEvent.click(
      within(palette).getByRole("option", { name: "Show: Failed" }),
    );
    await settle();
    expect(routerMock.replace).toHaveBeenLastCalledWith(
      "/inbox?status=failed",
      {
        scroll: false,
      },
    );

    // And the others write their own chip's status.
    for (const [label, url] of [
      ["Show: Running", "/inbox?status=running"],
      ["Show: Passed", "/inbox?status=passed"],
      ["Show: All", "/inbox?status=all"],
      ["Show: Needs review", "/inbox"],
    ] as const) {
      const again = await openPalette();
      fireEvent.click(within(again).getByRole("option", { name: label }));
      await settle();
      expect(routerMock.replace).toHaveBeenLastCalledWith(url, {
        scroll: false,
      });
    }
  });

  test("palette: Open batch appears with a cursor row, and Search batches focuses the box after it closes", async () => {
    serve({ main: result(three()), pending: 3 });
    render(<Keyboard context={ctxOf("status=all")} />);

    press("j");
    const palette = await openPalette();
    expect(actions(palette)).toContain("Open batch");
    expect(
      within(palette)
        .getByRole("option", { name: "Open batch" })
        .getAttribute("aria-keyshortcuts"),
    ).toBe("Enter O");

    fireEvent.click(
      within(palette).getByRole("option", { name: "Search batches" }),
    );
    await settle();
    expect(document.activeElement).toBe(searchBox());

    // Open batch, picked from the palette, opens the cursor row.
    focusOn(row("b1"));
    const again = await openPalette();
    fireEvent.click(within(again).getByRole("option", { name: "Open batch" }));
    await settle();
    expect(routerMock.push).toHaveBeenCalledWith(
      "/projects/p1/builds/b1?status=all",
    );
  });

  test("palette leaves out the row commands with no rows, and Start reviewing while it is disabled", async () => {
    serve({ main: result([]), latest: result([build()]), pending: 0 });
    render(<Keyboard context={ctxOf("status=all")} />);
    const palette = await openPalette();
    expect(actions(palette)).toEqual([
      "Search batches",
      "Show: Needs review",
      "Show: Failed",
      "Show: Running",
      "Show: Passed",
      "Show: All",
    ]);
  });

  describe("while the next page loads", () => {
    const page = (items: unknown[], nextCursor: string | null) => ({
      ...result(items),
      data: { items, nextCursor },
    });

    /** On the first row, with Load more clicked: the table shows skeletons. */
    function loading() {
      serve({ main: page([build({ id: "b1" })], "cursor-2") });
      const view = render(<Keyboard context={ctxOf()} />);
      press("j");
      expect(document.activeElement).toBe(row("b1"));
      fireEvent.click(screen.getByRole("button", { name: "Load more" }));
      serve({ main: result([], { data: undefined, isLoading: true }) });
      view.rerender(<Keyboard context={ctxOf()} />);
      expect(screen.queryByTestId("inbox-batch-row-b1")).toBeNull();
      return view;
    }

    test("there is nothing to walk or open", () => {
      loading();
      expect(press("j").defaultPrevented).toBe(false);
      expect(press("k").defaultPrevented).toBe(false);
      expect(press("o").defaultPrevented).toBe(false);
      expect(routerMock.push).not.toHaveBeenCalled();
    });

    test("focus returns to the row it was on when the page is in", () => {
      const { rerender } = loading();
      serve({ main: page([build({ id: "b2", number: 41 })], null) });
      rerender(<Keyboard context={ctxOf()} />);
      expect(document.activeElement).toBe(row("b1"));
      press("j");
      expect(document.activeElement).toBe(row("b2"));
    });
  });

  test("typing s j k / a ? in the search or branch field triggers nothing", async () => {
    for (const [name, field] of [
      ["search", searchBox],
      ["branch", branchBox],
    ] as const) {
      const user = userEvent.setup();
      serve({ main: result(three()), pending: 7 });
      const { unmount } = render(<Keyboard context={ctxOf()} />);

      await user.click(field());
      expect(document.activeElement, name).toBe(field());
      await user.keyboard("sjk/a?");

      // All of it was typed, and none of it was a command.
      expect((field() as HTMLInputElement).value, name).toBe("sjk/a?");
      expect(document.activeElement, name).toBe(field());
      expect(fetchNext, name).not.toHaveBeenCalled();
      expect(routerMock.push, name).not.toHaveBeenCalled();
      expect(usePaletteStore.getState().open, name).toBe(false);
      expect(useShortcutsSheet.getState().open, name).toBe(false);
      expect(screen.queryByRole("dialog"), name).toBeNull();

      // Arrows, Home and End are the field's too.
      for (const key of ["ArrowDown", "ArrowUp", "Home", "End"]) {
        press(key);
        expect(document.activeElement, `${name} ${key}`).toBe(field());
      }
      unmount();
    }
  });

  test("a cursor left behind by a status change goes back to its row when the list returns", () => {
    serve({ main: result(three()) });
    const { rerender } = render(<Keyboard context={ctxOf()} />);
    press("j");
    press("j");
    expect(document.activeElement).toBe(row("b2"));

    // A new status: the rows give way to a loading state, then come back.
    serve({ main: result([], { data: undefined, isLoading: true }) });
    rerender(<Keyboard context={ctxOf("status=all")} />);
    expect(screen.queryByTestId("inbox-batch-row-b2")).toBeNull();
    serve({ main: result(three()) });
    rerender(<Keyboard context={ctxOf("status=all")} />);
    expect(document.activeElement).toBe(row("b2"));
  });
});
