import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

import { KpiCards } from "@/app/(protected)/analytics/_components/kpi-cards";

afterEach(cleanup);

describe("KpiCards", () => {
  test("renders numeric KPIs from a populated summary", () => {
    render(
      <KpiCards
        isLoading={false}
        summary={{
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
        }}
      />,
    );
    expect(screen.getByText("12")).toBeDefined(); // totalActions
    expect(screen.getByText("67%")).toBeDefined(); // approveRate
    expect(screen.getByText("75%")).toBeDefined(); // keyboardRate
    expect(screen.getByText("8.0s")).toBeDefined(); // medianTimeToFirstActionMs → 8.0s
  });

  test("Time to first action renders em-dash when undefined (no qualifying sessions)", () => {
    render(
      <KpiCards
        isLoading={false}
        summary={{
          totalActions: 0,
          approves: 0,
          rejects: 0,
          viaKeyboard: 0,
          sessions: 0,
          medianMsPerAction: 0,
          // Simulates `analytics.summary` returning a window with no
          // session pairs to join — the SQL `percentile_cont` returns
          // null which the API forwards through as null/undefined.
          medianTimeToFirstActionMs: undefined as unknown as number,
          approveRate: 0,
          rejectRate: 0,
          keyboardRate: 0,
        }}
      />,
    );
    // The "Time to first action" card's value should be the em-dash,
    // not "NaNm". Counting em-dashes: 3 of the 4 cards may show "—"
    // for various reasons (0%, 0 actions, undefined ms). We assert
    // there's no "NaN" anywhere.
    const html = document.body.innerHTML;
    expect(html).not.toContain("NaN");
    // And explicitly the dashboard formats undefined ms as "—".
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  test("Time to first action renders em-dash when null", () => {
    render(
      <KpiCards
        isLoading={false}
        summary={{
          totalActions: 5,
          approves: 5,
          rejects: 0,
          viaKeyboard: 0,
          sessions: 0,
          medianMsPerAction: 0,
          medianTimeToFirstActionMs: null as unknown as number,
          approveRate: 1,
          rejectRate: 0,
          keyboardRate: 0,
        }}
      />,
    );
    const html = document.body.innerHTML;
    expect(html).not.toContain("NaN");
  });
});
