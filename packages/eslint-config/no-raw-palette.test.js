import { RuleTester } from "eslint";
import { describe, expect, test } from "vitest";

import noRawPalette from "./no-raw-palette.js";

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

describe("@furan/no-raw-palette", () => {
  test("flags raw neutral palette classes", () => {
    expect(() =>
      ruleTester.run("no-raw-palette", noRawPalette, {
        valid: [],
        invalid: [
          {
            code: `<div className="border-zinc-200" />`,
            errors: [{ messageId: "neutral" }],
          },
          {
            code: `const V = { ghost: "text-gray-600" }`,
            errors: [{ messageId: "neutral" }],
          },
        ],
      }),
    ).not.toThrow();
  });

  test("flags dark: colour overrides", () => {
    expect(() =>
      ruleTester.run("no-raw-palette", noRawPalette, {
        valid: [],
        invalid: [
          {
            code: `cn("p-2", "dark:bg-red-500/10")`,
            errors: [{ messageId: "darkColor" }],
          },
        ],
      }),
    ).not.toThrow();
  });

  test("reports every category a token matches, per template element", () => {
    expect(() =>
      ruleTester.run("no-raw-palette", noRawPalette, {
        valid: [],
        invalid: [
          {
            code: "const c = `hover:dark:bg-zinc-900 ${x}`",
            errors: [{ messageId: "neutral" }, { messageId: "darkColor" }],
          },
          {
            code: `"dark:bg-zinc-900"`,
            errors: [{ messageId: "neutral" }, { messageId: "darkColor" }],
          },
        ],
      }),
    ).not.toThrow();
  });

  test("flags arbitrary colours", () => {
    expect(() =>
      ruleTester.run("no-raw-palette", noRawPalette, {
        valid: [],
        invalid: [
          {
            code: `"bg-[#09090b]"`,
            errors: [{ messageId: "arbitraryColor" }],
          },
        ],
      }),
    ).not.toThrow();
  });

  test("flags arbitrary font sizes", () => {
    expect(() =>
      ruleTester.run("no-raw-palette", noRawPalette, {
        valid: [],
        invalid: [
          {
            code: `"text-[11px] font-mono"`,
            errors: [{ messageId: "arbitraryFontSize" }],
          },
        ],
      }),
    ).not.toThrow();
  });

  test("allows semantic tokens and non-neutral utilities", () => {
    expect(() =>
      ruleTester.run("no-raw-palette", noRawPalette, {
        valid: [
          { code: `"bg-canvas text-fg-muted border-edge-subtle"` },
          { code: `"bg-status-failed/10 text-status-failed-text"` },
          {
            code: `"text-sm border-2 ring-offset-2 bg-gradient-to-r dark:opacity-50"`,
          },
          { code: `"bg-black/70 text-white"` },
          { code: `"text-red-600"` },
          { code: `"shadow-[0_8px_30px_-10px_rgba(168,255,83,0.7)]"` },
        ],
        invalid: [],
      }),
    ).not.toThrow();
  });

  test("ignores comments and module sources", () => {
    expect(() =>
      ruleTester.run("no-raw-palette", noRawPalette, {
        valid: [
          { code: `// zinc-200 in a comment` },
          { code: `import x from "zinc-500"` },
          { code: `export * from "zinc-500"` },
          { code: `export { y } from "zinc-500"` },
        ],
        invalid: [],
      }),
    ).not.toThrow();
  });
});
