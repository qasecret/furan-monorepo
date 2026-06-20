import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("@/app/(protected)/_components/logout-action", () => ({
  logoutAction: vi.fn(),
}));

import { AccountMenu } from "@/app/(protected)/_components/account-menu";
import { CURRENT_PROJECT_SESSION_KEY } from "@/app/(protected)/_components/current-project-provider";

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
});

describe("AccountMenu", () => {
  test("trigger shows the initial and is labelled", () => {
    render(<AccountMenu email="me@x.io" initial="M" role="admin" />);
    const trigger = screen.getByRole("button", { name: /account menu/i });
    expect(trigger.textContent).toContain("M");
  });

  test("open menu shows email, Tokens link, and a Sign out submit", async () => {
    const user = userEvent.setup();
    render(<AccountMenu email="me@x.io" initial="M" role="admin" />);
    await user.click(screen.getByTestId("account-menu-trigger"));
    expect(screen.getByText("me@x.io")).toBeDefined();
    const tokens = screen.getByRole("menuitem", { name: /tokens/i });
    expect(tokens.getAttribute("href")).toBe("/account/tokens");
    const signOut = screen.getByRole("menuitem", { name: /sign out/i });
    expect(signOut.tagName).toBe("BUTTON");
    expect(signOut.getAttribute("type")).toBe("submit");
  });

  test("account menu links to the Preferences page", async () => {
    const user = userEvent.setup();
    render(<AccountMenu email="a@b.c" initial="A" role="admin" />);
    await user.click(screen.getByTestId("account-menu-trigger"));
    const link = screen.getByRole("menuitem", { name: "Preferences" });
    const href =
      link.getAttribute("href") ??
      link.querySelector("a")?.getAttribute("href");
    expect(href).toBe("/account/preferences");
  });

  test("sign out clears the current-project session key", async () => {
    const user = userEvent.setup();
    window.sessionStorage.setItem(CURRENT_PROJECT_SESSION_KEY, "p1");
    render(<AccountMenu email="me@x.io" initial="M" role="admin" />);
    await user.click(screen.getByTestId("account-menu-trigger"));
    await user.click(screen.getByRole("menuitem", { name: /sign out/i }));
    expect(
      window.sessionStorage.getItem(CURRENT_PROJECT_SESSION_KEY),
    ).toBeNull();
  });
});
