import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/projects/p1/builds",
}));
const listMock = vi.fn();
vi.mock("@/lib/trpc", () => ({
  trpc: { projects: { list: { useQuery: () => listMock() } } },
}));

import { ProjectSwitcher } from "@/app/(protected)/projects/[projectId]/builds/_components/project-switcher";

afterEach(cleanup);

describe("ProjectSwitcher", () => {
  test("shows the current project name and lists others when open", () => {
    listMock.mockReturnValue({
      data: [
        { id: "p1", name: "Acme Web" },
        { id: "p2", name: "Marketing Site" },
      ],
      isLoading: false,
    });
    render(<ProjectSwitcher projectId="p1" defaultOpen />);
    expect(
      screen.getByTestId("project-switcher-current").textContent,
    ).toContain("Acme Web");
    const other = screen.getByRole("menuitem", { name: /Marketing Site/ });
    expect(other.getAttribute("href")).toBe("/projects/p2/builds");
  });
});
