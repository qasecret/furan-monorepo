/**
 * Island-level tests for the /projects/[projectId]/runs index surface.
 * Mocks the dashboard's typed tRPC client so we can drive the table
 * without spinning up a real server.
 *
 * Spec D5 acceptance: <RunsTable> renders rows, FiltersBar changes the
 * trpc input, and "Load more" pushes the previous response's cursor into
 * the next useQuery call.
 *
 * Spec §3.5 acceptance (multi-select status filter): the dropdown
 * commits 0 / 1 / 2+ statuses to the API as `undefined`, `["..."]`, or
 * `["..", ".."]`; URL round-trip uses repeated `?status=` params.
 */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// The RunsTable subscribes to the project SSE channel via useProjectEvents
// for live invalidation. Mock it out — these tests don't render under a
// QueryClientProvider, and the hook's behavior has its own dedicated test
// file (useProjectEvents.test.tsx).
vi.mock("@/hooks/useProjectEvents", () => ({
  useProjectEvents: () => undefined,
}));

// next/navigation hooks used by FiltersBar to sync filter state into the URL.
const replaceMock = vi.fn();
let mockSearchParams: URLSearchParams = new URLSearchParams();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock, push: vi.fn() }),
  useSearchParams: () => mockSearchParams,
}));

const listMock = vi.fn();

interface RunRow {
  id: string;
  projectId: string;
  branchName: string;
  status: string;
  diffPercent: number | null;
  pixelMisMatchCount: number | null;
  baselineSource: string | null;
  createdAt: Date;
  testVariationId: string;
  buildId: string;
  name: string;
}

const RUNS_PAGE_1: RunRow[] = [
  {
    id: "r1",
    projectId: "p1",
    branchName: "main",
    status: "passed",
    diffPercent: 0.5,
    pixelMisMatchCount: 100,
    baselineSource: "branch",
    createdAt: new Date("2026-05-16T12:00:00Z"),
    testVariationId: "v1",
    buildId: "b1",
    name: "r1",
  },
  {
    id: "r2",
    projectId: "p1",
    branchName: "feature/x",
    status: "failed",
    diffPercent: 5.2,
    pixelMisMatchCount: 5000,
    baselineSource: null,
    createdAt: new Date("2026-05-15T12:00:00Z"),
    testVariationId: "v1",
    buildId: "b1",
    name: "r2",
  },
];

// Per-test override: tests can replace this to return a different
// useQuery payload (e.g., zero-items case) without re-mocking.
let listUseQueryImpl: (input: {
  projectId: string;
  cursor?: string;
  limit?: number;
  branch?: string;
  status?: string[];
}) => {
  data: { items: RunRow[]; nextCursor: string | null };
  isLoading: boolean;
  error: null;
} = (input) => {
  listMock(input);
  return {
    data: {
      items: RUNS_PAGE_1,
      nextCursor: "2026-05-15T00:00:00.000Z",
    },
    isLoading: false,
    error: null,
  };
};

vi.mock("@/lib/trpc", () => ({
  trpc: {
    runs: {
      list: {
        useQuery: (input: {
          projectId: string;
          cursor?: string;
          limit?: number;
          branch?: string;
          status?: string[];
        }) => listUseQueryImpl(input),
      },
    },
  },
}));

import { FiltersBar } from "../src/app/(protected)/projects/[projectId]/runs/_components/filters-bar";
import { RunsTable } from "../src/app/(protected)/projects/[projectId]/runs/_components/runs-table";

const PROJECT_ID = "33333333-3333-4333-8333-333333333333";

beforeEach(() => {
  listMock.mockReset();
  replaceMock.mockReset();
  mockSearchParams = new URLSearchParams();
});

afterEach(() => {
  cleanup();
});

