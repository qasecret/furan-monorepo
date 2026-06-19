import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/projects/p1/builds/b1",
}));
vi.mock("@/hooks/useProjectEvents", () => ({
  useProjectEvents: () => undefined,
}));
vi.mock(
  "@/app/(protected)/projects/[projectId]/builds/_components/project-switcher",
  () => ({ ProjectSwitcher: () => <div data-testid="switcher" /> }),
);
vi.mock(
  "@/app/(protected)/projects/[projectId]/builds/_components/properties-filter",
  () => ({ PropertiesFilter: () => <div data-testid="filter" /> }),
);
const listMock = vi.fn();
vi.mock("@/lib/trpc", () => ({
  trpc: { builds: { list: { useQuery: () => listMock() } } },
}));

import { BuildsListPanel } from "@/app/(protected)/projects/[projectId]/builds/_components/builds-list-panel";

afterEach(cleanup);

const item = {
  id: "b1",
  ciBuildId: "c",
  number: 42,
  branchName: "main",
  name: null,
  properties: {},
  runCount: 1,
  unresolvedCount: 1,
  failedCount: 0,
  passedCount: 0,
  abortedCount: 0,
  aggregateStatus: "unresolved",
  createdAt: new Date().toISOString(),
};

describe("BuildsListPanel", () => {
  test("lists builds and marks the active one from the path", () => {
    listMock.mockReturnValue({
      data: { items: [item], nextCursor: null },
      isLoading: false,
      error: null,
    });
    render(<BuildsListPanel projectId="p1" projects={[]} />);
    const link = screen.getByTestId("build-list-item-b1");
    expect(link.getAttribute("aria-current")).toBe("true");
  });

  test("shows the SDK onboarding empty state when there are no builds", () => {
    listMock.mockReturnValue({
      data: { items: [], nextCursor: null },
      isLoading: false,
      error: null,
    });
    render(<BuildsListPanel projectId="p1" projects={[]} />);
    expect(screen.getByText(/no builds yet/i)).toBeDefined();
    expect(
      screen.getByTestId("empty-builds-cta-token-link").getAttribute("href"),
    ).toBe("/account/tokens");
  });
});
