// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { Severity } from "../src/components/diff-viewer/layers/regionTypes";
import { SEVERITY_STYLE } from "../src/lib/severity-style";

const HUED = ["breaking", "major", "minor", "cosmetic"] as const;

describe("SEVERITY_STYLE", () => {
  it("has a chip for every severity", () => {
    const all: Severity[] = [...HUED, "none"];
    expect(Object.keys(SEVERITY_STYLE).sort()).toEqual([...all].sort());
  });

  it("gives hued severities an opaque -100 chip with -800 text and a -300 border (Ruling R18)", () => {
    for (const sev of HUED) {
      const classes = SEVERITY_STYLE[sev].split(" ");
      const hue = /^bg-([a-z]+)-100$/.exec(
        classes.find((c) => c.startsWith("bg-")) ?? "",
      )?.[1];
      expect(hue, sev).toBeTruthy();
      expect(classes, sev).toContain(`text-${hue}-800`);
      expect(classes, sev).toContain(`border-${hue}-300`);
      // Same chip in both themes: no dark: override, no translucent tint.
      expect(SEVERITY_STYLE[sev], sev).not.toMatch(/dark:|\/\d+/);
    }
  });

  it("gives each hued severity its own hue", () => {
    const hues = HUED.map(
      (sev) => /\bbg-([a-z]+)-100\b/.exec(SEVERITY_STYLE[sev])?.[1],
    );
    expect(new Set(hues).size).toBe(HUED.length);
  });

  it("keeps the absence of severity neutral, on tokens", () => {
    expect(SEVERITY_STYLE.none).toMatch(/\bbg-edge\b/);
    expect(SEVERITY_STYLE.none).toMatch(/\btext-fg-secondary\b/);
  });

  it("keeps the none chip off the hover surface so it shows in a hovered or selected row", () => {
    // Region rows paint bg-hover when selected (and bg-hover/50 on hover); a
    // bg-hover chip would vanish into them.
    expect(SEVERITY_STYLE.none).not.toMatch(/\bbg-hover\b/);
  });

  it("varies the border style so meaning doesn't rest on colour alone", () => {
    expect(SEVERITY_STYLE.cosmetic).toMatch(/\bborder-dashed\b/);
    expect(SEVERITY_STYLE.none).toMatch(/\bborder-dotted\b/);
    // The dotted border must differ from the none chip's bg-edge fill, or the
    // shape cue is invisible.
    expect(SEVERITY_STYLE.none).toMatch(/\bborder-edge-strong\b/);
  });

  it("builds no class name by template interpolation", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../src/lib/severity-style.ts", import.meta.url)),
      "utf8",
    );
    expect(src).not.toContain("${");
  });
});