describe("RunsTable", () => {
  test("renders the runs returned by trpc.runs.list.useQuery", () => {
    render(<RunsTable projectId={PROJECT_ID} />);
    expect(screen.getByTestId("runs-table")).toBeDefined();
    expect(screen.getByTestId("run-row-r1")).toBeDefined();
    expect(screen.getByTestId("run-row-r2")).toBeDefined();
    expect(screen.getByText("main")).toBeDefined();
    expect(screen.getByText("feature/x")).toBeDefined();
    // RunStatusBadge renders the title-cased label + a status-keyed
    // testid; assert both to lock in the badge wiring.
    expect(screen.getByTestId("run-status-badge-passed")).toBeDefined();
    expect(screen.getByTestId("run-status-badge-failed")).toBeDefined();
    expect(screen.getByText("Passed")).toBeDefined();
    expect(screen.getByText("Failed")).toBeDefined();
  });

  test("branch filter input updates the query input passed to useQuery", async () => {
    render(<RunsTable projectId={PROJECT_ID} />);
    // Initial call should have undefined branch.
    expect(listMock).toHaveBeenCalled();
    const firstCall = listMock.mock.calls[0]?.[0] as { branch?: string };
    expect(firstCall.branch).toBeUndefined();

    const branchInput = screen.getByTestId("branch-filter-input");
    fireEvent.input(branchInput, { target: { value: "release/9" } });

    // FiltersBar debounces by 300ms; waitFor handles the deferred re-render.
    await waitFor(
      () => {
        const lastCall = listMock.mock.calls.at(-1)?.[0] as {
          branch?: string;
        };
        expect(lastCall.branch).toBe("release/9");
      },
      { timeout: 1000 },
    );
  });

  test("Load more button calls useQuery with the previous response's nextCursor", async () => {
    render(<RunsTable projectId={PROJECT_ID} />);

    const loadMore = await screen.findByTestId("load-more-button");
    fireEvent.click(loadMore);

    await waitFor(() => {
      const lastCall = listMock.mock.calls.at(-1)?.[0] as { cursor?: string };
      expect(lastCall.cursor).toBe("2026-05-15T00:00:00.000Z");
    });
  });

  test("renders history chip when testVariationId present on run", () => {
    render(<RunsTable projectId={PROJECT_ID} />);
    const chip = screen.getByTestId("run-history-chip-r1");
    expect(chip.getAttribute("href")).toBe(
      `/projects/${PROJECT_ID}/variations/v1`,
    );
  });
});

describe("RunsTable empty-state branches", () => {
  // Override the list mock to return zero items for these tests.
  const emptyImpl = () => ({
    data: { items: [] as RunRow[], nextCursor: null },
    isLoading: false,
    error: null,
  });

  beforeEach(() => {
    listUseQueryImpl = emptyImpl;
  });

  afterEach(() => {
    // Restore default impl for downstream tests.
    listUseQueryImpl = (input) => {
      listMock(input);
      return {
        data: {
          items: RUNS_PAGE_1,
          nextCursor: "2026-05-15T00:00:00.000Z",
        },
        isLoading: false,
        error: null,
      };
    };
  });

  test("renders EmptyRunsCta when zero items and no filter active", () => {
    render(<RunsTable projectId={PROJECT_ID} />);
    expect(screen.getByTestId("empty-runs-cta")).toBeDefined();
    expect(screen.queryByText(/No runs match\./)).toBeNull();
  });

  test("renders 'No runs match.' when zero items and a filter IS active", () => {
    render(<RunsTable projectId={PROJECT_ID} initialBranch="feature/x" />);
    expect(screen.getByText(/No runs match\./)).toBeDefined();
    expect(screen.queryByTestId("empty-runs-cta")).toBeNull();
  });
});

/**
 * FiltersBar multi-select coverage — spec §3.5. Goes through the
 * component directly (rather than through <RunsTable>) so we can assert
 * on the onChange payload shape without coupling to RunsTable's
 * normalisation step.
 */
