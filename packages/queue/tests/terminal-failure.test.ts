import { describe, expect, test } from "vitest";

import { type Job, isFinalAttempt, isTerminalFailure } from "../src/index.js";

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

/**
 * `isFinalAttempt` is read INSIDE the processor, where `attemptsMade` counts
 * only the attempts that already failed (BullMQ bumps it after the running
 * attempt finishes). The diff-worker uses it to write `aborted` only when no
 * retry will follow.
 */
describe("isFinalAttempt", () => {
  test("not final while a retry would follow", () => {
    expect(isFinalAttempt(fakeJob(0, 3))).toBe(false);
    expect(isFinalAttempt(fakeJob(1, 3))).toBe(false);
  });

  test("final on the last attempt", () => {
    expect(isFinalAttempt(fakeJob(2, 3))).toBe(true);
  });

  test("a single-attempt job is always on its final attempt", () => {
    expect(isFinalAttempt(fakeJob(0, 1))).toBe(true);
  });

  test("falls back to the queue default of 3 attempts when opts omit it", () => {
    expect(isFinalAttempt(fakeJob(1))).toBe(false);
    expect(isFinalAttempt(fakeJob(2))).toBe(true);
  });

  test("agrees with isTerminalFailure once the running attempt has failed", () => {
    for (let made = 0; made < 4; made++) {
      expect(isFinalAttempt(fakeJob(made, 3))).toBe(
        isTerminalFailure(fakeJob(made + 1, 3)),
      );
    }
  });
});
