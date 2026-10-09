// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { runStatusSchema } from "@furan/shared-types";
import { describe, expect, it } from "vitest";

import { STATUS_STYLE, statusStyle } from "../src/lib/status-style";

const CLASS_FIELDS = ["dot", "fill", "accent", "text", "pill"] as const;

describe("STATUS_STYLE", () => {
  for (const status of runStatusSchema.options) {
    it(`${status} has a label, tooltip, icon and all class fields`, () => {
      const s = STATUS_STYLE[status];
      expect(s.label.length).toBeGreaterThan(0);
      expect(s.tooltip.length).toBeGreaterThan(0);
      // Lucide icons are forwardRef components (objects), not plain functions.
      expect(s.icon).toBeTruthy();
      for (const f of CLASS_FIELDS) {
        expect(s[f].length, `${status}.${f}`).toBeGreaterThan(0);
      }
    });
  }

  it("keeps unresolved and aborted on distinct tokens", () => {
    expect(STATUS_STYLE.unresolved.pill).toContain("status-unresolved");
    expect(STATUS_STYLE.unresolved.pill).not.toContain("status-aborted");
    expect(STATUS_STYLE.aborted.pill).toContain("status-aborted");
    expect(STATUS_STYLE.aborted.pill).not.toContain("status-unresolved");
  });

  it("maps new and empty to the neutral token", () => {
    for (const s of ["new", "empty"] as const) {
      for (const f of CLASS_FIELDS) {
        expect(STATUS_STYLE[s][f], `${s}.${f}`).toContain("status-neutral");
      }
    }
  });

  it("uses the exact class literals for passed", () => {
    expect(STATUS_STYLE.passed).toMatchObject({
      dot: "bg-status-passed",
      fill: "fill-status-passed",
      accent: "border-l-status-passed",
      text: "text-status-passed-text",
      pill: "border border-status-passed/25 bg-status-passed/10 text-status-passed-text",
    });
  });

  it("falls back to empty for an unknown status", () => {
    expect(statusStyle("bogus")).toBe(STATUS_STYLE.empty);
  });

  it("returns the matching entry for a known status", () => {
    expect(statusStyle("failed")).toBe(STATUS_STYLE.failed);
  });

  it("builds no class name by template interpolation", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../src/lib/status-style.ts", import.meta.url)),
      "utf8",
    );
    expect(src).not.toContain("${");
  });
});
