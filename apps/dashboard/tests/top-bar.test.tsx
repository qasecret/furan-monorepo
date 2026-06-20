import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// AccountMenu (now rendered inside TopBar) imports the logout server action,
// which reaches for next/headers; stub it so the component tree mounts in
// jsdom. Everything else (palette / breadcrumb / mobile stores) stays real so
// these remain genuine wiring tests.
vi.mock("@/app/(protected)/_components/logout-action", () => ({
  logoutAction: vi.fn(),
}));

// ProjectSelector calls useCurrentProject() which throws outside a provider.
// Stub the whole module so TopBar tests don't need a real provider tree.
vi.mock("@/app/(protected)/_components/project-selector", () => ({
  ProjectSelector: () => (
    <div data-testid="project-selector-stub" aria-hidden="true" />
  ),
}));

// ViewSelector also calls useCurrentProject() and usePathname(); stub it.
vi.mock("@/app/(protected)/_components/view-selector", () => ({
  ViewSelector: () => (
    <div data-testid="view-selector-stub" aria-hidden="true" />
  ),
}));

import { TopBar } from "@/app/(protected)/_components/top-bar";
import { usePaletteStore } from "@/components/cmdk/use-command-palette";

const props = { email: "me@x.io", initial: "M", role: "admin" } as const;

beforeEach(() => {
  usePaletteStore.setState({ open: false });
});

afterEach(() => {
  cleanup();
  usePaletteStore.setState({ open: false });
});

describe("TopBar", () => {
  test("clicking the search button opens the cmdk palette", () => {
    render(<TopBar {...props} />);
    expect(usePaletteStore.getState().open).toBe(false);

    fireEvent.click(screen.getByTestId("top-bar-search"));
    expect(usePaletteStore.getState().open).toBe(true);
  });

  test("notification bell is disabled stub", () => {
    render(<TopBar {...props} />);
    const bell = screen.getByTestId("top-bar-bell") as HTMLButtonElement;
    expect(bell.disabled).toBe(true);
    expect(bell.getAttribute("aria-disabled")).toBe("true");
  });

  test("renders the account menu trigger with the user's initial", () => {
    render(<TopBar {...props} />);
    expect(
      screen.getByRole("button", { name: /account menu/i }).textContent,
    ).toContain("M");
  });
});
