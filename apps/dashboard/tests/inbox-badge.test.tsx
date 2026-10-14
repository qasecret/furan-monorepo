import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const countMock = vi.fn();
const projectState = vi.hoisted(() => ({
  currentProjectId: "p1" as string | null,
}));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    builds: {
      pendingCount: { useQuery: (...a: unknown[]) => countMock(...a) },
    },
  },
}));
vi.mock("@/app/(protected)/_components/current-project-provider", () => ({
  useCurrentProject: () => ({
    currentProjectId: projectState.currentProjectId,
    currentProject: null,
    projects: [],
    setCurrentProject: vi.fn(),
  }),
}));

import { InboxBadge } from "@/app/(protected)/_components/inbox-badge";

beforeEach(() => {
  projectState.currentProjectId = "p1";
  countMock.mockReset();
  countMock.mockReturnValue({ data: { total: 3 } });
});
afterEach(cleanup);

describe("InboxBadge (batches that need review)", () => {
  test("badge shows builds.pendingCount and hides at 0", () => {
    const { container, rerender } = render(<InboxBadge />);
    const badge = screen.getByLabelText("3 batches need review");
    expect(badge.textContent).toBe("3");

    countMock.mockReturnValue({ data: { total: 0 } });
    rerender(<InboxBadge />);
    expect(container.firstChild).toBeNull();
  });

  test("names a single batch in the singular", () => {
    countMock.mockReturnValue({ data: { total: 1 } });
    render(<InboxBadge />);
    expect(screen.getByLabelText("1 batch needs review").textContent).toBe("1");
  });

  test("hides while the count has not loaded", () => {
    countMock.mockReturnValue({ data: undefined });
    const { container } = render(<InboxBadge />);
    expect(container.firstChild).toBeNull();
  });

  test("builds.pendingCount is scoped to the current project and refetches every 60 s", () => {
    render(<InboxBadge />);
    expect(countMock).toHaveBeenCalledWith(
      { projectId: "p1" },
      expect.objectContaining({ refetchInterval: 60_000, enabled: true }),
    );
  });

  test("does not ask without a project", () => {
    projectState.currentProjectId = null;
    countMock.mockReturnValue({ data: undefined });
    const { container } = render(<InboxBadge />);
    expect(container.firstChild).toBeNull();
    expect(countMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ enabled: false }),
    );
  });

  test("caps the visible number at 99+ but names the full count", () => {
    countMock.mockReturnValue({ data: { total: 120 } });
    render(<InboxBadge />);
    const badge = screen.getByLabelText("120 batches need review");
    expect(badge.textContent).toBe("99+");
  });
});
