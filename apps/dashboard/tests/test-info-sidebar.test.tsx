import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

// Isolate the sidebar's tab logic + metadata rendering from the heavy child
// panels (region list, comment editor) and their trpc dependencies.
vi.mock("@/components/diff-viewer/RegionListPanel", () => ({
  RegionListPanel: () => <div data-testid="region-list-panel" />,
}));
vi.mock("@/components/diff-viewer/RunCommentPanel", () => ({
  RunCommentPanel: ({ embedded }: { embedded?: boolean }) => (
    <div data-testid="comment-panel">{embedded ? "embedded" : "modal"}</div>
  ),
}));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    baselines: {
      listForVariation: {
        useQuery: () => ({ data: { items: [] }, isLoading: false }),
      },
    },
  },
}));

import { TestInfoSidebar } from "@/components/diff-viewer/TestInfoSidebar";

afterEach(cleanup);

const baseProps = {
  test: "Pricing Page",
  stepLabel: "1/2 Monthly Plans",
  match: "strict",
  app: "Marketing Website",
  branch: "fix/pricing-page",
  os: "macOS 14",
  browser: "Chrome 131.0",
  viewport: "1440x900",
  startedAt: "2024-11-19T11:02:00.000Z",
  duration: "00:00:04",
  runBy: "Mike Larson",
  regions: [],
  vlmDescription: null,
  testVariationId: null,
  currentBaselineKey: null,
  runId: "r1",
};

describe("TestInfoSidebar", () => {
  test("INFO tab shows test details / environment / execution + region list", () => {
    render(<TestInfoSidebar {...baseProps} />);
    expect(screen.getByText("Pricing Page")).toBeDefined();
    expect(screen.getByText("1/2 Monthly Plans")).toBeDefined();
    expect(screen.getByText("Strict")).toBeDefined(); // match is capitalized
    expect(screen.getByText("Marketing Website")).toBeDefined();
    expect(screen.getByText("Chrome 131.0")).toBeDefined();
    expect(screen.getByText("1440x900")).toBeDefined();
    expect(screen.getByText("00:00:04")).toBeDefined();
    expect(screen.getByText("Mike Larson")).toBeDefined();
    expect(screen.getByTestId("region-list-panel")).toBeDefined();
  });

  test("null metadata values fall back to an em dash", () => {
    render(<TestInfoSidebar {...baseProps} os={null} match={null} />);
    // OS (val) and Match (cap) both render "—"; nothing else is null.
    expect(screen.getAllByText("—").length).toBe(2);
  });

  test("COMMENTS tab embeds the comment editor and hides the region list", () => {
    render(<TestInfoSidebar {...baseProps} />);
    fireEvent.click(screen.getByTestId("info-tab-comments"));
    expect(screen.getByTestId("comment-panel").textContent).toBe("embedded");
    expect(screen.queryByTestId("region-list-panel")).toBeNull();
  });

  test("HISTORY tab explains itself when the checkpoint has no variation", () => {
    render(<TestInfoSidebar {...baseProps} testVariationId={null} />);
    fireEvent.click(screen.getByTestId("info-tab-history"));
    expect(
      screen.getByText(/History will appear once a baseline/i),
    ).toBeDefined();
  });
});
