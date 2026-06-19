import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

let mockPath = "/admin/members";
vi.mock("next/navigation", () => ({
  usePathname: () => mockPath,
}));

import { AdminTabs } from "@/app/(protected)/admin/(area)/_components/admin-tabs";

afterEach(cleanup);

describe("AdminTabs", () => {
  test("renders Members + Installations tabs with hrefs", () => {
    mockPath = "/admin/members";
    render(<AdminTabs />);
    expect(
      screen.getByRole("link", { name: /Members/ }).getAttribute("href"),
    ).toBe("/admin/members");
    expect(
      screen.getByRole("link", { name: /Installations/ }).getAttribute("href"),
    ).toBe("/admin/installations");
  });

  test("marks the active tab from the pathname", () => {
    mockPath = "/admin/installations";
    render(<AdminTabs />);
    expect(
      screen
        .getByRole("link", { name: /Installations/ })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(
      screen
        .getByRole("link", { name: /Members/ })
        .getAttribute("aria-current"),
    ).toBeNull();
  });
});