describe("FiltersBar multi-select status", () => {
  // Radix DropdownMenu trigger fires on pointerdown, not `click`, so a
  // synthetic `fireEvent.click` on the trigger doesn't open the menu in
  // jsdom. Drive the trigger with the keyboard path instead — pressing
  // Enter on a focused trigger opens the menu. Same approach as the
  // ApprovalBar override-menu tests.
  const openStatusMenu = async () => {
    const trigger = screen.getByTestId(
      "status-filter-trigger",
    ) as HTMLButtonElement;
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter", code: "Enter" });
    // Allow Radix to flush its portal mount.
    await new Promise((r) => setTimeout(r, 0));
  };

  test("0 checked → onChange receives status: undefined and summary is 'All statuses'", async () => {
    const onChange = vi.fn();
    render(<FiltersBar onChange={onChange} />);
    const trigger = screen.getByTestId("status-filter-trigger");
    expect(trigger.textContent).toContain("All statuses");
    // Without any change the debounced effect doesn't fire (firstRun guard).
    await new Promise((r) => setTimeout(r, 350));
    expect(onChange).not.toHaveBeenCalled();
  });

  test("1 checked → API receives status: ['unresolved']", async () => {
    const onChange = vi.fn();
    render(<FiltersBar onChange={onChange} />);
    await openStatusMenu();
    const opt = await screen.findByTestId("status-filter-option-unresolved");
    fireEvent.click(opt);

    await waitFor(
      () => {
        const last = onChange.mock.calls.at(-1)?.[0] as {
          status?: string[];
        };
        expect(last?.status).toEqual(["unresolved"]);
      },
      { timeout: 1000 },
    );
    expect(screen.getByTestId("status-filter-trigger").textContent).toContain(
      "Unresolved",
    );
  });

  test("2 checked → API receives status: ['unresolved', 'failed']", async () => {
    const onChange = vi.fn();
    render(<FiltersBar onChange={onChange} />);
    await openStatusMenu();
    fireEvent.click(
      await screen.findByTestId("status-filter-option-unresolved"),
    );
    fireEvent.click(await screen.findByTestId("status-filter-option-failed"));

    await waitFor(
      () => {
        const last = onChange.mock.calls.at(-1)?.[0] as {
          status?: string[];
        };
        // STATUS_OPTIONS order is unresolved-first, then failed.
        expect(last?.status).toEqual(["unresolved", "failed"]);
      },
      { timeout: 1000 },
    );
    expect(screen.getByTestId("status-filter-trigger").textContent).toContain(
      "Unresolved + Failed",
    );
  });

  test("3+ checked → trigger summarises as 'N statuses'", async () => {
    const onChange = vi.fn();
    render(<FiltersBar onChange={onChange} />);
    await openStatusMenu();
    fireEvent.click(
      await screen.findByTestId("status-filter-option-unresolved"),
    );
    fireEvent.click(await screen.findByTestId("status-filter-option-failed"));
    fireEvent.click(await screen.findByTestId("status-filter-option-aborted"));

    await waitFor(
      () => {
        expect(
          screen.getByTestId("status-filter-trigger").textContent,
        ).toContain("3 statuses");
      },
      { timeout: 1000 },
    );
  });

  test("toggling a checked status off restores 'All statuses' when none remain", async () => {
    const onChange = vi.fn();
    render(<FiltersBar onChange={onChange} />);
    await openStatusMenu();
    const opt = await screen.findByTestId("status-filter-option-unresolved");
    fireEvent.click(opt); // on
    fireEvent.click(opt); // off

    await waitFor(
      () => {
        const last = onChange.mock.calls.at(-1)?.[0] as {
          status?: string[];
        };
        expect(last?.status).toBeUndefined();
      },
      { timeout: 1000 },
    );
    expect(screen.getByTestId("status-filter-trigger").textContent).toContain(
      "All statuses",
    );
  });

  test("URL round-trip: writes repeated ?status= params and hydrates from them", async () => {
    // Phase 1 — toggle two statuses on, assert the replace() URL has both.
    const onChange = vi.fn();
    render(<FiltersBar onChange={onChange} />);
    await openStatusMenu();
    fireEvent.click(
      await screen.findByTestId("status-filter-option-unresolved"),
    );
    fireEvent.click(await screen.findByTestId("status-filter-option-failed"));

    await waitFor(
      () => {
        const lastCall = replaceMock.mock.calls.at(-1)?.[0] as string;
        const sp = new URLSearchParams(lastCall.replace(/^\?/, ""));
        expect(sp.getAll("status")).toEqual(["unresolved", "failed"]);
      },
      { timeout: 1000 },
    );

    cleanup();

    // Phase 2 — simulate reload by mounting fresh with the URL we just wrote
    // as both initial props and useSearchParams() backing store. Trigger
    // summary should hydrate to "Unresolved + Failed" with no user input.
    mockSearchParams = new URLSearchParams("status=unresolved&status=failed");
    const onChange2 = vi.fn();
    render(
      <FiltersBar
        initialStatus={["unresolved", "failed"]}
        onChange={onChange2}
      />,
    );
    expect(screen.getByTestId("status-filter-trigger").textContent).toContain(
      "Unresolved + Failed",
    );
  });
});
