import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DiffRegion } from "../src/components/diff-viewer/layers/regionTypes";
import { RegionListPanel } from "../src/components/diff-viewer/RegionListPanel";
import { useViewerStore } from "../src/components/diff-viewer/useViewerStore";

const mockRegions: DiffRegion[] = [
  {
    id: "r1",
    severity: "minor",
    category: "text",
    bbox: { x: 0, y: 0, width: 10, height: 10 },
    description: "Minor text change",
    source: "l2",
  },
  {
    id: "r2",
    severity: "breaking",
    category: "structural",
    bbox: { x: 0, y: 0, width: 100, height: 100 },
    description: "Breaking structural",
    source: "l2",
  },
  {
    id: "r3",
    severity: "major",
    category: "color",
    bbox: { x: 0, y: 0, width: 50, height: 50 },
    description: "Major color change",
    source: "l2",
  },
];

describe("RegionListPanel", () => {
  beforeEach(() => {
    useViewerStore.setState({ selectedRegionId: null });
  });
  afterEach(() => {
    cleanup();
  });

  it("renders regions severity-sorted (breaking > major > minor)", () => {
    render(<RegionListPanel regions={mockRegions} />);
    const items = screen
      .getAllByRole("button")
      .filter((b) => b.hasAttribute("data-region-id"));
    expect(items.map((b) => b.getAttribute("data-region-id"))).toEqual([
      "r2",
      "r3",
      "r1",
    ]);
  });

  it("clicking a region updates useViewerStore.selectedRegionId", () => {
    render(<RegionListPanel regions={mockRegions} />);
    const items = screen
      .getAllByRole("button")
      .filter((b) => b.hasAttribute("data-region-id"));
    fireEvent.click(items[0]!);
    expect(useViewerStore.getState().selectedRegionId).toBe(
      items[0]!.getAttribute("data-region-id"),
    );
  });

  it("severity chips carry data-severity attribute", () => {
    render(<RegionListPanel regions={mockRegions} />);
    const chips = document.querySelectorAll("[data-severity]");
    expect(chips.length).toBe(3);
    const severities = Array.from(chips).map((c) =>
      c.getAttribute("data-severity"),
    );
    expect(severities).toContain("breaking");
    expect(severities).toContain("major");
    expect(severities).toContain("minor");
  });

  it("L2 regions render a 'Root Cause' badge alongside the severity chip", () => {
    render(<RegionListPanel regions={mockRegions} />);
    const badges = document.querySelectorAll('[data-source-badge="l2"]');
    expect(badges.length).toBe(3);
    expect(
      Array.from(badges).every((b) => b.textContent === "Root Cause"),
    ).toBe(true);
  });

  it("source filter trigger renders with default 'All sources' label", () => {
    render(<RegionListPanel regions={mockRegions} />);
    const trigger = screen.getByTestId("source-filter-trigger");
    expect(trigger.textContent).toBe("All sources");
  });

  it("selecting the L2 source option groups regions by category with headers", async () => {
    const user = userEvent.setup();
    const mixed: DiffRegion[] = [
      ...mockRegions,
      {
        id: "px1",
        severity: "major",
        category: "color",
        bbox: { x: 0, y: 0, width: 50, height: 50 },
        description: "Pixel-only block",
        source: "l1",
      },
    ];
    render(<RegionListPanel regions={mixed} />);
    await user.click(screen.getByTestId("source-filter-trigger"));
    const opt = await screen.findByRole("menuitem", {
      name: "Root Cause (DOM/CSS)",
    });
    await user.click(opt);
    // L1 row should be filtered out.
    expect(document.querySelector('[data-region-id="px1"]')).toBeNull();
    // Grouped wrapper appears and contains a section per category present.
    expect(screen.getByTestId("root-cause-grouped")).toBeTruthy();
    const groups = document.querySelectorAll("[data-root-cause-group]");
    const cats = Array.from(groups).map((g) =>
      g.getAttribute("data-root-cause-group"),
    );
    // The three L2 fixtures cover text, structural, color.
    expect(cats).toContain("structural");
    expect(cats).toContain("text");
    expect(cats).toContain("color");
    // Structural comes before text per L2_CATEGORY_ORDER.
    expect(cats.indexOf("structural")).toBeLessThan(cats.indexOf("text"));
  });

  it("L2 source with zero L2 regions shows the L2-specific empty state", async () => {
    const user = userEvent.setup();
    const onlyL1: DiffRegion[] = [
      {
        id: "px1",
        severity: "major",
        category: "color",
        bbox: { x: 0, y: 0, width: 50, height: 50 },
        description: "Pixel-only block",
        source: "l1",
      },
    ];
    render(<RegionListPanel regions={onlyL1} />);
    await user.click(screen.getByTestId("source-filter-trigger"));
    const opt = await screen.findByRole("menuitem", {
      name: "Root Cause (DOM/CSS)",
    });
    await user.click(opt);
    const empty = screen.getByTestId("regions-empty-state");
    expect(empty.textContent).toContain("No DOM/CSS-level changes detected");
  });

  it("source='dynamic_text' rows hidden by default; visible when toggle on", () => {
    const regions: DiffRegion[] = [
      {
        id: "dt1",
        severity: "none",
        category: "text",
        bbox: { x: 0, y: 0, width: 50, height: 20 },
        description: 'Dynamic text matched: "Mar 5, 2026"',
        source: "dynamic_text",
        ocrText: "Mar 5, 2026",
        ocrMatched: true,
      },
    ];
    render(<RegionListPanel regions={regions} />);
    // Default: synthetic audit row is hidden.
    expect(document.querySelector('[data-source="dynamic_text"]')).toBeNull();
    // Toggle on → row appears.
    const toggleInput = screen
      .getByTestId("show-suppressed-toggle")
      .querySelector("input")!;
    fireEvent.click(toggleInput);
    expect(
      document.querySelector('[data-source="dynamic_text"]'),
    ).not.toBeNull();
  });
});
