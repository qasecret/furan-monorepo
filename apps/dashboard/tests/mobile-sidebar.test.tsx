/**
 * Smoke test for the mobile-sidebar wiring: the MobileSidebar drawer must
 * render its surface when the store flips open. Without this gate the
 * drawer could ship as inert markup.
 *
 * Note: the TopBar hamburger button was removed in U7 Task 2 (the sidebar is
 * being removed in later U7 tasks). The store can still be flipped directly
 * for tests that care about MobileSidebar rendering.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../src/app/(protected)/_components/sidebar", () => ({
  Sidebar: ({ userRole }: { userRole: string }) => (
    <aside data-testid="app-sidebar">mocked sidebar — {userRole}</aside>
  ),
}));

import { MobileSidebar } from "../src/app/(protected)/_components/mobile-sidebar";
import { useMobileSidebarStore } from "../src/app/(protected)/_components/use-mobile-sidebar";

beforeEach(() => {
  useMobileSidebarStore.setState({ open: false });
});

afterEach(() => {
  cleanup();
  useMobileSidebarStore.setState({ open: false });
});

describe("MobileSidebar wiring", () => {
  test("MobileSidebar drawer mounts when store flips open", async () => {
    render(<MobileSidebar userRole="admin" />);
    expect(screen.queryByTestId("mobile-sidebar")).toBeNull();

    useMobileSidebarStore.setState({ open: true });
    await screen.findByTestId("mobile-sidebar");
    expect(screen.getByTestId("app-sidebar")).toBeDefined();
  });
});
