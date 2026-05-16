import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
});
