import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("@/app/(protected)/_components/logout-action", () => ({
  logoutAction: vi.fn(),
}));

import { AccountMenu } from "@/app/(protected)/_components/account-menu";

afterEach(cleanup);

describe("AccountMenu", () => {
  test("trigger shows the initial and is labelled", () => {
    render(<AccountMenu email="me@x.io" initial="M" role="admin" />);
    const trigger = screen.getByRole("button", { name: /account menu/i });
    expect(trigger.textContent).toContain("M");
  });

  test("open menu shows email, Tokens link, and a Sign out submit", () => {
    render(
      <AccountMenu email="me@x.io" initial="M" role="admin" defaultOpen />,
    );
    expect(screen.getByText("me@x.io")).toBeDefined();
    const tokens = screen.getByRole("menuitem", { name: /tokens/i });
    expect(tokens.getAttribute("href")).toBe("/account/tokens");
    const signOut = screen.getByRole("menuitem", { name: /sign out/i });
    expect(signOut.tagName).toBe("BUTTON");
    expect(signOut.getAttribute("type")).toBe("submit");
  });
});
