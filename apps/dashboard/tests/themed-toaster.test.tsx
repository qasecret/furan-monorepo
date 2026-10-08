// Renders the REAL sonner <Toaster> (only next-themes is mocked): the point of
// this component is how sonner's own CSS variables / inline styles land in the
// DOM, which a mocked Toaster cannot show.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { act, cleanup, render, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

let resolvedTheme: string | undefined;
vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme }),
}));

import { ThemedToaster } from "../src/components/themed-toaster";

const globalsCss = readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "../src/app/globals.css",
  ),
  "utf8",
);

/**
 * `selector -> body` for every rule at the TOP level of a stylesheet, i.e.
 * outside any `@layer` / `@media` block. Sonner's sheet is unlayered, so only
 * an unlayered rule can override it; a rule nested in `@layer` would lose.
 */
function topLevelRules(source: string): Map<string, string> {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = new Map<string, string>();
  let depth = 0;
  let start = 0;
  let selector = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "{") {
      if (depth === 0) {
        selector = text.slice(start, i).trim();
        start = i + 1;
      }
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) {
        rules.set(selector, text.slice(start, i).trim().replace(/\s+/g, " "));
        start = i + 1;
      }
    } else if (c === ";" && depth === 0) {
      start = i + 1; // a top-level statement such as @import
    }
  }
  return rules;
}

beforeEach(() => {
  resolvedTheme = undefined;
});

afterEach(() => {
  cleanup();
});

/** Mount the toaster, fire a toast, and return the toaster + toast elements. */
async function showToast(message: string) {
  render(<ThemedToaster />);
  act(() => {
    toast(message);
  });
  const toaster = await waitFor(() => {
    const el = document.querySelector<HTMLElement>("[data-sonner-toaster]");
    expect(el).not.toBeNull();
    return el!;
  });
  const toastEl = await waitFor(() => {
    const el = toaster.querySelector<HTMLElement>("[data-sonner-toast]");
    expect(el).not.toBeNull();
    return el!;
  });
  return { toaster, toastEl };
}

describe("ThemedToaster", () => {
  test("uses the light toast theme when the resolved theme is light", async () => {
    resolvedTheme = "light";
    const { toaster } = await showToast("light toast");
    expect(toaster.getAttribute("data-theme")).toBe("light");
  });

  test("uses the dark toast theme when the resolved theme is dark", async () => {
    resolvedTheme = "dark";
    const { toaster } = await showToast("dark toast");
    expect(toaster.getAttribute("data-theme")).toBe("dark");
  });

  test("defaults to dark before the theme resolves", async () => {
    resolvedTheme = undefined;
    const { toaster } = await showToast("unresolved toast");
    expect(toaster.getAttribute("data-theme")).toBe("dark");
  });

  test("drives sonner's surface variables from the raw design tokens", async () => {
    resolvedTheme = "dark";
    const { toaster } = await showToast("token toast");
    expect(toaster.style.getPropertyValue("--normal-bg")).toBe(
      "var(--overlay)",
    );
    expect(toaster.style.getPropertyValue("--normal-text")).toBe("var(--fg)");
    expect(toaster.style.getPropertyValue("--normal-border")).toBe(
      "var(--edge)",
    );
    expect(toaster.style.getPropertyValue("--border-radius")).toBe("10px");
  });

  // An inline box-shadow would beat sonner's own `:focus-visible` ring and
  // leave a keyboard-focused toast with no focus indicator; the elevation and
  // the ring live in globals.css instead (next test).
  test("sets no inline box-shadow on the toast", async () => {
    resolvedTheme = "dark";
    const { toastEl } = await showToast("shadow toast");
    expect(toastEl.style.boxShadow).toBe("");
  });

  // jsdom doesn't cascade stylesheets, so pin the rule text instead.
  test("globals.css gives toasts the overlay elevation and a focus ring, unlayered", () => {
    const rules = topLevelRules(globalsCss);
    expect(rules.get('[data-sonner-toast][data-styled="true"]')).toBe(
      "box-shadow: var(--elevation-overlay);",
    );
    expect(
      rules.get('[data-sonner-toast][data-styled="true"]:focus-visible'),
    ).toBe("box-shadow: var(--elevation-overlay), 0 0 0 2px var(--ring);");
  });

  test("keeps richColors and the bottom-right position", async () => {
    resolvedTheme = "dark";
    const { toaster, toastEl } = await showToast("position toast");
    expect(toastEl.getAttribute("data-rich-colors")).toBe("true");
    expect(toaster.getAttribute("data-y-position")).toBe("bottom");
    expect(toaster.getAttribute("data-x-position")).toBe("right");
  });
});
