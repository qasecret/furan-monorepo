import type { DiffRegion } from "@furan/diff-engine";
import { describe, expect, it } from "vitest";

import {
  classifyLayoutContent,
  type ReviewerRegion,
} from "../src/region-mode-classifier.js";

function l2(
  id: string,
  category: DiffRegion["category"],
  bbox: { x: number; y: number; width: number; height: number },
  severity: DiffRegion["severity"] = "minor",
): DiffRegion {
  return {
    id,
    severity,
    category,
    bbox,
    description: `${id}-desc`,
    source: "l2",
  };
}

describe("classifyLayoutContent", () => {
  it("is a no-op when there are no layout/content regions", () => {
    const regions = [l2("a", "text", { x: 0, y: 0, width: 10, height: 10 })];
    const out = classifyLayoutContent(regions, []);
    expect(out).toBe(regions); // same array, same items
    expect(out[0]!.severity).toBe("minor");
  });

  it("re-tags an L2 region intersecting a layout region as major/layout", () => {
    const r = l2("a", "text", { x: 5, y: 5, width: 10, height: 10 });
    const reviewer: ReviewerRegion[] = [
      { kind: "layout", bbox: { x: 0, y: 0, width: 50, height: 50 } },
    ];
    classifyLayoutContent([r], reviewer);
    expect(r.severity).toBe("major");
    expect(r.category).toBe("layout");
    expect(r.description.startsWith("Layout region:")).toBe(true);
  });

  it("keeps a text L2 region inside a content region, tagged major", () => {
    const text = l2("t", "text", { x: 5, y: 5, width: 10, height: 10 });
    const reviewer: ReviewerRegion[] = [
      { kind: "content", bbox: { x: 0, y: 0, width: 50, height: 50 } },
    ];
    const out = classifyLayoutContent([text], reviewer);
    expect(out).toHaveLength(1);
    expect(out[0]!.severity).toBe("major");
    expect(out[0]!.description.startsWith("Content region:")).toBe(true);
  });

  it("suppresses a non-text L2 region inside a content region", () => {
    const attr = l2("a", "structural", { x: 5, y: 5, width: 10, height: 10 });
    const reviewer: ReviewerRegion[] = [
      { kind: "content", bbox: { x: 0, y: 0, width: 50, height: 50 } },
    ];
    const out = classifyLayoutContent([attr], reviewer);
    expect(out).toHaveLength(0);
  });

  it("keeps L2 regions outside any layout/content region unchanged", () => {
    const r = l2("a", "structural", { x: 100, y: 100, width: 10, height: 10 });
    const reviewer: ReviewerRegion[] = [
      { kind: "layout", bbox: { x: 0, y: 0, width: 50, height: 50 } },
      { kind: "content", bbox: { x: 0, y: 0, width: 50, height: 50 } },
    ];
    const out = classifyLayoutContent([r], reviewer);
    expect(out).toHaveLength(1);
    expect(out[0]!.severity).toBe("minor"); // untouched
    expect(out[0]!.category).toBe("structural"); // untouched
  });

  it("falls through silently when L2 bbox is zero-size (unresolved)", () => {
    const r = l2("a", "text", { x: 0, y: 0, width: 0, height: 0 }); // unresolved
    const reviewer: ReviewerRegion[] = [
      { kind: "layout", bbox: { x: 0, y: 0, width: 100, height: 100 } },
    ];
    const out = classifyLayoutContent([r], reviewer);
    expect(out[0]!.severity).toBe("minor"); // not retagged — zero-size never intersects
  });

  it("never touches L1 regions", () => {
    const l1: DiffRegion = {
      id: "l1",
      severity: "breaking",
      category: "image",
      bbox: { x: 5, y: 5, width: 10, height: 10 },
      description: "L1 pixel diff",
      source: "l1",
    };
    const reviewer: ReviewerRegion[] = [
      { kind: "layout", bbox: { x: 0, y: 0, width: 100, height: 100 } },
    ];
    const out = classifyLayoutContent([l1], reviewer);
    expect(out).toHaveLength(1);
    expect(out[0]!.severity).toBe("breaking"); // untouched
    expect(out[0]!.category).toBe("image"); // untouched
  });

  it("when an op is inside BOTH layout and content, content's filter wins (content runs last)", () => {
    const text = l2("text-in-both", "text", {
      x: 5,
      y: 5,
      width: 10,
      height: 10,
    });
    const attr = l2("attr-in-both", "structural", {
      x: 5,
      y: 5,
      width: 10,
      height: 10,
    });
    const reviewer: ReviewerRegion[] = [
      { kind: "layout", bbox: { x: 0, y: 0, width: 50, height: 50 } },
      { kind: "content", bbox: { x: 0, y: 0, width: 50, height: 50 } },
    ];
    const out = classifyLayoutContent([text, attr], reviewer);
    // Text survives both passes, retagged by content (more specific).
    expect(out.find((r) => r.id === "text-in-both")?.description).toMatch(
      /^Content region:/,
    );
    // Attr suppressed by content even though layout retagged it first.
    expect(out.find((r) => r.id === "attr-in-both")).toBeUndefined();
  });
});
