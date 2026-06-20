import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/projects/p1/builds",
}));
vi.mock("@/app/(protected)/_components/inbox-badge", () => ({
  InboxBadge: () => null,
}));

import { Sidebar } from "@/app/(protected)/_components/sidebar";

afterEach(cleanup);

describe("Sidebar (rail)", () => {
  test("shows destinations, not the active project or an account section", () => {
    render(<Sidebar userRole="admin" />);
    expect(screen.getByText("Inbox")).toBeDefined();
    expect(screen.queryByText("Projects")).toBeNull();
    expect(screen.queryByText("Account")).toBeNull();
    expect(screen.queryByText("Tokens")).toBeNull();
    expect(screen.queryByTestId("sidebar-active-project")).toBeNull();
    expect(screen.queryByTestId("sidebar-user-chip")).toBeNull();
    expect(screen.queryByTestId("logout-button")).toBeNull();
  });

  test("admin rail shows Analytics + Admin and not the old Members/Installations links", () => {
    render(<Sidebar userRole="admin" />);
    expect(screen.getByTestId("sidebar-nav-analytics")).toBeTruthy();
    expect(screen.getByTestId("sidebar-nav-admin")).toBeTruthy();
    expect(screen.queryByTestId("sidebar-nav-admin-members")).toBeNull();
    expect(screen.queryByTestId("sidebar-nav-admin-installations")).toBeNull();
  });
});
