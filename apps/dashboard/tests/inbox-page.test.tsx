import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/InboxRealtime", () => ({
  InboxRealtime: () => null,
}));
vi.mock("@/lib/telemetry", () => ({
  recordTelemetry: vi.fn(),
}));
vi.mock("@/app/(protected)/inbox/_components/inbox-preview-pane", () => ({
  InboxPreviewPane: ({ run }: { run?: { runId: string } }) => (
    <div data-testid="inbox-preview-stub" data-run={run?.runId ?? ""} />
  ),
}));

const listMock = vi.fn();
const approveMock = vi.fn();
const rejectMock = vi.fn();
const rejectClusterMutate = vi.fn();
vi.mock("@/lib/trpc", () => ({
  trpc: {
    inbox: {
      list: { useQuery: (...args: unknown[]) => listMock(...args) },
      count: { useQuery: () => ({ data: { total: 1 } }) },
      approve: {
        useMutation: () => ({ mutate: approveMock, isPending: false }),
      },
      reject: { useMutation: () => ({ mutate: rejectMock, isPending: false }) },
      rejectCluster: {
        useMutation: () => ({ mutate: rejectClusterMutate, isPending: false }),
      },
    },
    projects: { list: { useQuery: () => ({ data: [] }) } },
  },
}));

const replaceMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock, push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import { InboxPage } from "@/app/(protected)/inbox/_components/inbox-page";

afterEach(cleanup);

