import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DiffRegion } from "../src/components/diff-viewer/layers/regionTypes";
import { RegionListPanel } from "../src/components/diff-viewer/RegionListPanel";
import { useViewerStore } from "../src/components/diff-viewer/useViewerStore";
import { SEVERITY_STYLE } from "../src/lib/severity-style";

const mockRegions: DiffRegion[] = [
  {
    id: "r1",
    severity: "minor",
    category: "text",
    bbox: { x: 0, y: 0, width: 10, height: 10 },
    description: "Minor text change",
    source: "l1_pixel",
  },
  {
    id: "r2",
    severity: "breaking",
    category: "structural",
    bbox: { x: 0, y: 0, width: 100, height: 100 },
    description: "Breaking structural",
    source: "l1_pixel",
  },
  {
    id: "r3",
    severity: "major",
    category: "color",
    bbox: { x: 0, y: 0, width: 50, height: 50 },
    description: "Major color change",
    source: "l1_pixel",
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

  it("severity chips wear the shared severity map's classes", () => {
    render(<RegionListPanel regions={mockRegions} />);
    const chips = document.querySelectorAll<HTMLElement>("[data-severity]");
    for (const chip of chips) {
      const sev = chip.getAttribute(
        "data-severity",
      ) as keyof typeof SEVERITY_STYLE;
      for (const cls of SEVERITY_STYLE[sev].split(" ")) {
        expect(chip.classList.contains(cls), `${sev}: ${cls}`).toBe(true);
      }
    }
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

  it("renders l1_pixel (image) regions in the list", () => {
    const regions = [
      {
        id: "l1-pixel-0",
        severity: "major",
        category: "image",
        bbox: { x: 10, y: 10, width: 240, height: 240 },
        description: "Pixel diff cluster (30 tiles, 240×240)",
        source: "l1_pixel",
      },
    ];
    render(<RegionListPanel regions={regions} vlmDescription={null} />);
    expect(screen.getByText(/Regions \(1\)/)).toBeTruthy();
  });

  it("source='l1_pixel' rows appear in the flat list", () => {
    // Image-first P1 (ADR-047): l1_pixel regions are now surfaced as list
    // rows so reviewers can see pixel-cluster descriptions. They're no longer
    // canvas-only. dynamic_text stays hidden by default (separate toggle).
    const regions: DiffRegion[] = [
      {
        id: "lp1",
        severity: "minor",
        category: "image",
        bbox: { x: 100, y: 100, width: 96, height: 96 },
        description: "Pixel diff cluster (3 tiles, 144×48)",
        source: "l1_pixel",
      },
      {
        id: "l1real",
        severity: "breaking",
        category: "image",
        bbox: { x: 0, y: 0, width: 50, height: 50 },
        description: "Strict-tolerance breach",
        source: "l1",
      },
    ];
    render(<RegionListPanel regions={regions} />);
    // Both regions visible: l1_pixel, l1.
    expect(document.querySelector('[data-region-id="lp1"]')).not.toBeNull();
    expect(document.querySelector('[data-region-id="l1real"]')).not.toBeNull();
    expect(screen.getByText(/Regions \(2\)/)).toBeTruthy();
  });

  it("declutters image rows: size chip, no 'tiles' jargon, no 'image' label", () => {
    const regions: DiffRegion[] = [
      {
        id: "img1",
        severity: "cosmetic",
        category: "image",
        bbox: { x: 0, y: 0, width: 240, height: 240 },
        description: "Pixel diff cluster (30 tiles, 240×240)",
        source: "l1_pixel",
      },
    ];
    render(<RegionListPanel regions={regions} />);
    const row = document.querySelector(
      '[data-region-id="img1"]',
    ) as HTMLElement;
    // size surfaces as its own chip…
    expect(row.querySelector('[data-testid="region-size"]')?.textContent).toBe(
      "240×240",
    );
    // …and the engine jargon + redundant "image" category label are gone.
    expect(row.textContent).not.toMatch(/tiles?/i);
    expect(row.textContent).not.toMatch(/\bimage\b/i);
    expect(row.textContent).toContain("Pixel diff cluster");
  });

  it("keeps the category label for non-image categories", () => {
    // mockRegions[0] is category "text" → the label should still render.
    render(<RegionListPanel regions={[mockRegions[0]!]} />);
    expect(screen.getByText("text")).toBeTruthy();
  });

  const dupCluster = (id: string, x: number): DiffRegion => ({
    id,
    severity: "cosmetic",
    category: "image",
    bbox: { x, y: 0, width: 192, height: 96 },
    description: "Pixel diff cluster (7 tiles, 192×96)",
    source: "l1_pixel",
  });

  it("collapses duplicate clusters into one '×N' row", () => {
    const regions = [
      dupCluster("a", 0),
      dupCluster("b", 200),
      dupCluster("c", 400),
    ];
    render(<RegionListPanel regions={regions} />);
    const rows = screen
      .getAllByRole("button")
      .filter((b) => b.hasAttribute("data-region-id"));
    expect(rows).toHaveLength(1); // 3 identical clusters → 1 row
    expect(screen.getByTestId("region-count").textContent).toBe("×3");
    // header still reports the true total region count (matches the stepper)
    expect(screen.getByText(/Regions \(3\)/)).toBeTruthy();
  });

  it("does not merge clusters that differ in size", () => {
    const regions = [
      dupCluster("a", 0),
      { ...dupCluster("b", 0), bbox: { x: 0, y: 0, width: 64, height: 64 } },
    ];
    render(<RegionListPanel regions={regions} />);
    const rows = screen
      .getAllByRole("button")
      .filter((b) => b.hasAttribute("data-region-id"));
    expect(rows).toHaveLength(2); // different size → distinct rows
    expect(screen.queryByTestId("region-count")).toBeNull(); // no ×N
  });

  it("treats a non-representative member selection as selecting the row", () => {
    useViewerStore.setState({ selectedRegionId: "c" });
    render(
      <RegionListPanel
        regions={[
          dupCluster("a", 0),
          dupCluster("b", 200),
          dupCluster("c", 400),
        ]}
      />,
    );
    const row = screen
      .getAllByRole("button")
      .find((b) => b.hasAttribute("data-region-id"))!;
    expect(row.getAttribute("aria-pressed")).toBe("true");
  });
});
