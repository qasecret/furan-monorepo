import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));
const projects = vi.hoisted(() => ({
  list: [] as { id: string; name: string }[],
}));
vi.mock("@/app/(protected)/_components/current-project-provider", () => ({
  useCurrentProject: () => ({
    currentProjectId: null,
    currentProject: null,
    projects: projects.list,
  }),
}));

import { NoCurrentProject } from "@/app/(protected)/_components/no-current-project";
import { CommandRoleProvider } from "@/lib/commands/registry";
import type { ViewerRole } from "@/lib/roles";

afterEach(() => {
  cleanup();
  projects.list = [];
});

function renderAs(role: ViewerRole) {
  return render(
    <CommandRoleProvider role={role}>
      <NoCurrentProject />
    </CommandRoleProvider>,
  );
}

describe("NoCurrentProject", () => {
  test.each(["admin", "owner"] as const)(
    "an %s with no projects creates the first one",
    (role) => {
      renderAs(role);
      expect(screen.getByTestId("inbox-no-project")).toBeDefined();
      expect(
        screen.getByRole("heading", { name: "Create your first project" }),
      ).toBeDefined();
      expect(
        screen.getByText(
          "Projects hold your baselines and batches. Create one, then connect the SDK.",
        ),
      ).toBeDefined();
      expect(screen.getByTestId("create-project-button")).toBeDefined();
      expect(
        screen
          .getByRole("link", {
            name: "Creating a project (opens in a new tab)",
          })
          .getAttribute("href"),
      ).toBe("/docs/getting-started/create-project");
      expect(screen.queryByText(/Ask an admin/)).toBeNull();
    },
  );

  test("an admin with two projects and no default chooses one", () => {
    projects.list = [
      { id: "p1", name: "checkout-web" },
      { id: "p2", name: "mobile-app" },
    ];
    renderAs("admin");
    expect(
      screen.getByRole("heading", { name: "Choose a project" }),
    ).toBeDefined();
    expect(
      screen.getByText(
        "Batches shows your default project, and you don't have one yet.",
      ),
    ).toBeDefined();
    expect(
      screen.getByRole("link", { name: "checkout-web" }).getAttribute("href"),
    ).toBe("/projects/p1/builds");
    expect(
      screen.getByRole("link", { name: "mobile-app" }).getAttribute("href"),
    ).toBe("/projects/p2/builds");
    const members = screen.getByRole("link", { name: "Admin → Members" });
    expect(members.getAttribute("href")).toBe("/admin/members");
    expect(members.parentElement?.textContent).toBe(
      "To land here, set your default project in Admin → Members.",
    );
  });

  test("an editor is told to ask an admin, with the docs", () => {
    renderAs("editor");
    expect(
      screen.getByRole("heading", { name: "No project assigned" }),
    ).toBeDefined();
    expect(
      screen.getByText("Ask an admin to add you to a project."),
    ).toBeDefined();
    expect(
      screen
        .getByRole("link", { name: "Getting started (opens in a new tab)" })
        .getAttribute("href"),
    ).toBe("/docs/getting-started/install");
    expect(screen.queryByTestId("create-project-button")).toBeNull();
  });
});
