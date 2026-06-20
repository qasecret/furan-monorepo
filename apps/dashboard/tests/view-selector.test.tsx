import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

const push = vi.fn();
let pathname = "/projects/p1/builds";
vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
  useRouter: () => ({ push }),
}));
vi.mock("@/app/(protected)/_components/current-project-provider", () => ({
  useCurrentProject: () => ({
    currentProjectId: "p1",
    currentProject: { id: "p1", name: "alpha" },
    projects: [{ id: "p1", name: "alpha" }],
    setCurrentProject: vi.fn(),
  }),
}));
vi.mock("@/app/(protected)/_components/inbox-badge", () => ({
  InboxBadge: () => null,
}));

import { ViewSelector } from "@/app/(protected)/_components/view-selector";

afterEach(() => {
  cleanup();
  push.mockClear();
});

test("trigger shows the current view; dropdown navigates", async () => {
  pathname = "/projects/p1/builds";
  const user = userEvent.setup();
  render(<ViewSelector userRole="admin" />);
  expect(screen.getByTestId("view-selector-trigger").textContent).toContain(
    "Builds",
  );
  await user.click(screen.getByTestId("view-selector-trigger"));
  await user.click(screen.getByTestId("view-variations"));
  expect(push).toHaveBeenCalledWith("/projects/p1/variations");
});

test("Analytics/Admin are admin-only", async () => {
  pathname = "/inbox";
  const user = userEvent.setup();
  render(<ViewSelector userRole="editor" />);
  expect(screen.getByTestId("view-selector-trigger").textContent).toContain(
    "Inbox",
  );
  await user.click(screen.getByTestId("view-selector-trigger"));
  expect(screen.queryByTestId("view-analytics")).toBeNull();
  expect(screen.queryByTestId("view-admin")).toBeNull();
  expect(screen.getByTestId("view-inbox")).toBeDefined();
});

// The trigger is a "you are here" indicator: off-grid routes must name the
// page, not fall back to the generic "Menu".
test.each([
  ["/projects", "Projects"],
  ["/account/preferences", "Preferences"],
  ["/account/tokens", "Tokens"],
  ["/projects/p1/runs/r1/diffs/d1", "Review"],
  ["/projects/p1/builds/b1", "Builds"],
])("trigger names %s as %s (never 'Menu')", (path, label) => {
  pathname = path;
  render(<ViewSelector userRole="admin" />);
  const text = screen.getByTestId("view-selector-trigger").textContent ?? "";
  expect(text).toContain(label);
  expect(text).not.toContain("Menu");
});
