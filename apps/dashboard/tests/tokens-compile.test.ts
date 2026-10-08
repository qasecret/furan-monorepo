// @vitest-environment node
import path from "node:path";
import { fileURLToPath } from "node:url";

import tailwind from "@tailwindcss/postcss";
import postcss from "postcss";
import { beforeAll, describe, expect, test } from "vitest";

/**
 * Compiles the real token layer through Tailwind v4 and asserts on the emitted
 * CSS, so a token that parses but never becomes a working utility (or loses
 * its opacity-modifier support) fails here.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));

const SOURCE = `
@import "tailwindcss" source(none);
@import "../src/app/tokens.css";
@source inline("bg-status-failed/10 bg-canvas/70 border-status-passed/25 text-fg-muted bg-raised shadow-raised shadow-overlay rounded-overlay text-2xs focus-ring bg-card text-muted-foreground");
`;

let out = "";

beforeAll(async () => {
  const result = await postcss([tailwind()]).process(SOURCE, {
    from: path.join(HERE, "virtual.css"),
  });
  out = result.css;
});

/** Declarations of the first rule whose selector is `selector` (already CSS-escaped). */
function rule(selector: string): string {
  const at = out.indexOf(`${selector} {`);
  expect(at, `${selector} should be emitted`).toBeGreaterThanOrEqual(0);
  const open = out.indexOf("{", at);
  // Rule bodies may contain nested blocks (e.g. @supports); balance braces.
  let depth = 0;
  for (let i = open; i < out.length; i++) {
    if (out[i] === "{") depth++;
    else if (out[i] === "}" && --depth === 0) return out.slice(open + 1, i);
  }
  throw new Error(`${selector} rule is not closed`);
}

describe("token utilities compile", () => {
  test.each([
    [".bg-status-failed\\/10"],
    [".bg-canvas\\/70"],
    [".border-status-passed\\/25"],
  ])("%s supports the opacity modifier via color-mix", (selector) => {
    expect(rule(selector)).toContain("color-mix(");
  });

  test("text-2xs is 0.6875rem", () => {
    expect(rule(".text-2xs")).toContain("font-size: 0.6875rem");
  });

  test("rounded-overlay is 10px", () => {
    expect(rule(".rounded-overlay")).toContain("10px");
  });

  test("focus-ring utility is emitted", () => {
    expect(out).toContain(".focus-ring");
  });

  test("shadow-raised / shadow-overlay utilities are emitted", () => {
    expect(out).toContain(".shadow-raised");
    expect(out).toContain(".shadow-overlay");
  });

  test("shadcn aliases resolve to the semantic variables", () => {
    expect(rule(".bg-card")).toContain("var(--raised)");
  });
});
