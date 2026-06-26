import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

let mockPath = "/admin/members";
vi.mock("next/navigation", () => ({
  usePathname: () => mockPath,
}));

import { AdminTabs } from "@/app/(protected)/admin/(area)/_components/admin-tabs";

afterEach(cleanup);

describe("AdminTabs", () => {
  test("renders Members + Projects + API Keys + Installations tabs with hrefs", () => {
    mockPath = "/admin/members";
    render(<AdminTabs />);
    expect(
      screen.getByRole("link", { name: /Members/ }).getAttribute("href"),
    ).toBe("/admin/members");
    expect(
      screen.getByRole("link", { name: /Projects/ }).getAttribute("href"),
    ).toBe("/admin/projects");
    expect(
      screen.getByRole("link", { name: /API Keys/ }).getAttribute("href"),
    ).toBe("/admin/api-keys");
    expect(
      screen.getByRole("link", { name: /Installations/ }).getAttribute("href"),
    ).toBe("/admin/installations");
  });

  test("orders tabs: Members, Projects, API Keys, Installations", () => {
    mockPath = "/admin/members";
    render(<AdminTabs />);
    const labels = screen
      .getAllByRole("link")
      .map((a) => a.textContent?.trim());
    expect(labels).toEqual([
      "Members",
      "Projects",
      "API Keys",
      "Installations",
    ]);
  });

  test("marks the active tab from the pathname", () => {
    mockPath = "/admin/installations";
    render(<AdminTabs />);
    const installLink = screen.getByRole("link", { name: /Installations/ });
    const membersLink = screen.getByRole("link", { name: /Members/ });
    expect(installLink.className).toContain("border-brand");
    expect(membersLink.className).not.toContain("border-brand");
  });
});
