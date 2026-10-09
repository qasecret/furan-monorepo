import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

import { LandingProductPreview } from "../src/components/landing/landing-product-preview";
import { STATUS_STYLE } from "../src/lib/status-style";

/** The status icon rendered beside a mock run row's label. */
function runIcon(label: string): Element {
  const row = screen.getByText(label).parentElement;
  const icon = row?.querySelector("svg");
  if (!icon) throw new Error(`no status icon beside ${label}`);
  return icon;
}

function classesOf(el: Element): string[] {
  return (el.getAttribute("class") ?? "").split(/\s+/);
}

describe("LandingProductPreview", () => {
  afterEach(() => cleanup());

  test("mock runs show the app's status icon colours, not ad-hoc hues", () => {
    render(<LandingProductPreview />);
    expect(classesOf(runIcon("PR-402: Redesign nav"))).toContain(
      STATUS_STYLE.failed.text,
    );
    expect(classesOf(runIcon("PR-401: Fix hero padding"))).toContain(
      STATUS_STYLE.passed.text,
    );
    // Was an amber dot, which colour alone can't tell apart from "aborted".
    expect(classesOf(runIcon("PR-399: Bump dependencies"))).toContain(
      STATUS_STYLE.unresolved.text,
    );
  });

  test("the changes chip is the failed status pill", () => {
    render(<LandingProductPreview />);
    const chip = screen.getByText(/2 changes/);
    for (const cls of STATUS_STYLE.failed.pill.split(" ")) {
      expect(classesOf(chip)).toContain(cls);
    }
  });

  test("the region label is a pastel chip that reads at AA (Ruling R18)", () => {
    render(<LandingProductPreview />);
    const label = classesOf(screen.getByText("Padding +8px"));
    expect(label).toEqual(
      expect.arrayContaining(["bg-red-100", "text-red-800"]),
    );
    // White on red-500 measured 3.8:1.
    expect(label).not.toContain("text-white");
  });

  test("the frame and both page cards float on the overlay elevation (Ruling R22)", () => {
    const { container } = render(<LandingProductPreview />);
    const floating = container.querySelectorAll(".shadow-overlay");
    expect(floating).toHaveLength(3);
    for (const el of floating) expect(classesOf(el)).toContain("bg-raised");
    expect(container.querySelector(".shadow-raised")).toBeNull();
  });

  test("uses no raw neutral palette, dark: colour or px font size", () => {
    const { container } = render(<LandingProductPreview />);
    expect(container.innerHTML).not.toMatch(
      /\bdark:|\b(?:zinc|gray|slate|neutral|stone)-\d|text-\[\d+px\]/,
    );
  });
});
