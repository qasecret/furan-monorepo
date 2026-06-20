import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

const countMock = vi.fn().mockReturnValue({ data: { total: 3 } });
vi.mock("@/lib/trpc", () => ({
  trpc: {
    inbox: { count: { useQuery: (...a: unknown[]) => countMock(...a) } },
  },
}));
vi.mock("@/app/(protected)/_components/current-project-provider", () => ({
  useCurrentProject: () => ({
    currentProjectId: "p1",
    currentProject: null,
    projects: [],
    setCurrentProject: vi.fn(),
  }),
}));

import { InboxBadge } from "@/app/(protected)/_components/inbox-badge";

afterEach(cleanup);

test("inbox.count is scoped to the current project", () => {
  render(<InboxBadge />);
  expect(countMock).toHaveBeenCalledWith(
    expect.objectContaining({ projectIds: ["p1"] }),
    expect.anything(),
  );
});
