/**
 * Smoke test for the mobile-sidebar wiring: the TopBar hamburger button
 * must flip the shared zustand store, and the MobileSidebar drawer must
 * render its surface when the store flips open. Without this gate the
 * drawer could ship as inert markup.
 *
 * `logout-action` is stubbed because TopBar renders AccountMenu, which
 * imports the logout server action. AccountMenu's real import chain
 * reaches `src/lib/auth.ts`, which carries `server-only` and isn't safe
 * to mount in jsdom. The wiring being tested doesn't depend on AccountMenu's
 * contents — only that the drawer surface mounts when `open` flips true.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/projects",
}));

vi.mock("../src/app/(protected)/_components/logout-action", () => ({
  logoutAction: vi.fn(),
}));

vi.mock("../src/app/(protected)/_components/sidebar", () => ({
  Sidebar: ({ userRole }: { userRole: string }) => (
    <aside data-testid="app-sidebar">mocked sidebar — {userRole}</aside>
  ),
}));

import { MobileSidebar } from "../src/app/(protected)/_components/mobile-sidebar";
import { TopBar } from "../src/app/(protected)/_components/top-bar";
import { useMobileSidebarStore } from "../src/app/(protected)/_components/use-mobile-sidebar";

beforeEach(() => {
  useMobileSidebarStore.setState({ open: false });
});

afterEach(() => {
  cleanup();
  useMobileSidebarStore.setState({ open: false });
});

describe("MobileSidebar wiring", () => {
  test("TopBar hamburger flips the mobile-sidebar store open", () => {
    render(<TopBar email="alice@example.com" initial="A" role="admin" />);
    expect(useMobileSidebarStore.getState().open).toBe(false);

    fireEvent.click(screen.getByTestId("top-bar-menu"));
    expect(useMobileSidebarStore.getState().open).toBe(true);
  });

  test("TopBar hamburger has md:hidden so it's invisible on desktop", () => {
    render(<TopBar email="alice@example.com" initial="A" role="admin" />);
    const menu = screen.getByTestId("top-bar-menu");
    expect(menu.className).toContain("md:hidden");
  });

  test("MobileSidebar drawer mounts when store flips open", async () => {
    render(
      <MobileSidebar
        userRole="admin"
        userEmail="alice@example.com"
        userInitial="A"
      />,
    );
    expect(screen.queryByTestId("mobile-sidebar")).toBeNull();

    useMobileSidebarStore.setState({ open: true });
    await screen.findByTestId("mobile-sidebar");
    expect(screen.getByTestId("app-sidebar")).toBeDefined();
  });
});
