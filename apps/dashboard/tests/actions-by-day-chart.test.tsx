import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, test } from "vitest";

import { ActionsByDayChart } from "@/app/(protected)/analytics/_components/actions-by-day-chart";

// recharts hits ResizeObserver, which jsdom lacks. Mock it out.
beforeAll(() => {
  class MockResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  global.ResizeObserver =
    MockResizeObserver as unknown as typeof ResizeObserver;
});

afterEach(cleanup);

describe("ActionsByDayChart", () => {
  test("shows a skeleton while loading", () => {
    render(<ActionsByDayChart items={[]} isLoading={true} />);
    expect(screen.getByTestId("chart-skeleton")).toBeDefined();
  });

  test("shows EmptyState when there are no actions", () => {
    render(<ActionsByDayChart items={[]} isLoading={false} />);
    expect(screen.getByTestId("empty-state")).toBeDefined();
    expect(screen.getByText("No actions in this window.")).toBeDefined();
  });
});
