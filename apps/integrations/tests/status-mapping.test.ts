import { runStatusEnum } from "@furan/db";
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

/**
 * Cross-cutting drift canary — Task 5 of furan-design/plans/2026-05-19-
 * run-status-enum.md. The integrations surface MUST cover every value
 * the DB enum can emit, otherwise a future status addition would silently
 * crash the GitHub commit-status writer when it hit an unmapped value
 * (`presentationFor(unmapped)` → `undefined` → `state` field is missing
 * in the Octokit payload → 422 from GitHub).
 *
 * This test pulls the enum values straight from `@furan/db` (the schema
 * source of truth) rather than re-listing them locally, so adding a new
 * enum label forces a deliberate update to status-mapping.ts.
 */
describe("status-mapping coverage canary", () => {
  test("presentationFor handles every runStatusEnum value with a non-empty payload", () => {
    for (const status of runStatusEnum.enumValues) {
      const p = presentationFor(status as RunStatus);
      expect(p, `presentationFor(${status}) returned undefined`).toBeDefined();
      expect(p.githubState).toMatch(/^(pending|success|failure|error)$/);
      expect(p.description.length).toBeGreaterThan(0);
      expect(p.emoji.length).toBeGreaterThan(0);
    }
  });

  test("isTerminal accepts every runStatusEnum value (no runtime crash)", () => {
    for (const status of runStatusEnum.enumValues) {
      // Should return a boolean for every label; coverage gap would
      // produce `undefined` here, which is falsy but masks the bug.
      const result = isTerminal(status as RunStatus);
      expect(typeof result).toBe("boolean");
    }
  });
});
