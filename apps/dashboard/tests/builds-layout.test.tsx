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

import BuildsLayout from "@/app/(protected)/projects/[projectId]/builds/layout";
import BuildsIndexPage from "@/app/(protected)/projects/[projectId]/builds/page";

afterEach(cleanup);

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

  test("index page prompts to select a build", async () => {
    render(
      await BuildsIndexPage({ params: Promise.resolve({ projectId: "p1" }) }),
    );
    expect(screen.getByText(/select a build/i)).toBeDefined();
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
