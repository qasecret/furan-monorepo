import type { RunStatus } from "@furan/shared-types";
import { describe, expect, it, test } from "vitest";

import { isTerminal, presentationFor } from "../src/status-mapping.js";

/**
 * Verbatim mirror of the spec §3.4 table. If this table drifts from
 * status-mapping.ts the integration surface is wrong — these tests are
 * the canary, not status-mapping.ts.
 */
const EXPECTED: Record<RunStatus, { state: string; emoji: string }> = {
  running: { state: "pending", emoji: "🔵" },
  new: { state: "success", emoji: "⚪" },
  passed: { state: "success", emoji: "🟢" },
  unresolved: { state: "failure", emoji: "🟡" },
  failed: { state: "failure", emoji: "🔴" },
  aborted: { state: "error", emoji: "⚠️" },
  empty: { state: "failure", emoji: "⚪" },
};

describe("presentationFor", () => {
  for (const [status, { state, emoji }] of Object.entries(EXPECTED)) {
    test(`maps ${status} → github=${state}, emoji=${emoji}`, () => {
      const p = presentationFor(status as RunStatus);
      expect(p.githubState).toBe(state);
      expect(p.emoji).toBe(emoji);
      expect(p.description.length).toBeGreaterThan(0);
    });
  }

  test("unresolved description signals review-required (load-bearing policy)", () => {
    // Unresolved maps to GitHub `failure` to block merges; the description
    // is what reviewers read in the GitHub UI to know what to do next.
    expect(presentationFor("unresolved").description).toMatch(/review/i);
  });

  test("aborted description signals infra-side (load-bearing policy)", () => {
    expect(presentationFor("aborted").description).toMatch(/worker|abort/i);
  });
});

describe("isTerminal", () => {
  it("treats running as non-terminal", () => {
    expect(isTerminal("running")).toBe(false);
  });

  it("treats every other status as terminal", () => {
    for (const s of [
      "new",
      "passed",
      "unresolved",
      "failed",
      "aborted",
      "empty",
    ] as const) {
      expect(isTerminal(s)).toBe(true);
    }
  });
});
