import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// AccountMenu (now rendered inside TopBar) imports the logout server action,
// which reaches for next/headers; stub it so the component tree mounts in
// jsdom. Everything else (palette / mobile stores) stays real so these remain
// genuine wiring tests.
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

// AccountMenu (rendered inside TopBar) now calls useCurrentProject(); stub the
// provider so the menu mounts without a real provider tree.
vi.mock("@/app/(protected)/_components/current-project-provider", () => ({
  useCurrentProject: () => ({
    currentProjectId: null,
    currentProject: null,
    projects: [],
  }),
}));

import { TopBar } from "@/app/(protected)/_components/top-bar";
import { useSidebarStore } from "@/app/(protected)/_components/use-sidebar-store";

const props = { email: "me@x.io", initial: "M", role: "admin" } as const;

beforeEach(() => {
  useSidebarStore.setState({ collapsed: false, open: false });
});

afterEach(() => {
  cleanup();
  useSidebarStore.setState({ collapsed: false, open: false });
});

describe("TopBar", () => {
  // #308 replaced the top-bar palette-search button with the desktop
  // collapse/expand toggle (the palette is now reachable only via the global
  // Cmd/Ctrl+K handler). This asserts the toggle is wired to the sidebar store.
  test("clicking the collapse toggle flips the sidebar collapsed state", () => {
    render(<TopBar {...props} />);
    expect(useSidebarStore.getState().collapsed).toBe(false);

    fireEvent.click(screen.getByTestId("sidebar-collapse-toggle"));
    expect(useSidebarStore.getState().collapsed).toBe(true);
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
