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
    expect(screen.getByText("Projects")).toBeDefined();
    expect(screen.queryByText("Account")).toBeNull();
    expect(screen.queryByText("Tokens")).toBeNull();
    expect(screen.queryByTestId("sidebar-active-project")).toBeNull();
    expect(screen.queryByTestId("sidebar-user-chip")).toBeNull();
    expect(screen.queryByTestId("logout-button")).toBeNull();
  });
});
