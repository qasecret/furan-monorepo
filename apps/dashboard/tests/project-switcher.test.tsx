import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

import { ProjectSwitcher } from "@/app/(protected)/projects/[projectId]/builds/_components/project-switcher";

afterEach(cleanup);

const projects = [
  { id: "p1", name: "Acme Web" },
  { id: "p2", name: "Marketing Site" },
];

describe("ProjectSwitcher", () => {
  test("shows the current project name and lists others when open", () => {
    render(<ProjectSwitcher projectId="p1" projects={projects} defaultOpen />);
    expect(
      screen.getByTestId("project-switcher-current").textContent,
    ).toContain("Acme Web");
    const other = screen.getByRole("menuitem", { name: /Marketing Site/ });
    expect(other.getAttribute("href")).toBe("/projects/p2/builds");
  });
});
