import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const routerMock = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
const urlState = vi.hoisted(() => ({ search: "" }));
vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
  usePathname: () => "/projects/p1/builds/b1",
  useSearchParams: () => new URLSearchParams(urlState.search),
}));
vi.mock("@/hooks/useProjectEvents", () => ({
  useProjectEvents: () => undefined,
}));
// A stand-in for the filter: it shows the value it was given and has buttons
// that call `onChange` the way the real chips do.
vi.mock(
  "@/app/(protected)/projects/[projectId]/builds/_components/properties-filter",
  () => ({
    PropertiesFilter: ({
      value,
      onChange,
    }: {
      value: Record<string, string>;
      onChange: (next: Record<string, string>) => void;
    }) => (
      <div data-testid="filter" data-value={JSON.stringify(value)}>
        <button
          type="button"
          data-testid="filter-add-team"
          onClick={() => onChange({ ...value, team: "web" })}
        />
        <button
          type="button"
          data-testid="filter-clear"
          onClick={() => onChange({})}
        />
      </div>
    ),
  }),
);
const listMock = vi.fn();
vi.mock("@/lib/trpc", () => ({
  trpc: {
    builds: { list: { useQuery: (...a: unknown[]) => listMock(...a) } },
  },
}));

import { BuildsListPanel } from "@/app/(protected)/projects/[projectId]/builds/_components/builds-list-panel";

beforeEach(() => {
  urlState.search = "";
  routerMock.push.mockReset();
  routerMock.replace.mockReset();
  listMock.mockReset();
});
afterEach(cleanup);

/** The input of the most recent `builds.list` query. */
const lastInput = (): Record<string, unknown> => {
  const calls = listMock.mock.calls;
  return calls[calls.length - 1]?.[0] as Record<string, unknown>;
};

const item = {
  id: "b1",
  ciBuildId: "c",
  number: 42,
  branchName: "main",
  name: null,
  properties: {},
  runCount: 1,
  pendingCheckpoints: 3,
  unresolvedCount: 1,
  failedCount: 0,
  passedCount: 0,
  abortedCount: 0,
  aggregateStatus: "unresolved",
  createdAt: new Date().toISOString(),
};

