import { describe, expect, it } from "vitest";

import type { ElementMap } from "../src/element-map-resolver.js";
import { resolveRuleSelectorElementMap } from "../src/rule-selector-resolver.js";

// DOM whose SDK cssPaths are predictable: a #id ancestor stops the chain, so
// the leaf keys are "#main > <tag>.<class>:nth-child(N)". Two sibling spans
// share the tag, so both get :nth-child(N).
const DOM = `<!doctype html><html><body><div id="main">
  <span class="timestamp" data-time="1">A</span>
  <span class="timestamp">B</span>
  <button class="primary">Go</button>
</div></body></html>`;

// Whitespace text nodes count as siblings for nth-child in the SDK script, but
// elementSegment uses parent.children (elements only). The two spans are
// element children 1 and 2; button is element child 3.
const elementMap: ElementMap = {
  v: 1,
  elements: {
    "#main > span.timestamp:nth-child(1)": {
      x: 0,
      y: 0,
      width: 100,
      height: 20,
    },
    "#main > span.timestamp:nth-child(2)": {
      x: 0,
      y: 30,
      width: 100,
      height: 20,
    },
    "#main > button.primary": { x: 0, y: 60, width: 80, height: 30 },
  },
  capturedAt: 0,
};

describe("resolveRuleSelectorElementMap", () => {
  it("resolves a class selector to every matching element's bbox", () => {
    const result = resolveRuleSelectorElementMap(
      [".timestamp"],
      DOM,
      elementMap,
    );
    const ts = result.filter((e) => e.selector === ".timestamp");
    expect(ts).toHaveLength(2);
    expect(ts.map((e) => e.bbox.y).sort((a, b) => a - b)).toEqual([0, 30]);
  });

  it("resolves an ATTRIBUTE selector — only possible against a real DOM", () => {
    const result = resolveRuleSelectorElementMap(
      ["[data-time]"],
      DOM,
      elementMap,
    );
    // Only the first span has data-time.
    expect(result).toHaveLength(1);
    expect(result[0]!.selector).toBe("[data-time]");
    expect(result[0]!.bbox).toEqual({ x: 0, y: 0, width: 100, height: 20 });
  });

  it("resolves a comma selector list, keyed by the original list string", () => {
    const result = resolveRuleSelectorElementMap(
      [".timestamp, button.primary"],
      DOM,
      elementMap,
    );
    // querySelectorAll matches both spans + the button = 3 elements.
    expect(result).toHaveLength(3);
    expect(new Set(result.map((e) => e.selector))).toEqual(
      new Set([".timestamp, button.primary"]),
    );
  });

  it("returns nothing for a selector that matches no element", () => {
    expect(
      resolveRuleSelectorElementMap([".nope"], DOM, elementMap),
    ).toHaveLength(0);
  });

  it("fails safe on an invalid CSS selector (no throw)", () => {
    expect(resolveRuleSelectorElementMap([">>bad>>"], DOM, elementMap)).toEqual(
      [],
    );
  });

  it("returns [] when the DOM is absent", () => {
    expect(
      resolveRuleSelectorElementMap([".timestamp"], undefined, elementMap),
    ).toEqual([]);
  });

  it("returns [] when the element-map is absent", () => {
    expect(resolveRuleSelectorElementMap([".timestamp"], DOM, null)).toEqual(
      [],
    );
  });

  it("falls back to the nearest mapped ancestor when the leaf isn't in the map", () => {
    // Element-map only has the #main container (leaf spans filtered out by the
    // SDK's size/visibility filter). The matched span should resolve to #main.
    const mapWithOnlyAncestor: ElementMap = {
      v: 1,
      elements: { "#main": { x: 0, y: 0, width: 200, height: 200 } },
      capturedAt: 0,
    };
    const result = resolveRuleSelectorElementMap(
      [".timestamp"],
      DOM,
      mapWithOnlyAncestor,
    );
    // Both spans fall back to the same #main bbox.
    expect(result.length).toBeGreaterThan(0);
    expect(result.every((e) => e.bbox.width === 200)).toBe(true);
  });

  it("de-duplicates identical (selector, bbox) pairs", () => {
    // Two selectors in the list resolving to the same ancestor shouldn't
    // double-count the same bbox under the same key.
    const mapWithOnlyAncestor: ElementMap = {
      v: 1,
      elements: { "#main": { x: 0, y: 0, width: 200, height: 200 } },
      capturedAt: 0,
    };
    const result = resolveRuleSelectorElementMap(
      [".timestamp, .timestamp"],
      DOM,
      mapWithOnlyAncestor,
    );
    // Both spans → same #main bbox → de-duped to a single entry.
    expect(result).toHaveLength(1);
  });
});
