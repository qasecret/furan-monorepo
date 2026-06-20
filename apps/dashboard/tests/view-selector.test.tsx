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
