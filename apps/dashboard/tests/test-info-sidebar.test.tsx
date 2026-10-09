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

import type { DiffRegion } from "@/components/diff-viewer/layers/regionTypes";
import { TestInfoSidebar } from "@/components/diff-viewer/TestInfoSidebar";
import { SEVERITY_STYLE } from "@/lib/severity-style";

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
  pixelDiffPercent: 1.18,
  regions: [],
  vlmDescription: null,
  testVariationId: null,
  currentBaselineKey: null,
  runId: "r1",
};

describe("TestInfoSidebar", () => {
  test("INFO tab shows the summary stat cards (pixel diff / regions / severity)", () => {
    render(
      <TestInfoSidebar {...baseProps} pixelDiffPercent={1.18} regions={[]} />,
    );
    expect(screen.getByTestId("info-stat-cards")).toBeDefined();
    expect(screen.getByText("1.18%")).toBeDefined();
    expect(screen.getByText("Pixel diff")).toBeDefined();
    expect(screen.getByText("None")).toBeDefined(); // no regions → severity None
  });

  const region = (id: string, severity: string): DiffRegion => ({
    id,
    severity,
    category: "image",
    bbox: { x: 0, y: 0, width: 10, height: 10 },
    description: "",
    source: "l1_pixel",
  });

  test.each([
    ["Breaking", "breaking", ["minor", "breaking", "cosmetic"]],
    ["Major", "major", ["major", "minor"]],
    ["Minor", "minor", ["minor", "none"]],
    ["Cosmetic", "cosmetic", ["cosmetic", "bogus"]],
    ["None", "none", []],
    ["None", "none", ["none", "none"]],
  ] as const)(
    "severity stat shows %s on the shared severity chip",
    (label, sev, severities) => {
      render(
        <TestInfoSidebar
          {...baseProps}
          regions={severities.map((s, i) => region(`r${i}`, s))}
        />,
      );
      const stat = screen.getByText(label);
      for (const cls of SEVERITY_STYLE[sev].split(" ")) {
        expect(stat.classList.contains(cls), `${sev}: ${cls}`).toBe(true);
      }
    },
  );

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
