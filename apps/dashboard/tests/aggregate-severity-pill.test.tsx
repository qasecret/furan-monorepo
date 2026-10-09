import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";

import {
  AggregateSeverityPill,
  aggregateSeverity,
} from "../src/components/aggregate-severity-pill";
import { SEVERITY_STYLE } from "../src/lib/severity-style";

describe("aggregateSeverity", () => {
  test("empty regions → null", () => {
    expect(aggregateSeverity([])).toBeNull();
  });

  test("all 'none' severity → null", () => {
    expect(
      aggregateSeverity([{ severity: "none" }, { severity: "none" }]),
    ).toBeNull();
  });

  test("mixed severities → highest + count of that severity", () => {
    expect(
      aggregateSeverity([
        { severity: "minor" },
        { severity: "breaking" },
        { severity: "major" },
        { severity: "breaking" },
        { severity: "cosmetic" },
      ]),
    ).toEqual({ severity: "breaking", count: 2 });
  });

  test("only major + minor → major + count", () => {
    expect(
      aggregateSeverity([
        { severity: "major" },
        { severity: "major" },
        { severity: "major" },
        { severity: "minor" },
      ]),
    ).toEqual({ severity: "major", count: 3 });
  });

  test("unknown severity string → treated as 'none'", () => {
    expect(
      aggregateSeverity([
        { severity: "garbage" as never },
        { severity: "minor" },
      ]),
    ).toEqual({ severity: "minor", count: 1 });
  });
});

describe("AggregateSeverityPill", () => {
  test("renders nothing when regions are empty", () => {
    const { container } = render(<AggregateSeverityPill regions={[]} />);
    expect(container.firstChild).toBeNull();
  });

  test("renders nothing when max severity is 'none'", () => {
    const { container } = render(
      <AggregateSeverityPill
        regions={[{ severity: "none" }, { severity: "none" }]}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  test("renders 'breaking' pill with count and emoji", () => {
    render(
      <AggregateSeverityPill
        regions={[{ severity: "breaking" }, { severity: "minor" }]}
      />,
    );
    const pill = screen.getByTestId("aggregate-severity-pill-breaking");
    expect(pill.textContent).toMatch(/🔴/);
    expect(pill.textContent).toMatch(/1 breaking/);
  });

  test("renders 'major' pill when no breaking present", () => {
    render(
      <AggregateSeverityPill
        regions={[
          { severity: "major" },
          { severity: "major" },
          { severity: "minor" },
        ]}
      />,
    );
    const pill = screen.getByTestId("aggregate-severity-pill-major");
    expect(pill.textContent).toMatch(/2 major/);
  });

  test.each(["breaking", "major", "minor", "cosmetic"] as const)(
    "'%s' pill wears the shared severity chip, as the viewer's badges do",
    (sev) => {
      const { container } = render(
        <AggregateSeverityPill regions={[{ severity: sev }]} />,
      );
      const pill = container.querySelector<HTMLElement>(
        `[data-testid="aggregate-severity-pill-${sev}"]`,
      )!;
      for (const cls of SEVERITY_STYLE[sev].split(" ")) {
        expect(pill.classList.contains(cls), cls).toBe(true);
      }
    },
  );
});
