// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { userRoleSchema } from "@furan/shared-types";
import { describe, expect, it } from "vitest";

import { ROLE_STYLE, roleStyle } from "../src/lib/role-style";

describe("ROLE_STYLE", () => {
  it("has a chip for every role", () => {
    for (const role of userRoleSchema.options) {
      expect(ROLE_STYLE[role].length, role).toBeGreaterThan(0);
    }
  });

  it("gives hued roles an opaque -100 chip with -800 text (Ruling R18)", () => {
    expect(ROLE_STYLE).toMatchObject({
      owner: "bg-amber-100 text-amber-800",
      admin: "bg-violet-100 text-violet-800",
      editor: "bg-sky-100 text-sky-800",
    });
    for (const role of ["owner", "admin", "editor"] as const) {
      expect(ROLE_STYLE[role]).not.toMatch(/dark:|\/\d+/);
    }
  });

  it("keeps guest neutral on the edge surface, not the hover alias", () => {
    // `bg-muted` (= hover) measured ~1.03:1 against the dark overlay the
    // account menu renders on, so the chip vanished there.
    expect(ROLE_STYLE.guest).toBe("bg-edge text-fg-secondary");
  });

  it("falls back to guest for an unknown role", () => {
    expect(roleStyle("bogus")).toBe(ROLE_STYLE.guest);
    expect(roleStyle("toString")).toBe(ROLE_STYLE.guest);
  });

  it("returns the matching chip for a known role", () => {
    expect(roleStyle("admin")).toBe(ROLE_STYLE.admin);
  });

  it("builds no class name by template interpolation", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../src/lib/role-style.ts", import.meta.url)),
      "utf8",
    );
    expect(src).not.toContain("${");
  });
});
