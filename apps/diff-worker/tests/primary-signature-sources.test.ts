import { PRIMARY_SIGNATURE_EXCLUDED_SOURCES } from "@furan/db";
import { EXCLUDED_SOURCES } from "@furan/diff-engine";
import { describe, expect, it } from "vitest";

/**
 * `recomputeRunTotals` (in `@furan/db`, which cannot depend on the diff
 * engine) ranks a step by the worst severity of its regions, skipping the
 * audit-only sources. The engine's `EXCLUDED_SOURCES` is the rule the step's
 * own signature is built with, so the run's primary signature only agrees with
 * the old in-memory fold while the two sets agree.
 */
describe("run totals vs the diff engine", () => {
  it("skips exactly the region sources the checkpoint signature excludes", () => {
    expect(new Set(PRIMARY_SIGNATURE_EXCLUDED_SOURCES)).toEqual(
      EXCLUDED_SOURCES,
    );
  });
});
