import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

const pushMock = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: pushMock }) }));
vi.mock("@/hooks/useProjectEvents", () => ({
  useProjectEvents: () => undefined,
}));
const listMock = vi.fn();
const listPropertiesMock = vi.fn();
vi.mock("@/lib/trpc", () => ({
  trpc: {
    builds: {
      list: { useQuery: (...a: unknown[]) => listMock(...a) },
      listProperties: {
        useQuery: (...a: unknown[]) => listPropertiesMock(...a),
      },
    },
  },
}));

import { BuildsTable } from "@/app/(protected)/projects/[projectId]/builds/_components/builds-table";

afterEach(cleanup);

describe("BuildsTable", () => {
  test("clicking a build row navigates to the batch page (no drawer)", () => {
    listMock.mockReturnValue({
      data: {
        items: [
          {
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
          },
        ],
        nextCursor: null,
      },
      isLoading: false,
      error: null,
    });
    listPropertiesMock.mockReturnValue({ data: [], isLoading: false });
    pushMock.mockClear();
    render(<BuildsTable projectId="p1" />);
    fireEvent.click(screen.getByTestId("build-row-b1"));
    expect(pushMock).toHaveBeenCalledWith("/projects/p1/builds/b1");
  });

  test("pressing Enter on a build row navigates to the batch page", () => {
    listMock.mockReturnValue({
      data: {
        items: [
          {
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
          },
        ],
        nextCursor: null,
      },
      isLoading: false,
      error: null,
    });
    listPropertiesMock.mockReturnValue({ data: [], isLoading: false });
    pushMock.mockClear();
    render(<BuildsTable projectId="p1" />);
    fireEvent.keyDown(screen.getByTestId("build-row-b1"), { key: "Enter" });
    expect(pushMock).toHaveBeenCalledWith("/projects/p1/builds/b1");
  });
});
