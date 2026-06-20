import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

// recharts hits ResizeObserver which jsdom doesn't have. Mock it out.
class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
// @ts-expect-error -- jsdom missing ResizeObserver
global.ResizeObserver = MockResizeObserver;

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
    },
  },
}));

import { AnalyticsPage } from "@/app/(protected)/analytics/_components/analytics-page";

afterEach(cleanup);

describe("AnalyticsPage", () => {
  test("renders KPI cards + window toggle + sections", async () => {
    render(<AnalyticsPage />);
    await waitFor(() => expect(screen.getByText("Analytics")).toBeDefined());
    expect(screen.getByText("12")).toBeDefined(); // totalActions
    expect(screen.getByText("67%")).toBeDefined(); // approveRate
    expect(screen.getByText("75%")).toBeDefined(); // keyboardRate
    expect(screen.getByText("Actions per day")).toBeDefined();
    expect(screen.getByText("Top reviewers")).toBeDefined();
    expect(screen.getByTestId("analytics-window-7d")).toBeDefined();
  });

  test("surfaces the richer metrics + reviewer leaderboard", async () => {
    render(<AnalyticsPage />);
    await waitFor(() => expect(screen.getByText("Analytics")).toBeDefined());
    expect(screen.getByText("Sessions")).toBeDefined();
    expect(screen.getByText("5")).toBeDefined(); // sessions
    expect(screen.getByText("Median time / action")).toBeDefined();
    expect(screen.getByText("4.5s")).toBeDefined(); // medianMsPerAction 4500
    expect(screen.getByText("8 approve · 4 reject")).toBeDefined();
    expect(screen.getByText("alice@x.test")).toBeDefined(); // leaderboard row
  });
});
