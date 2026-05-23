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
