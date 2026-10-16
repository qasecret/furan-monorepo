import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

let pathname = "/inbox";
const mockCtx = {
  currentProjectId: "a",
  currentProject: { id: "a", name: "alpha" },
  projects: [
    { id: "a", name: "alpha" },
    { id: "b", name: "beta" },
  ],
};
vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
}));
vi.mock("@/app/(protected)/_components/current-project-provider", () => ({
  useCurrentProject: () => mockCtx,
}));

import { ProjectSelector } from "@/app/(protected)/_components/project-selector";

afterEach(() => {
  cleanup();
  pathname = "/inbox";
});

describe("ProjectSelector", () => {
  test("renders a static label, not an interactive control", () => {
    render(<ProjectSelector />);
    expect(screen.getByTestId("project-selector-label")).toBeDefined();
    expect(screen.queryByTestId("project-selector-trigger")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  test("a long project name shrinks and ellipsizes instead of pushing the bar", () => {
    // The top bar's left cluster is `min-w-0 flex-1`; the label and its text
    // must be able to give way in it, or the bar's other controls overlap.
    render(<ProjectSelector />);
    const label = screen.getByTestId("project-selector-label");
    expect(label.classList.contains("min-w-0")).toBe(true);
    const name = screen.getByText("alpha");
    expect(name.classList.contains("truncate")).toBe(true);
    expect(name.classList.contains("min-w-0")).toBe(true);
    // The icon keeps its size while the text gives way.
    expect(label.querySelector("svg")?.classList.contains("shrink-0")).toBe(
      true,
    );
  });

  test("on a project route the label shows the URL project's name", () => {
    pathname = "/projects/b/builds";
    render(<ProjectSelector />);
    expect(screen.getByTestId("project-selector-label").textContent).toContain(
      "beta",
    );
  });

  test("off a project route the label shows the default project's name", () => {
    pathname = "/inbox";
    render(<ProjectSelector />);
    expect(screen.getByTestId("project-selector-label").textContent).toContain(
      "alpha",
    );
  });

  // On workspace-global views (Analytics/Admin) the project does not scope the
  // page; the label is de-emphasised and explains itself so the name doesn't
  // read as a filter.
  test.each(["/analytics", "/admin", "/admin/members"])(
    "de-emphasises + explains scope on %s",
    (p) => {
      pathname = p;
      render(<ProjectSelector />);
      const label = screen.getByTestId("project-selector-label");
      expect(label.className).toContain("opacity-60");
      expect(label.getAttribute("title")).toContain("all projects");
    },
  );

  test("full emphasis (no title) on project-scoped pages", () => {
    pathname = "/projects/a/builds";
    render(<ProjectSelector />);
    const label = screen.getByTestId("project-selector-label");
    expect(label.className).not.toContain("opacity-60");
    expect(label.getAttribute("title")).toBeNull();
  });
});
