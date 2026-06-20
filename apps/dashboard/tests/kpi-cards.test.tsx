import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

import { KpiCards } from "@/app/(protected)/analytics/_components/kpi-cards";

afterEach(cleanup);

// Counts kept < 1000 so toLocaleString() has no locale-dependent separators.
const summary = {
  totalActions: 284,
  approves: 190,
  rejects: 94,
  sessions: 92,
  approveRate: 0.67,
  keyboardRate: 0.75,
  medianMsPerAction: 4500,
  medianTimeToFirstActionMs: 8000,
};

describe("KpiCards", () => {
  test("renders six metric tiles with the surfaced values", () => {
    render(<KpiCards summary={summary} isLoading={false} />);
    expect(screen.getByText("Actions")).toBeDefined();
    expect(screen.getByText("284")).toBeDefined();
    expect(screen.getByText("Approve rate")).toBeDefined();
    expect(screen.getByText("67%")).toBeDefined();
    expect(screen.getByText("190 approve · 94 reject")).toBeDefined();
    expect(screen.getByText("Keyboard")).toBeDefined();
    expect(screen.getByText("75%")).toBeDefined();
    expect(screen.getByText("Sessions")).toBeDefined();
    expect(screen.getByText("92")).toBeDefined();
    expect(screen.getByText("Median time / action")).toBeDefined();
    expect(screen.getByText("4.5s")).toBeDefined();
    expect(screen.getByText("Time to first action")).toBeDefined();
    expect(screen.getByText("8.0s")).toBeDefined();
  });

  test("shows a skeleton per tile while loading", () => {
    render(<KpiCards summary={undefined} isLoading={true} />);
    expect(screen.getAllByTestId("kpi-skeleton")).toHaveLength(6);
  });

  // Regression: the analytics SQL percentiles return null for a window with
  // no qualifying rows, so medianMsPerAction / medianTimeToFirstActionMs can
  // arrive null or undefined. fmtMs must render "—", never "NaNm" / "NaNs".
  test("renders an em-dash (never NaN) for undefined time fields", () => {
    render(
      <KpiCards
        isLoading={false}
        summary={{
          totalActions: 0,
          approves: 0,
          rejects: 0,
          sessions: 0,
          approveRate: 0,
          keyboardRate: 0,
          medianMsPerAction: 0,
          medianTimeToFirstActionMs: undefined as unknown as number,
        }}
      />,
    );
    expect(document.body.innerHTML).not.toContain("NaN");
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  test("renders an em-dash when time-to-first-action is null", () => {
    render(
      <KpiCards
        isLoading={false}
        summary={{
          totalActions: 5,
          approves: 5,
          rejects: 0,
          sessions: 0,
          approveRate: 1,
          keyboardRate: 0,
          medianMsPerAction: 0,
          medianTimeToFirstActionMs: null as unknown as number,
        }}
      />,
    );
    expect(document.body.innerHTML).not.toContain("NaN");
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });
});
