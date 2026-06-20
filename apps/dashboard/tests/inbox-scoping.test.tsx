import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

const listMock = vi.fn().mockReturnValue({
  data: { items: [], nextCursor: null },
  isLoading: false,
  isError: false,
  refetch: vi.fn(),
});

vi.mock("@/lib/trpc", () => ({
  trpc: {
    inbox: {
      list: { useQuery: (...a: unknown[]) => listMock(...a) },
      approve: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      reject: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      rejectCluster: {
        useMutation: () => ({ mutate: vi.fn(), isPending: false }),
      },
    },
  },
}));

vi.mock("@/app/(protected)/_components/current-project-provider", () => ({
  useCurrentProject: () => ({
    currentProjectId: "p1",
    currentProject: { id: "p1", name: "P1" },
    projects: [{ id: "p1", name: "P1" }],
    setCurrentProject: vi.fn(),
  }),
}));

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

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import { InboxPage } from "@/app/(protected)/inbox/_components/inbox-page";

afterEach(cleanup);

test("inbox.list is scoped to the current project", () => {
  render(
    <InboxPage
      initialStatus="all-open"
      initialWindow="7d"
      initialGroup={false}
    />,
  );
  expect(listMock).toHaveBeenCalledWith(
    expect.objectContaining({ projectIds: ["p1"] }),
    expect.anything(),
  );
});

test("no-project guard is not shown when a project is selected", () => {
  const { queryByTestId } = render(
    <InboxPage
      initialStatus="all-open"
      initialWindow="7d"
      initialGroup={false}
    />,
  );
  // With currentProjectId = "p1", the no-project guard must NOT be rendered
  expect(queryByTestId("inbox-no-project")).toBeNull();
});
