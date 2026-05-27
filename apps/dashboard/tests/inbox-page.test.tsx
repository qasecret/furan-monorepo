import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/useInboxRealtime", () => ({
  useInboxRealtime: () => undefined,
}));

const listMock = vi.fn();
const approveMock = vi.fn();
const rejectMock = vi.fn();
vi.mock("@/lib/trpc", () => ({
  trpc: {
    inbox: {
      list: { useQuery: (...args: unknown[]) => listMock(...args) },
      count: { useQuery: () => ({ data: { total: 1 } }) },
      approve: {
        useMutation: () => ({ mutate: approveMock, isPending: false }),
      },
      reject: { useMutation: () => ({ mutate: rejectMock, isPending: false }) },
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
});
