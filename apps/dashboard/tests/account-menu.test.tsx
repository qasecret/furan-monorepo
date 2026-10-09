import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("@/app/(protected)/_components/logout-action", () => ({
  logoutAction: vi.fn(),
}));
// AccountMenu reads the current project for its Settings link.
vi.mock("@/app/(protected)/_components/current-project-provider", () => ({
  useCurrentProject: () => ({
    currentProjectId: "p1",
    currentProject: null,
    projects: [],
  }),
}));

import { AccountMenu } from "@/app/(protected)/_components/account-menu";
import { ROLE_STYLE } from "@/lib/role-style";

afterEach(() => {
  cleanup();
});

describe("AccountMenu", () => {
  test("trigger shows the initial and is labelled", () => {
    render(<AccountMenu email="me@x.io" initial="M" role="admin" />);
    const trigger = screen.getByRole("button", { name: /account menu/i });
    expect(trigger.textContent).toContain("M");
  });

  test("open menu shows email, project Settings, and Sign out", async () => {
    const user = userEvent.setup();
    render(<AccountMenu email="me@x.io" initial="M" role="admin" />);
    await user.click(screen.getByTestId("account-menu-trigger"));
    expect(screen.getByText("me@x.io")).toBeDefined();
    expect(
      screen.getByRole("menuitem", { name: /settings/i }).getAttribute("href"),
    ).toBe("/projects/p1/settings");
    const signOut = screen.getByRole("menuitem", { name: /sign out/i });
    expect(signOut.tagName).toBe("BUTTON");
    expect(signOut.getAttribute("type")).toBe("submit");
  });

  test("role chip uses the shared role style for every role", async () => {
    const user = userEvent.setup();
    for (const role of ["owner", "admin", "editor", "guest"] as const) {
      render(<AccountMenu email="me@x.io" initial="M" role={role} />);
      await user.click(screen.getByTestId("account-menu-trigger"));
      const chip = screen.getByText(role, { selector: "span" });
      for (const cls of ROLE_STYLE[role].split(" ")) {
        expect(chip.className, `${role}: ${cls}`).toContain(cls);
      }
      cleanup();
    }
  });

  test("an unknown role renders the guest chip", async () => {
    const user = userEvent.setup();
    render(<AccountMenu email="me@x.io" initial="M" role="bogus" />);
    await user.click(screen.getByTestId("account-menu-trigger"));
    const chip = screen.getByText("bogus", { selector: "span" });
    expect(chip.className).toContain(ROLE_STYLE.guest);
  });

  test("account menu has no Preferences item", async () => {
    const user = userEvent.setup();
    render(<AccountMenu email="a@b.c" initial="A" role="admin" />);
    await user.click(screen.getByTestId("account-menu-trigger"));
    expect(screen.queryByRole("menuitem", { name: "Preferences" })).toBeNull();
  });
});
