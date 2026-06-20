import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";

const setCurrentProject = vi.fn();
let pathname = "/inbox";
let mockCtx = {
  currentProjectId: "a",
  currentProject: { id: "a", name: "alpha" },
  projects: [
    { id: "a", name: "alpha" },
    { id: "b", name: "beta" },
  ],
  setCurrentProject,
};
vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@/app/(protected)/_components/current-project-provider", () => ({
  useCurrentProject: () => mockCtx,
}));
vi.mock("@/app/(protected)/projects/_components/create-project-dialog", () => ({
  CreateProjectDialog: () => <div data-testid="create-dialog" />,
}));

import { ProjectSelector } from "@/app/(protected)/_components/project-selector";

afterEach(() => {
  cleanup();
  setCurrentProject.mockClear();
  pathname = "/inbox";
});

describe("ProjectSelector", () => {
  test("single project renders a static chip (no trigger)", () => {
    mockCtx = { ...mockCtx, projects: [{ id: "a", name: "alpha" }] };
    render(<ProjectSelector userRole="editor" />);
    expect(screen.getByTestId("project-selector-single")).toBeDefined();
    expect(screen.queryByTestId("project-selector-trigger")).toBeNull();
  });

  test("2+ projects: opening the dropdown and picking one calls setCurrentProject", async () => {
    mockCtx = {
      ...mockCtx,
      projects: [
        { id: "a", name: "alpha" },
        { id: "b", name: "beta" },
      ],
    };
    const user = userEvent.setup();
    render(<ProjectSelector userRole="editor" />);
    await user.click(screen.getByTestId("project-selector-trigger"));
    await user.click(screen.getByTestId("project-option-b"));
    expect(setCurrentProject).toHaveBeenCalledWith("b");
  });

  test("Create project is admin-only", async () => {
    const user = userEvent.setup();
    render(<ProjectSelector userRole="editor" />);
    await user.click(screen.getByTestId("project-selector-trigger"));
    expect(screen.queryByTestId("project-create")).toBeNull();
    cleanup();
    render(<ProjectSelector userRole="admin" />);
    await user.click(screen.getByTestId("project-selector-trigger"));
    expect(screen.getByTestId("project-create")).toBeDefined();
  });

  // On workspace-global views (Analytics/Admin) the selected project does not
  // scope the page; the chip is de-emphasised and explains itself so the name
  // doesn't read as a filter.
  test.each(["/analytics", "/admin", "/admin/members"])(
    "de-emphasises + explains scope on %s",
    (p) => {
      pathname = p;
      render(<ProjectSelector userRole="admin" />);
      const trigger = screen.getByTestId("project-selector-trigger");
      expect(trigger.className).toContain("opacity-60");
      expect(trigger.getAttribute("title")).toContain("all projects");
    },
  );

  test("full emphasis (no title) on project-scoped pages", () => {
    pathname = "/projects/a/builds";
    render(<ProjectSelector userRole="admin" />);
    const trigger = screen.getByTestId("project-selector-trigger");
    expect(trigger.className).not.toContain("opacity-60");
    expect(trigger.getAttribute("title")).toBeNull();
  });
});
