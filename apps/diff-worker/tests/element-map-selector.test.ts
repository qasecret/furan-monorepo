import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

import {
  elementSegment,
  buildSdkSelectorFromAncestors,
} from "../src/element-map-selector.js";

function parseAndPick(html: string, selector: string): Element {
  const dom = new JSDOM(html);
  const node = dom.window.document.querySelector(selector);
  if (!node) throw new Error(`selector ${selector} found nothing`);
  return node;
}

describe("elementSegment", () => {
  it("returns #id when the node has an id", () => {
    const el = parseAndPick(`<div id="main"></div>`, "#main");
    expect(elementSegment(el)).toBe("#main");
  });

  it("returns tag + dotted class list when no id", () => {
    const el = parseAndPick(`<div class="alpha beta"></div>`, ".alpha");
    expect(elementSegment(el)).toBe("div.alpha.beta");
  });

  it("filters classes that fail the SDK identifier regex", () => {
    // The SDK's filter is /^[a-zA-Z0-9_-]+$/. A class containing
    // a colon (e.g. Tailwind variants like `md:flex`) is dropped.
    const el = parseAndPick(`<div class="ok md:flex also_ok"></div>`, ".ok");
    expect(elementSegment(el)).toBe("div.ok.also_ok");
  });

  it("appends :nth-child(N) only when 2+ siblings share the same tag", () => {
    // Parent has THREE <p> siblings; the second one (1-based child
    // index 2) should get :nth-child(2).
    const el = parseAndPick(
      `<div><p>a</p><p class="target">b</p><p>c</p></div>`,
      "p.target",
    );
    expect(elementSegment(el)).toBe("p.target:nth-child(2)");
  });

  it("does not append :nth-child when the node is the only of its tag", () => {
    const el = parseAndPick(`<div><h1>title</h1><p>body</p></div>`, "p");
    expect(elementSegment(el)).toBe("p");
  });

  it("uses overall child index (not same-tag-only) for nth-child", () => {
    // Children: h1, p, p, h2, p. The third <p> has 1-based child
    // index 5 (overall children, NOT same-tag). The SDK script in
    // ElementBboxScript.kt iterates parent.children directly.
    const dom = new JSDOM(
      `<div><h1>x</h1><p>1</p><p>2</p><h2>y</h2><p class="target">3</p></div>`,
    );
    const el = dom.window.document.querySelector("p.target")!;
    expect(elementSegment(el)).toBe("p.target:nth-child(5)");
  });

  it("returns null when called on a node without a tagName", () => {
    // Defensive — text nodes / comments don't have tagName on this
    // helper's input type, so we expect callers to never pass them,
    // but the helper handles it via tag-existence check.
    // We can't easily construct an Element without a tagName, so
    // this test simulates it by spreading a real element's props
    // and clearing tagName via Object.defineProperty.
    const el = parseAndPick(`<div></div>`, "div");
    // @ts-expect-error — intentional override for the defensive test
    Object.defineProperty(el, "tagName", { value: undefined });
    expect(elementSegment(el)).toBeNull();
  });
});

describe("buildSdkSelectorFromAncestors", () => {
  it("builds a root-to-leaf chain, stopping at the nearest #id ancestor", () => {
    // Element-map indexes elements stopping at #id. The chain we
    // return should reflect the same convention.
    const el = parseAndPick(
      `<html><body><div id="main"><section><p class="lead">x</p></section></div></body></html>`,
      "p.lead",
    );
    const chain = buildSdkSelectorFromAncestors(el);
    // Expected chain (root → leaf):
    //   "#main"
    //   "#main > section"
    //   "#main > section > p.lead"
    expect(chain).toEqual([
      "#main",
      "#main > section",
      "#main > section > p.lead",
    ]);
  });

  it("falls back to walking to root when no #id ancestor exists", () => {
    const el = parseAndPick(
      `<html><body><div><section><p class="lead">x</p></section></div></body></html>`,
      "p.lead",
    );
    const chain = buildSdkSelectorFromAncestors(el);
    // Chain walks all the way to <html>:
    //   html
    //   html > body
    //   html > body > div
    //   html > body > div > section
    //   html > body > div > section > p.lead
    expect(chain[chain.length - 1]).toBe(
      "html > body > div > section > p.lead",
    );
    expect(chain.length).toBe(5);
  });

  it("handles a leaf that is itself an id-bearing node", () => {
    const el = parseAndPick(`<div id="main"><p id="lead">x</p></div>`, "#lead");
    const chain = buildSdkSelectorFromAncestors(el);
    // The leaf id resets the chain to itself.
    expect(chain[chain.length - 1]).toBe("#lead");
  });
});
