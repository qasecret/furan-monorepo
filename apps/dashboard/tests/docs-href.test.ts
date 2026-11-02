// @vitest-environment node
// (Under jsdom, Vite rewrites `new URL(…, import.meta.url)` to an http URL.)
import { existsSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { DOCS_SLUGS, docsHref } from "@/lib/docs-href";

// The repo's docs/ folder, the portal's source (spec §3.1 of the first-run
// spec): a slug the app links to must still have its page.
const docsDir = new URL("../../../docs/", import.meta.url);

describe("docsHref", () => {
  it("maps a slug to its same-origin /docs path", () => {
    expect(docsHref("getting-started/install")).toBe(
      "/docs/getting-started/install",
    );
  });

  it("is the portal home without a slug", () => {
    expect(docsHref()).toBe("/docs");
  });

  it("appends a query", () => {
    expect(
      docsHref("getting-started/first-upload", { driver: "playwright" }),
    ).toBe("/docs/getting-started/first-upload?driver=playwright");
  });

  it("every slug has a docs page", () => {
    for (const slug of DOCS_SLUGS) {
      const page = ["md", "mdx"].some((ext) =>
        existsSync(new URL(`${slug}.${ext}`, docsDir)),
      );
      expect(page, `docs/${slug}.md(x)`).toBe(true);
    }
  });
});
