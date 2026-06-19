import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/inbox" }));
vi.mock("@/components/cmdk/use-command-palette", () => ({
  usePaletteStore: () => () => undefined,
}));
vi.mock("@/app/(protected)/_components/use-mobile-sidebar", () => ({
  useMobileSidebarStore: () => () => undefined,
}));
vi.mock("@/app/(protected)/_components/use-breadcrumbs", () => ({
  useBreadcrumbsStore: (sel: (s: unknown) => unknown) =>
    sel({ items: [], pathname: "/inbox" }),
}));
vi.mock("@/components/tour/help-button", () => ({ HelpButton: () => null }));
vi.mock("@/app/(protected)/_components/logout-action", () => ({
  logoutAction: vi.fn(),
}));

import { TopBar } from "@/app/(protected)/_components/top-bar";

afterEach(cleanup);

describe("TopBar", () => {
  test("renders the account menu trigger with the user's initial", () => {
    render(<TopBar email="me@x.io" initial="M" role="admin" />);
    expect(
      screen.getByRole("button", { name: /account menu/i }).textContent,
    ).toContain("M");
  });
});