describe("InboxPage", () => {
  test("renders rows from inbox.list", async () => {
    listMock.mockReturnValue({
      data: {
        items: [
          {
            runId: "11111111-1111-1111-1111-111111111111",
            projectId: "22222222-2222-2222-2222-222222222222",
            projectName: "demo",
            variationName: "checkout",
            buildNumber: 1,
            buildId: "33333333-3333-3333-3333-333333333333",
            branch: "main",
            status: "unresolved",
            createdAt: new Date().toISOString(),
            thumbnailUrl: null,
          },
        ],
        nextCursor: null,
      },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    render(
      <InboxPage
        initialStatus="all-open"
        initialWindow="7d"
        initialGroup={false}
      />,
    );
    await waitFor(() => expect(screen.getByText("checkout")).toBeDefined());
  });

  test("renders empty state when items=[]", async () => {
    listMock.mockReturnValue({
      data: { items: [], nextCursor: null },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    render(
      <InboxPage
        initialStatus="all-open"
        initialWindow="7d"
        initialGroup={false}
      />,
    );
    await waitFor(() => expect(screen.getByText(/All clear/i)).toBeDefined());
  });

  test("passes group:'similarity' when initialGroup=true, undefined when false", async () => {
    listMock.mockReturnValue({
      data: { items: [], nextCursor: null },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });

    // initialGroup=true → group should be "similarity"
    listMock.mockClear();
    render(
      <InboxPage
        initialStatus="all-open"
        initialWindow="7d"
        initialGroup={true}
      />,
    );
    expect(listMock).toHaveBeenCalledWith(
      expect.objectContaining({ group: "similarity" }),
    );

    cleanup();
    listMock.mockClear();

    // initialGroup=false → group should be undefined
    render(
      <InboxPage
        initialStatus="all-open"
        initialWindow="7d"
        initialGroup={false}
      />,
    );
    expect(listMock).toHaveBeenCalledWith(
      expect.objectContaining({ group: undefined }),
    );
  });

  test("grouped: renders cluster header + member rows; Reject all → confirm calls rejectCluster.mutate with correct filter", async () => {
    const refetch = vi.fn();
    listMock.mockReturnValue({
      data: {
        items: [
          // Two rows forming a cluster (same projectId + primarySignature + clusterRunCount > 1)
          {
            runId: "aaaa0001-0000-0000-0000-000000000000",
            projectId: "proj-0001-0000-0000-0000-000000000000",
            projectName: "MyProject",
            variationName: "Checkout step",
            buildNumber: 2,
            buildId: "bbbb0001-0000-0000-0000-000000000001",
            branch: "main",
            status: "unresolved",
            createdAt: new Date().toISOString(),
            thumbnailUrl: null,
            primarySignature: "v1:abc",
            clusterRunCount: 2,
            clusterBuildCount: 2,
          },
          {
            runId: "aaaa0002-0000-0000-0000-000000000000",
            projectId: "proj-0001-0000-0000-0000-000000000000",
            projectName: "MyProject",
            variationName: "Search step",
            buildNumber: 3,
            buildId: "bbbb0002-0000-0000-0000-000000000002",
            branch: "main",
            status: "unresolved",
            createdAt: new Date().toISOString(),
            thumbnailUrl: null,
            primarySignature: "v1:abc",
            clusterRunCount: 2,
            clusterBuildCount: 2,
          },
          // A singleton
          {
            runId: "bbbb0001-0000-0000-0000-000000000000",
            projectId: "proj-0001-0000-0000-0000-000000000000",
            projectName: "MyProject",
            variationName: "Homepage",
            buildNumber: 4,
            buildId: "bbbb0003-0000-0000-0000-000000000003",
            branch: "main",
            status: "unresolved",
            createdAt: new Date().toISOString(),
            thumbnailUrl: null,
            primarySignature: null,
            clusterRunCount: 1,
            clusterBuildCount: 1,
          },
        ],
        nextCursor: null,
      },
      isLoading: false,
      isError: false,
      refetch,
    });

    rejectClusterMutate.mockClear();

    render(
      <InboxPage
        initialStatus="all-open"
        initialWindow="7d"
        initialGroup={true}
      />,
    );

    // The cluster header should be visible
    await waitFor(() =>
      expect(screen.getByTestId("cluster-header-v1:abc")).toBeTruthy(),
    );

    // Both cluster member rows should render
    expect(
      screen.getByTestId("queue-row-aaaa0001-0000-0000-0000-000000000000"),
    ).toBeTruthy();
    expect(
      screen.getByTestId("queue-row-aaaa0002-0000-0000-0000-000000000000"),
    ).toBeTruthy();

    // The singleton row should also render
    expect(
      screen.getByTestId("queue-row-bbbb0001-0000-0000-0000-000000000000"),
    ).toBeTruthy();

    // Click "Reject all" on the cluster header
    fireEvent.click(screen.getByTestId("cluster-reject-all-v1:abc"));

    // The confirm dialog should now be open
    await waitFor(() =>
      expect(screen.getByTestId("reject-cluster-dialog")).toBeTruthy(),
    );

    // Click confirm
    fireEvent.click(screen.getByTestId("reject-cluster-confirm"));

    // rejectCluster.mutate should be called with the exact filter (WYSIWYG contract)
    expect(rejectClusterMutate).toHaveBeenCalledWith({
      projectId: "proj-0001-0000-0000-0000-000000000000",
      signature: "v1:abc",
      status: "all-open",
      window: "7d",
    });
  });

  test("suppresses a/r row shortcuts while the reject-cluster dialog is open", async () => {
    const mk = (runId: string, variationName: string) => ({
      runId,
      projectId: "proj-0001-0000-0000-0000-000000000000",
      projectName: "MyProject",
      variationName,
      buildNumber: 2,
      buildId: "cccc0001-0000-0000-0000-000000000001",
      branch: "main",
      status: "unresolved" as const,
      createdAt: new Date().toISOString(),
      thumbnailUrl: null,
      primarySignature: "v1:abc",
      clusterRunCount: 2,
      clusterBuildCount: 2,
    });
    listMock.mockReturnValue({
      data: {
        items: [
          mk("aaaa0001-0000-0000-0000-000000000000", "Checkout step"),
          mk("aaaa0002-0000-0000-0000-000000000000", "Search step"),
        ],
        nextCursor: null,
      },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    approveMock.mockClear();
    rejectMock.mockClear();

    render(
      <InboxPage
        initialStatus="all-open"
        initialWindow="7d"
        initialGroup={true}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("cluster-header-v1:abc")).toBeTruthy(),
    );

    // Dialog CLOSED: 'a' fires a single-run approve on the selected (first) row.
    fireEvent.keyDown(document, { key: "a" });
    expect(approveMock).toHaveBeenCalledTimes(1);
    approveMock.mockClear();

    // Open the reject-cluster dialog, then press a/r — they must NOT fire a
    // single-run mutation on the row behind the modal (the keyboard-leak bug).
    fireEvent.click(screen.getByTestId("cluster-reject-all-v1:abc"));
    await waitFor(() =>
      expect(screen.getByTestId("reject-cluster-dialog")).toBeTruthy(),
    );
    fireEvent.keyDown(document, { key: "a" });
    fireEvent.keyDown(document, { key: "r" });
    expect(approveMock).not.toHaveBeenCalled();
    expect(rejectMock).not.toHaveBeenCalled();
  });

  const rowA = {
    runId: "aaaaaaaa-0000-0000-0000-000000000000",
    projectId: "22222222-2222-2222-2222-222222222222",
    projectName: "demo",
    variationName: "alpha",
    buildNumber: 1,
    buildId: "33333333-3333-3333-3333-333333333333",
    branch: "main",
    status: "unresolved" as const,
    createdAt: new Date().toISOString(),
    thumbnailUrl: null,
  };
  const rowB = {
    ...rowA,
    runId: "bbbbbbbb-0000-0000-0000-000000000000",
    variationName: "beta",
  };

  test("preview reflects the selected run (defaults to the first)", async () => {
    listMock.mockReturnValue({
      data: { items: [rowA, rowB], nextCursor: null },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    render(
      <InboxPage
        initialStatus="all-open"
        initialWindow="7d"
        initialGroup={false}
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByTestId("inbox-preview-stub").getAttribute("data-run"),
      ).toBe(rowA.runId),
    );
  });

  test("clicking a queue row updates the selection and preview", async () => {
    listMock.mockReturnValue({
      data: { items: [rowA, rowB], nextCursor: null },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    render(
      <InboxPage
        initialStatus="all-open"
        initialWindow="7d"
        initialGroup={false}
      />,
    );
    fireEvent.click(screen.getByTestId(`queue-row-${rowB.runId}`));
    await waitFor(() =>
      expect(
        screen.getByTestId("inbox-preview-stub").getAttribute("data-run"),
      ).toBe(rowB.runId),
    );
  });

  test("shows skeleton placeholders while the queue is loading", () => {
    listMock.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      refetch: vi.fn(),
    });
    const { container } = render(
      <InboxPage
        initialStatus="all-open"
        initialWindow="7d"
        initialGroup={false}
      />,
    );
    const busy = container.querySelector('[aria-busy="true"]');
    expect(busy).not.toBeNull();
    expect(
      busy?.querySelectorAll(".animate-pulse").length ?? 0,
    ).toBeGreaterThan(0);
  });

  test("pressing j moves the selection and updates the preview", async () => {
    listMock.mockReturnValue({
      data: { items: [rowA, rowB], nextCursor: null },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    render(
      <InboxPage
        initialStatus="all-open"
        initialWindow="7d"
        initialGroup={false}
      />,
    );
    fireEvent.keyDown(document, { key: "j" });
    await waitFor(() =>
      expect(
        screen.getByTestId("inbox-preview-stub").getAttribute("data-run"),
      ).toBe(rowB.runId),
    );
  });
});
