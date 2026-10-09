import { render } from "@testing-library/react";
import { describe, expect, test } from "vitest";

import { DiffPercentSparkline } from "../src/components/diff-percent-sparkline";

describe("DiffPercentSparkline", () => {
  test("empty runs → renders nothing", () => {
    const { container } = render(<DiffPercentSparkline runs={[]} />);
    expect(container.firstChild).toBeNull();
  });

  test("single run → one circle, no polyline", () => {
    const { container } = render(
      <DiffPercentSparkline
        runs={[{ id: "r1", status: "passed", diffPercent: 1.5 }]}
      />,
    );
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg!.querySelectorAll("circle")).toHaveLength(1);
    expect(svg!.querySelector("polyline")).toBeNull();
  });

  test("multiple runs → polyline + N circles", () => {
    const { container } = render(
      <DiffPercentSparkline
        runs={[
          { id: "r1", status: "passed", diffPercent: 0 },
          { id: "r2", status: "unresolved", diffPercent: 2 },
          { id: "r3", status: "failed", diffPercent: 5 },
        ]}
      />,
    );
    const svg = container.querySelector("svg");
    expect(svg!.querySelectorAll("circle")).toHaveLength(3);
    expect(svg!.querySelector("polyline")).not.toBeNull();
  });

  test("trend line uses fg-muted so it reads in both themes", () => {
    // edge-strong measured 1.5:1 (light) / 1.7:1 (dark) against the page —
    // below the 3:1 a data line needs. fg-muted is 5.4:1 / 5.8:1.
    const { container } = render(
      <DiffPercentSparkline
        runs={[
          { id: "r1", status: "passed", diffPercent: 0 },
          { id: "r2", status: "unresolved", diffPercent: 2 },
        ]}
      />,
    );
    const line = container.querySelector("polyline")!;
    expect(line.getAttribute("stroke")).toBe("currentColor");
    expect(line.getAttribute("class")).toBe("text-fg-muted");
  });

  test("null diffPercent → dot at baseline (y = padY + plotH)", () => {
    const { container } = render(
      <DiffPercentSparkline
        runs={[{ id: "r1", status: "passed", diffPercent: null }]}
      />,
    );
    const circle = container.querySelector("circle");
    // padY = 16, plotH = 80 - 2*16 = 48, so baseline cy = 16 + 48 = 64
    expect(circle!.getAttribute("cy")).toBe("64");
  });

  test("diffPercent >= 10 clips to top (y = padY)", () => {
    const { container } = render(
      <DiffPercentSparkline
        runs={[{ id: "r1", status: "failed", diffPercent: 50 }]}
      />,
    );
    const circle = container.querySelector("circle");
    // padY = 16 → top of plot area
    expect(circle!.getAttribute("cy")).toBe("16");
  });

  test("aria-label summarizes counts + latest diff", () => {
    const { container } = render(
      <DiffPercentSparkline
        runs={[
          { id: "r1", status: "passed", diffPercent: 0 },
          { id: "r2", status: "passed", diffPercent: 0 },
          { id: "r3", status: "unresolved", diffPercent: 2.1 },
          { id: "r4", status: "failed", diffPercent: 5.0 },
        ]}
      />,
    );
    const svg = container.querySelector("svg");
    const label = svg!.getAttribute("aria-label") ?? "";
    expect(label).toMatch(/4 runs/);
    expect(label).toMatch(/2 passed/);
    expect(label).toMatch(/1 unresolved/);
    expect(label).toMatch(/1 failed/);
    expect(label).toMatch(/5\.00%/); // latest diff = last run's diffPercent (5.0)
  });

  test("status colors map correctly", () => {
    const { container } = render(
      <DiffPercentSparkline
        runs={[
          { id: "r1", status: "passed", diffPercent: 0 },
          { id: "r2", status: "unresolved", diffPercent: 0 },
          { id: "r3", status: "failed", diffPercent: 0 },
        ]}
      />,
    );
    const circles = container.querySelectorAll("circle");
    expect(circles[0]!.getAttribute("class")).toMatch(/fill-status-passed/);
    expect(circles[1]!.getAttribute("class")).toMatch(/fill-status-unresolved/);
    expect(circles[2]!.getAttribute("class")).toMatch(/fill-status-failed/);
  });
});
