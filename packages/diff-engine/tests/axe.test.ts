import { describe, it, expect } from "vitest";

import { mapImpact, runAxe, tagsFor } from "../src/axe.js";

/**
 * Unit tests for the Tier 2.5 pure helpers. The end-to-end
 * `runAxe(html, options)` integration requires a Node process
 * with no pre-existing `window`/`document` globals — axe-core's
 * jsdom path captures globals at module-load time, and setting the
 * vitest environment to jsdom (or even the default node env with
 * a populated globalThis) creates cross-realm `instanceof` failures
 * in axe-core's `_isContextSpec` check. The diff-worker integration
 * test (boots a real worker against a Postgres+Redis fixture) covers
 * axe.run end-to-end including the post-axe handler wire-up. The
 * lightweight `axeTarget attachment` block below also calls `runAxe`
 * directly to pin the new field's contract — this works because
 * `axe.ts` now manages its own `globalThis.window`/`document` setup
 * with try/finally restore, so jsdom no longer leaks between
 * checkpoints.
 *
 * These tests pin the rule-selection + severity-mapping logic that
 * decides which violations surface and how severe they look — that's
 * the part most worth defending against drift.
 */
describe("tagsFor — Tier 2.5 rule selection", () => {
  it("AA + WCAG_2_0 selects wcag2a + wcag2aa", () => {
    const tags = tagsFor({ level: "AA", version: "WCAG_2_0" });
    expect(tags).toEqual(["wcag2a", "wcag2aa"]);
  });

  it("AAA + WCAG_2_0 adds wcag2aaa", () => {
    const tags = tagsFor({ level: "AAA", version: "WCAG_2_0" });
    expect(tags).toEqual(["wcag2a", "wcag2aa", "wcag2aaa"]);
  });

  it("AA + WCAG_2_1 adds 2.1 tags", () => {
    const tags = tagsFor({ level: "AA", version: "WCAG_2_1" });
    expect(tags).toEqual(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]);
  });

  it("AAA + WCAG_2_1 unions all levels", () => {
    const tags = tagsFor({ level: "AAA", version: "WCAG_2_1" });
    expect(tags).toEqual([
      "wcag2a",
      "wcag2aa",
      "wcag2aaa",
      "wcag21a",
      "wcag21aa",
      "wcag21aaa",
    ]);
  });

  it("AAA always supersets AA on tag count", () => {
    for (const v of ["WCAG_2_0", "WCAG_2_1"] as const) {
      const aa = tagsFor({ level: "AA", version: v });
      const aaa = tagsFor({ level: "AAA", version: v });
      expect(aaa.length).toBeGreaterThan(aa.length);
      // every AA tag is also in AAA
      for (const tag of aa) expect(aaa).toContain(tag);
    }
  });

  it("WCAG_2_1 always supersets WCAG_2_0 on tag count", () => {
    for (const l of ["AA", "AAA"] as const) {
      const v20 = tagsFor({ level: l, version: "WCAG_2_0" });
      const v21 = tagsFor({ level: l, version: "WCAG_2_1" });
      expect(v21.length).toBeGreaterThan(v20.length);
      for (const tag of v20) expect(v21).toContain(tag);
    }
  });
});

describe("mapImpact — Tier 2.5 severity mapping", () => {
  it("critical → breaking", () => {
    expect(mapImpact("critical")).toBe("breaking");
  });
  it("serious → major", () => {
    expect(mapImpact("serious")).toBe("major");
  });
  it("moderate → minor", () => {
    expect(mapImpact("moderate")).toBe("minor");
  });
  it("minor → cosmetic", () => {
    expect(mapImpact("minor")).toBe("cosmetic");
  });
  it("null impact falls back to minor (axe-core sometimes omits impact)", () => {
    expect(mapImpact(null)).toBe("minor");
    expect(mapImpact(undefined)).toBe("minor");
  });
});

describe("runAxe: axeTarget attachment", () => {
  it("attaches axe-core's target array to emitted regions", async () => {
    // A document with a deliberate accessibility violation: an <img>
    // without alt text. axe-core's "image-alt" rule fires on this and
    // reports the violation node via a stable target selector.
    const dom = `<!doctype html><html lang="en"><head><title>t</title></head>
<body><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB
AQMAAAAl21bKAAAAA1BMVEUAAACnej3aAAAAC0lEQVR4AWMYBQAAAQAB7zXmDgAAAABJRU5ErkJggg=="></body></html>`;
    const regions = await runAxe(dom, { level: "AA", version: "WCAG_2_1" });
    expect(regions.length).toBeGreaterThan(0);
    for (const r of regions) {
      expect(r.source).toBe("axe");
      expect(r.axeTarget).toBeDefined();
      expect(Array.isArray(r.axeTarget)).toBe(true);
      expect((r.axeTarget as string[]).length).toBeGreaterThan(0);
    }
  });
});
