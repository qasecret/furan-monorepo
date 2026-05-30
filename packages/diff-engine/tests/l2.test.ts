import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

import { runL2 } from "../src/l2.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = (n: string) =>
  readFileSync(join(__dirname, "fixtures", n), "utf8");

describe("runL2 — route forwarding", () => {
  it("includes `route` on each L2 DiffRegion so the worker can resolve bboxes", async () => {
    const baseline = `<html><body><div>hi</div></body></html>`;
    const candidate = `<html><body><div>HELLO</div></body></html>`;
    const regions = await runL2(baseline, candidate);

    expect(regions.length).toBeGreaterThan(0);
    // At least one region should have a non-empty route (the text node
    // change inside body > div).
    const withRoute = regions.find((r) => r.route && r.route.length > 0);
    expect(withRoute).toBeDefined();
    expect(Array.isArray(withRoute!.route)).toBe(true);
  });
});

describe("runL2", () => {
  it("detects text change as 'text' category", async () => {
    const regions = await runL2(
      FIXTURE("dom-baseline.html"),
      FIXTURE("dom-text-change.html"),
    );
    expect(regions.length).toBeGreaterThan(0);
    const textRegion = regions.find((r) => r.category === "text");
    expect(textRegion).toBeDefined();
    expect(textRegion!.description).toMatch(/Buy now|Get started/);
  });

  it("detects structural insertion as 'structural' category", async () => {
    const regions = await runL2(
      FIXTURE("dom-baseline.html"),
      FIXTURE("dom-structural-change.html"),
    );
    expect(regions.some((r) => r.category === "structural")).toBe(true);
  });

  it("returns [] for identical DOMs", async () => {
    const same = FIXTURE("dom-baseline.html");
    const regions = await runL2(same, same);
    expect(regions).toEqual([]);
  });
});

describe("runL2 — ignoreDisplacements (Tier 1.4)", () => {
  // diff-dom emits `relocateGroup` when siblings of different node
  // types are reordered as a group. Empirically (verified against
  // diff-dom 5.x), `<h1/><img/><p/>` → `<img/><h1/><p/>` produces
  // exactly one relocateGroup op.
  const baseline = `<html><body><h1>title</h1><img src="a.png"/><p>copy</p></body></html>`;
  const candidate = `<html><body><img src="a.png"/><h1>title</h1><p>copy</p></body></html>`;

  it("by default, regions include relocateGroup-derived 'Element relocated'", async () => {
    const regions = await runL2(baseline, candidate);
    const relocations = regions.filter(
      (r) => r.description === "Element relocated",
    );
    expect(relocations.length).toBeGreaterThan(0);
  });

  it("with ignoreDisplacements=true, 'Element relocated' regions are dropped", async () => {
    const regions = await runL2(baseline, candidate, {
      ignoreDisplacements: true,
    });
    const relocations = regions.filter(
      (r) => r.description === "Element relocated",
    );
    expect(relocations.length).toBe(0);
  });

  it("with ignoreDisplacements=true, other op types still surface", async () => {
    // Mix: one text change (preserved) + one relocation (dropped). Sanity
    // check that the filter is targeted, not a blanket "drop everything."
    const a = `<html><body><h1>title</h1><img src="a.png"/><p>copy</p></body></html>`;
    const b = `<html><body><img src="a.png"/><h1>title2</h1><p>copy</p></body></html>`;
    const regions = await runL2(a, b, { ignoreDisplacements: true });
    // Text-change op should survive even when relocations are dropped.
    const textChanges = regions.filter((r) => r.category === "text");
    expect(textChanges.length).toBeGreaterThan(0);
    // Relocations dropped.
    const relocations = regions.filter(
      (r) => r.description === "Element relocated",
    );
    expect(relocations.length).toBe(0);
  });

  it("undefined option falls back to existing behavior (no drop)", async () => {
    const a = await runL2(baseline, candidate);
    const b = await runL2(baseline, candidate, {});
    expect(b.length).toBe(a.length);
  });
});
