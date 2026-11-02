import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

// The bundled docs portal is only ever built inside the dashboard image (spec
// §5.1), and nothing local builds images: these pin the two files that make it
// work, so a regression shows up here instead of in a release.
const read = (rel: string): string =>
  readFileSync(new URL(rel, import.meta.url), "utf8");

describe("the docs bundle in the dashboard image", () => {
  it(".dockerignore lets docs/ back into the build context", () => {
    const lines = read("../../../.dockerignore")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
    const excluded = lines.indexOf("docs/");
    expect(excluded).toBeGreaterThanOrEqual(0);
    expect(lines.indexOf("!docs")).toBeGreaterThan(excluded);
  });

  it("the Dockerfile builds the portal and ships it in public/docs", () => {
    const dockerfile = read("../Dockerfile");
    expect(dockerfile).toMatch(/^FROM \S+ AS docs$/m);
    expect(dockerfile).toContain(
      "COPY --from=docs /app/apps/docs/build apps/dashboard/public/docs",
    );
    expect(dockerfile).toContain("./apps/dashboard/public");
  });
});
