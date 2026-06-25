import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("@/lib/api-client", () => ({
  apiGet: vi.fn(async () => ({ status: 200, data: [] })),
}));
vi.mock("@/lib/get-project", () => ({
  getProject: vi.fn(async () => ({
    status: 200,
    data: { id: "p1", name: "Acme" },
  })),
}));
vi.mock(
  "@/app/(protected)/projects/[projectId]/builds/_components/builds-list-panel",
  () => ({ BuildsListPanel: () => <div data-testid="panel" /> }),
);

const replaceMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock }),
}));
const listMock = vi.fn();
vi.mock("@/lib/trpc", () => ({
  trpc: { builds: { list: { useQuery: () => listMock() } } },
}));

import BuildsLayout from "@/app/(protected)/projects/[projectId]/builds/layout";
import BuildsIndexPage from "@/app/(protected)/projects/[projectId]/builds/page";

afterEach(() => {
  cleanup();
  replaceMock.mockReset();
});

describe("Builds layout + index", () => {
  test("layout renders the panel beside its children", async () => {
    const ui = await BuildsLayout({
      children: <div data-testid="content" />,
      params: Promise.resolve({ projectId: "p1" }),
    });
    render(ui);
    expect(screen.getByTestId("panel")).toBeDefined();
    expect(screen.getByTestId("content")).toBeDefined();
  });

  test("index redirects to the latest build's review", async () => {
    listMock.mockReturnValue({
      data: { items: [{ id: "b9" }], nextCursor: null },
      isLoading: false,
      error: null,
    });
    render(
      await BuildsIndexPage({ params: Promise.resolve({ projectId: "p1" }) }),
    );
    expect(replaceMock).toHaveBeenCalledWith("/projects/p1/builds/b9");
  });

  test("index shows an empty state when there are no builds", async () => {
    listMock.mockReturnValue({
      data: { items: [], nextCursor: null },
      isLoading: false,
      error: null,
    });
    render(
      await BuildsIndexPage({ params: Promise.resolve({ projectId: "p1" }) }),
    );
    expect(screen.getByText(/no builds to review/i)).toBeDefined();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  test("non-member sees children only, no panel", async () => {
    const { getProject } = await import("@/lib/get-project");
    vi.mocked(getProject).mockResolvedValueOnce({ status: 403, data: null });
    const ui = await BuildsLayout({
      children: <div data-testid="content" />,
      params: Promise.resolve({ projectId: "p1" }),
    });
    render(ui);
    expect(screen.queryByTestId("panel")).toBeNull();
    expect(screen.getByTestId("content")).toBeDefined();
  });
});
