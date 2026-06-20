import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/admin/members/extra",
}));

import { RouteTabs } from "@/components/ui/route-tabs";

afterEach(cleanup);

describe("RouteTabs", () => {
  test("marks the tab active on exact match and on a deeper sub-route", () => {
    render(
      <RouteTabs
        tabs={[
          { label: "Members", href: "/admin/members" },
          { label: "Installations", href: "/admin/installations" },
        ]}
      />,
    );
    const members = screen.getByTestId("primary-tab-members");
    const installs = screen.getByTestId("primary-tab-installations");
    expect(members.getAttribute("aria-current")).toBe("page");
    expect(installs.getAttribute("aria-current")).toBeNull();
  });
});
