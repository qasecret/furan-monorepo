import { describe, expect, it } from "vitest";

import { findSmallestContainingElement } from "../src/components/diff-viewer/snap-to-element";

describe("findSmallestContainingElement", () => {
  it("returns the smallest element that fully contains the draft", () => {
    const draft = { x: 20, y: 20, width: 40, height: 40 };
    const elements = {
      "html > body": { x: 0, y: 0, width: 1280, height: 720 },
      "#hero": { x: 0, y: 0, width: 600, height: 300 },
      "#button": { x: 15, y: 15, width: 80, height: 50 },
    };
    const result = findSmallestContainingElement(draft, elements);
    expect(result).toEqual({
      selector: "#button",
      bbox: { x: 15, y: 15, width: 80, height: 50 },
    });
  });

  it("returns null when no element contains the draft", () => {
    const draft = { x: 0, y: 0, width: 100, height: 100 };
    const elements = {
      "#offscreen": { x: 500, y: 500, width: 50, height: 50 },
    };
    expect(findSmallestContainingElement(draft, elements)).toBeNull();
  });

  it("accepts a 2px overdraw tolerance on each side", () => {
    // The element is {x:10,y:10,w:100,h:100} → right=110, bottom=110.
    // Draft {x:8,y:8,w:104,h:104} → right=112, bottom=112: 2px overdraw
    // on every side — within tolerance.
    const draft = { x: 8, y: 8, width: 104, height: 104 };
    const elements = {
      "#card": { x: 10, y: 10, width: 100, height: 100 },
    };
    const result = findSmallestContainingElement(draft, elements);
    expect(result?.selector).toBe("#card");
  });

  it("breaks ties on identical area by iteration order (first wins)", () => {
    const draft = { x: 50, y: 50, width: 20, height: 20 };
    const elements = {
      "#first": { x: 0, y: 0, width: 200, height: 200 },
      "#second": { x: 0, y: 0, width: 200, height: 200 },
    };
    const result = findSmallestContainingElement(draft, elements);
    expect(result?.selector).toBe("#first");
  });

  it("returns null on empty element map", () => {
    const draft = { x: 10, y: 10, width: 50, height: 50 };
    expect(findSmallestContainingElement(draft, {})).toBeNull();
  });
});
