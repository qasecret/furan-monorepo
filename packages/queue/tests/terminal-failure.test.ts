import { describe, expect, test } from "vitest";

import { type Job, isTerminalFailure } from "../src/index.js";

/**
 * Pure coverage for the dead-letter detection used by the worker `failed`
 * handlers. No Redis needed — `isTerminalFailure` only reads `attemptsMade`
 * and `opts.attempts` off the job handle.
 */
function fakeJob(attemptsMade: number, attempts?: number): Job {
  return {
    attemptsMade,
    opts: attempts === undefined ? {} : { attempts },
  } as unknown as Job;
}

describe("isTerminalFailure", () => {
  test("not terminal while attempts remain", () => {
    expect(isTerminalFailure(fakeJob(1, 3))).toBe(false);
    expect(isTerminalFailure(fakeJob(2, 3))).toBe(false);
  });

  test("terminal on the final attempt", () => {
    expect(isTerminalFailure(fakeJob(3, 3))).toBe(true);
  });

  test("terminal past the budget (defensive ≥, not ===)", () => {
    expect(isTerminalFailure(fakeJob(4, 3))).toBe(true);
  });

  test("falls back to the queue default of 3 attempts when opts omit it", () => {
    expect(isTerminalFailure(fakeJob(2))).toBe(false);
    expect(isTerminalFailure(fakeJob(3))).toBe(true);
  });

  test("an undefined job handle is treated as terminal", () => {
    expect(isTerminalFailure(undefined)).toBe(true);
  });
});
