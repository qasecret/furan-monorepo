import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("@/lib/api-client", () => ({
  apiGet: vi.fn(async () => ({ status: 200, data: [] })),
}));
// Keep the real role predicates (isAtLeastAdmin — the page's admin gate); only
// stub the network-backed getViewerRole.
vi.mock("@/lib/get-viewer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/get-viewer")>();
  return {
    ...actual,
    getViewerRole: vi.fn(async () => "admin"),
  };
});
// Stub the dialog + empty-state so the test doesn't pull in react-hook-form /
// next/navigation; we only care about the grid + card links here.
vi.mock("@/app/(protected)/projects/_components/create-project-dialog", () => ({
  CreateProjectDialog: () => <button>Create project</button>,
}));
vi.mock("@/app/(protected)/projects/_components/empty-projects-cta", () => ({
  EmptyProjectsCta: () => <div data-testid="empty-cta" />,
}));

import AdminProjectsPage from "@/app/(protected)/admin/(area)/projects/page";

afterEach(cleanup);

describe("AdminProjectsPage", () => {
  test("cards link to the per-project admin members drill-in", async () => {
    const { apiGet } = await import("@/lib/api-client");
    vi.mocked(apiGet).mockResolvedValueOnce({
      status: 200,
      data: [
        { id: "p1", name: "Acme", mainBranchName: "main" },
        { id: "p2", name: "Beta", mainBranchName: "trunk" },
      ],
    });

    render(await AdminProjectsPage());

    expect(
      screen.getByRole("link", { name: /Acme/ }).getAttribute("href"),
    ).toBe("/admin/projects/p1/members");
    expect(
      screen.getByRole("link", { name: /Beta/ }).getAttribute("href"),
    ).toBe("/admin/projects/p2/members");
    // Create dialog (stubbed) renders alongside the grid.
    expect(
      screen.getByRole("button", { name: /Create project/ }),
    ).toBeDefined();
  });

  test("renders the empty CTA when there are no projects", async () => {
    const { apiGet } = await import("@/lib/api-client");
    vi.mocked(apiGet).mockResolvedValueOnce({ status: 200, data: [] });

    render(await AdminProjectsPage());

    expect(screen.getByTestId("empty-cta")).toBeDefined();
    expect(screen.queryByRole("link")).toBeNull();
  });

  test("non-admin viewers render nothing (defense-in-depth)", async () => {
    const { getViewerRole } = await import("@/lib/get-viewer");
    vi.mocked(getViewerRole).mockResolvedValueOnce("guest");

    const ui = await AdminProjectsPage();
    expect(ui).toBeNull();
  });
});
