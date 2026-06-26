import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

// recharts hits ResizeObserver which jsdom doesn't have. Mock it out.
class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = MockResizeObserver;

vi.mock("@/app/(protected)/_components/current-project-provider", () => ({
  useCurrentProject: () => ({
    currentProjectId: "p1",
    currentProject: null,
    projects: [],
  }),
}));

vi.mock("@/lib/trpc", () => ({
  trpc: {
    analytics: {
      summary: {
        useQuery: () => ({
          data: {
            totalActions: 12,
            approves: 8,
            rejects: 4,
            viaKeyboard: 9,
            sessions: 5,
            medianMsPerAction: 4500,
            medianTimeToFirstActionMs: 8000,
            approveRate: 0.667,
            rejectRate: 0.333,
            keyboardRate: 0.75,
          },
          isLoading: false,
        }),
      },
      actionsByDay: {
        useQuery: () => ({
          data: { items: [{ day: "2026-05-26", approves: 4, rejects: 2 }] },
          isLoading: false,
        }),
      },
      topReviewers: {
        useQuery: () => ({
          data: {
            items: [{ userId: "u1", email: "alice@x.test", actions: 7 }],
          },
          isLoading: false,
        }),
      },
      testResultsSummary: {
        useQuery: () => ({
          data: {
            total: 20,
            passed: 16,
            failed: 2,
            unresolved: 2,
            passRate: 0.8,
            prevTotal: 15,
            prevPassRate: 0.73,
          },
          isLoading: false,
        }),
      },
      runsByDay: {
        useQuery: () => ({
          data: {
            items: [{ day: "2026-05-26", passed: 5, failed: 1, unresolved: 0 }],
          },
          isLoading: false,
        }),
      },
      topFragileTests: {
        useQuery: () => ({
          data: {
            items: [{ name: "login-test", executions: 10, passed: 3 }],
          },
          isLoading: false,
        }),
      },
    },
  },
}));

import { AnalyticsPage } from "@/app/(protected)/analytics/_components/analytics-page";

afterEach(cleanup);

describe("AnalyticsPage", () => {
  test("renders KPI cards + window toggle + sections", async () => {
    render(<AnalyticsPage />);
    await waitFor(() => expect(screen.getByText("Insights")).toBeDefined());
    expect(screen.getByText("Top reviewers")).toBeDefined();
    expect(screen.getByTestId("analytics-window-7d")).toBeDefined();
  });

  test("surfaces reviewer leaderboard and fragile tests", async () => {
    render(<AnalyticsPage />);
    await waitFor(() => expect(screen.getByText("Insights")).toBeDefined());
    expect(screen.getByText("alice@x.test")).toBeDefined(); // leaderboard row
    expect(screen.getByText("Top fragile tests")).toBeDefined();
  });
});
