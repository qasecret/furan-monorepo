import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

import { KpiCards } from "@/app/(protected)/analytics/_components/kpi-cards";

afterEach(cleanup);

const summary = {
  totalActions: 284,
  approves: 190,
  rejects: 94,
  sessions: 92,
  approveRate: 0.67,
  keyboardRate: 0.75,
  medianMsPerAction: 4500,
  medianTimeToFirstActionMs: 8000,
  prevTotalActions: 200,
  prevApproveRate: 0.6,
};

const testSummary = {
  total: 120,
  passed: 100,
  failed: 15,
  unresolved: 5,
  passRate: 0.833,
  prevTotal: 80,
  prevPassRate: 0.75,
};

describe("KpiCards", () => {
  test("renders four metric tiles with values", () => {
    render(
      <KpiCards
        summary={summary}
        testSummary={testSummary}
        isLoading={false}
        days={7}
      />,
    );
    expect(screen.getByText("120")).toBeDefined();
    expect(screen.getByText(/Test runs/)).toBeDefined();
    expect(screen.getByText("4.5s")).toBeDefined();
    expect(screen.getByText("Avg time to review")).toBeDefined();
    expect(screen.getByText("83%")).toBeDefined();
    expect(screen.getByText("Pass rate")).toBeDefined();
    expect(screen.getByText("67%")).toBeDefined();
    expect(screen.getByText("Approve rate")).toBeDefined();
  });

  test("shows skeletons while loading", () => {
    render(
      <KpiCards
        summary={undefined}
        testSummary={undefined}
        isLoading={true}
        days={7}
      />,
    );
    const skeletons = document.querySelectorAll(".animate-pulse");
    expect(skeletons.length).toBe(4);
  });

  test("renders em-dash for missing time fields", () => {
    render(
      <KpiCards
        isLoading={false}
        days={7}
        testSummary={undefined}
        summary={{
          totalActions: 0,
          approves: 0,
          rejects: 0,
          sessions: 0,
          approveRate: 0,
          keyboardRate: 0,
          medianMsPerAction: 0,
          medianTimeToFirstActionMs: undefined as unknown as number,
          prevTotalActions: 0,
          prevApproveRate: 0,
        }}
      />,
    );
    expect(document.body.innerHTML).not.toContain("NaN");
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });
});
