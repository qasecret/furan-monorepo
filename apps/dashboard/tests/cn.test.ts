// @vitest-environment node
import { describe, expect, test } from "vitest";

import { cn } from "@/lib/cn";

/**
 * tailwind-merge only knows Tailwind's default scale, so out of the box it
 * reads the design-token utilities (tokens.css) wrongly: `shadow-raised` as a
 * shadow COLOUR (dropped by a later `shadow-black/10`, never replaced by
 * `shadow-none`) and `rounded-overlay` as an unknown class (never replaced by
 * `rounded-md`). `cn` must merge them as the size/radius utilities they are.
 */
describe("cn merges the token utilities", () => {
  test("an elevation is replaced by a later shadow size", () => {
    expect(cn("shadow-raised", "shadow-none")).toBe("shadow-none");
    expect(cn("shadow-overlay", "shadow-lg")).toBe("shadow-lg");
    expect(cn("shadow-brand-edge", "shadow-none")).toBe("shadow-none");
  });

  test("a shadow size is replaced by a later elevation", () => {
    expect(cn("shadow-sm", "shadow-raised")).toBe("shadow-raised");
    expect(cn("shadow-raised", "shadow-overlay")).toBe("shadow-overlay");
  });

  test("an elevation and a shadow colour are kept together", () => {
    expect(cn("shadow-raised", "shadow-black/10")).toBe(
      "shadow-raised shadow-black/10",
    );
  });

  test("the overlay radius and the default radius scale replace each other", () => {
    expect(cn("rounded-overlay", "rounded-md")).toBe("rounded-md");
    expect(cn("rounded-md", "rounded-overlay")).toBe("rounded-overlay");
  });

  test("colour tokens still merge as colours", () => {
    expect(cn("bg-raised", "bg-hover")).toBe("bg-hover");
    expect(cn("text-2xs", "text-fg-muted")).toBe("text-2xs text-fg-muted");
  });
});