describe("BuildsListPanel", () => {
  test("lists builds and marks the active one from the path", () => {
    listMock.mockReturnValue({
      data: { items: [item], nextCursor: null },
      isLoading: false,
      error: null,
    });
    render(<BuildsListPanel projectId="p1" />);
    const link = screen.getByTestId("build-list-item-b1");
    expect(link.getAttribute("aria-current")).toBe("page");
  });

  test("filter is collapsed by default and the filter icon toggles it open", () => {
    listMock.mockReturnValue({
      data: { items: [item], nextCursor: null },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });
    render(<BuildsListPanel projectId="p1" />);
    // Reference batch-history sidebar shows only the refresh + filter icons.
    expect(screen.queryByTestId("filter")).toBeNull();
    expect(screen.getByTestId("builds-refresh")).toBeDefined();
    fireEvent.click(screen.getByTestId("builds-filter-toggle"));
    expect(screen.getByTestId("filter")).toBeDefined();
  });

  test("the refresh icon refetches the builds list", () => {
    const refetch = vi.fn();
    listMock.mockReturnValue({
      data: { items: [item], nextCursor: null },
      isLoading: false,
      error: null,
      refetch,
    });
    render(<BuildsListPanel projectId="p1" />);
    fireEvent.click(screen.getByTestId("builds-refresh"));
    expect(refetch).toHaveBeenCalled();
  });

  test("shows the SDK onboarding empty state when there are no builds", () => {
    listMock.mockReturnValue({
      data: { items: [], nextCursor: null },
      isLoading: false,
      error: null,
    });
    render(<BuildsListPanel projectId="p1" />);
    expect(screen.getByText(/no builds yet/i)).toBeDefined();
    expect(
      screen.getByTestId("empty-builds-cta-token-link").getAttribute("href"),
    ).toBe("/account/tokens");
  });

  test("load-more appends the next page and dedupes overlapping ids", () => {
    const mk = (id: string) => ({ ...item, id });
    // Page 1: b1, b2 with a next cursor.
    listMock.mockReturnValue({
      data: { items: [mk("b1"), mk("b2")], nextCursor: "cur2" },
      isLoading: false,
      error: null,
    });
    render(<BuildsListPanel projectId="p1" />);
    expect(screen.getByTestId("build-list-item-b1")).toBeDefined();
    expect(screen.getByTestId("build-list-item-b2")).toBeDefined();

    // Page 2 (after Load more): b2 (duplicate) + b3, no further cursor.
    listMock.mockReturnValue({
      data: { items: [mk("b2"), mk("b3")], nextCursor: null },
      isLoading: false,
      error: null,
    });
    fireEvent.click(screen.getByRole("button", { name: /load more/i }));

    // All three present; the duplicate b2 appears exactly once.
    expect(screen.getByTestId("build-list-item-b1")).toBeDefined();
    expect(screen.getByTestId("build-list-item-b3")).toBeDefined();
    expect(screen.getAllByTestId("build-list-item-b2")).toHaveLength(1);
  });
  test("each build shows its pending count (hidden at 0)", () => {
    const mk = (id: string, pendingCheckpoints: number) => ({
      ...item,
      id,
      pendingCheckpoints,
    });
    listMock.mockReturnValue({
      data: { items: [mk("b1", 3), mk("b2", 0)], nextCursor: null },
      isLoading: false,
      error: null,
    });
    render(<BuildsListPanel projectId="p1" />);
    expect(screen.getByTestId("build-list-item-pending-b1").textContent).toBe(
      "3 pending",
    );
    expect(screen.queryByTestId("build-list-item-pending-b2")).toBeNull();
  });

  test("properties filter round-trips through ?props", () => {
    listMock.mockReturnValue({
      data: { items: [item], nextCursor: null },
      isLoading: false,
      error: null,
    });
    // A reload with ?props: the filter is open, shows the value, and the list
    // is asked for it.
    urlState.search = "expand=b9&props=env%3Astaging";
    const { rerender } = render(<BuildsListPanel projectId="p1" />);
    expect(
      JSON.parse(screen.getByTestId("filter").getAttribute("data-value")!),
    ).toEqual({ env: "staging" });
    expect(lastInput().properties).toEqual({ env: "staging" });

    // Adding a property writes the URL (sorted, other params left alone) and
    // does not push history.
    fireEvent.click(screen.getByTestId("filter-add-team"));
    expect(routerMock.replace).toHaveBeenLastCalledWith(
      "/projects/p1/builds/b1?expand=b9&props=env%3Astaging%2Cteam%3Aweb",
      { scroll: false },
    );
    expect(routerMock.push).not.toHaveBeenCalled();

    // The URL comes back: the query follows it.
    urlState.search = "expand=b9&props=env%3Astaging%2Cteam%3Aweb";
    rerender(<BuildsListPanel projectId="p1" />);
    expect(lastInput().properties).toEqual({ env: "staging", team: "web" });

    // Clearing drops the param and the query's filter.
    fireEvent.click(screen.getByTestId("filter-clear"));
    expect(routerMock.replace).toHaveBeenLastCalledWith(
      "/projects/p1/builds/b1?expand=b9",
      { scroll: false },
    );
    urlState.search = "expand=b9";
    rerender(<BuildsListPanel projectId="p1" />);
    expect(lastInput().properties).toBeUndefined();
  });

  test("no ?props means no filter: the query is unfiltered and the filter stays closed", () => {
    listMock.mockReturnValue({
      data: { items: [item], nextCursor: null },
      isLoading: false,
      error: null,
    });
    render(<BuildsListPanel projectId="p1" />);
    expect(lastInput().properties).toBeUndefined();
    expect(screen.queryByTestId("filter")).toBeNull();
  });

  test("a bad ?props is dropped, not an error", () => {
    listMock.mockReturnValue({
      data: { items: [item], nextCursor: null },
      isLoading: false,
      error: null,
    });
    urlState.search = "props=%E0%A4%A,nocolon,%3Aempty";
    render(<BuildsListPanel projectId="p1" />);
    expect(lastInput().properties).toBeUndefined();
    expect(screen.getByTestId("build-list-item-b1")).toBeDefined();
  });

  test("changing the filter starts the pages over, even through Back", () => {
    const mk = (id: string) => ({ ...item, id });
    listMock.mockReturnValue({
      data: { items: [mk("b1"), mk("b2")], nextCursor: "cur2" },
      isLoading: false,
      error: null,
    });
    const { rerender } = render(<BuildsListPanel projectId="p1" />);
    expect(lastInput().cursor).toBeUndefined();

    // Load more: page 2 is asked for and page 1 is kept.
    listMock.mockReturnValue({
      data: { items: [mk("b3")], nextCursor: null },
      isLoading: false,
      error: null,
    });
    fireEvent.click(screen.getByRole("button", { name: /load more/i }));
    expect(lastInput().cursor).toBe("cur2");
    expect(screen.getByTestId("build-list-item-b1")).toBeDefined();
    expect(screen.getByTestId("build-list-item-b3")).toBeDefined();

    // The URL's filter changes from outside the panel (Back / Forward): the
    // loaded pages are dropped and the list starts from the first page.
    listMock.mockReturnValue({
      data: { items: [mk("b7")], nextCursor: null },
      isLoading: false,
      error: null,
    });
    const before = listMock.mock.calls.length;
    urlState.search = "props=env%3Astaging";
    rerender(<BuildsListPanel projectId="p1" />);
    // No query asked after the change, not only the last, carries the old
    // filter's cursor (it would page the new filter from the old one's place).
    const after = listMock.mock.calls.slice(before);
    expect(after.length).toBeGreaterThan(0);
    for (const [input] of after) {
      expect((input as { cursor?: string }).cursor).toBeUndefined();
    }
    expect(lastInput().cursor).toBeUndefined();
    expect(lastInput().properties).toEqual({ env: "staging" });
    expect(screen.getByTestId("build-list-item-b7")).toBeDefined();
    expect(screen.queryByTestId("build-list-item-b1")).toBeNull();
    expect(screen.queryByTestId("build-list-item-b3")).toBeNull();
  });

  test("Load more is held back while the previous filter's page is still showing", () => {
    const mk = (id: string) => ({ ...item, id });
    listMock.mockReturnValue({
      data: { items: [mk("b1")], nextCursor: "cur-old" },
      isLoading: false,
      isPlaceholderData: false,
      error: null,
    });
    const { rerender } = render(<BuildsListPanel projectId="p1" />);

    // The filter changes, and the query keeps the previous filter's data in
    // view until the new one answers. Its cursor belongs to the old filter.
    urlState.search = "props=env%3Astaging";
    listMock.mockReturnValue({
      data: { items: [mk("b1")], nextCursor: "cur-old" },
      isLoading: false,
      isPlaceholderData: true,
      error: null,
    });
    rerender(<BuildsListPanel projectId="p1" />);
    const button = screen.getByRole("button", {
      name: /load more/i,
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    const before = listMock.mock.calls.length;
    fireEvent.click(button);
    // Nothing was appended, and no query was asked for the old cursor.
    const asked = listMock.mock.calls.slice(before);
    for (const [input] of asked) {
      expect((input as { cursor?: string }).cursor).toBeUndefined();
    }

    // The new filter has answered: Load more works, with the new cursor.
    listMock.mockReturnValue({
      data: { items: [mk("b7")], nextCursor: "cur-new" },
      isLoading: false,
      isPlaceholderData: false,
      error: null,
    });
    rerender(<BuildsListPanel projectId="p1" />);
    const ready = screen.getByRole("button", {
      name: /load more/i,
    }) as HTMLButtonElement;
    expect(ready.disabled).toBe(false);
    fireEvent.click(ready);
    expect(lastInput().cursor).toBe("cur-new");
  });

  test("build links keep the review context", () => {
    listMock.mockReturnValue({
      data: { items: [item, { ...item, id: "b2" }], nextCursor: null },
      isLoading: false,
      error: null,
    });
    // The panel sits beside every build page, so the context in its URL is the
    // one the batch page shows. Branch and search are Batches-only.
    urlState.search =
      "status=failed&browser=firefox&branch=release%2F2&q=nav&props=env%3Astaging";
    render(<BuildsListPanel projectId="p1" />);
    const expected = (id: string) =>
      `/projects/p1/builds/${id}?status=failed&browser=firefox&props=env%3Astaging`;
    expect(screen.getByTestId("build-list-item-b1").getAttribute("href")).toBe(
      expected("b1"),
    );
    expect(screen.getByTestId("build-list-item-b2").getAttribute("href")).toBe(
      expected("b2"),
    );
  });

  test("build links are bare when the context is the default", () => {
    listMock.mockReturnValue({
      data: { items: [item], nextCursor: null },
      isLoading: false,
      error: null,
    });
    render(<BuildsListPanel projectId="p1" />);
    expect(screen.getByTestId("build-list-item-b1").getAttribute("href")).toBe(
      "/projects/p1/builds/b1",
    );
  });
});
