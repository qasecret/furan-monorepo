import type { RunStatus } from "@furan/shared-types";
import { describe, expect, test } from "vitest";

import {
  aggregateBuildStatus,
  describeBuildStatus,
} from "../src/build-status.js";
import { presentationFor } from "../src/status-mapping.js";

describe("aggregateBuildStatus", () => {
  test("no runs → null (nothing to report)", () => {
    expect(aggregateBuildStatus({})).toBeNull();
    expect(aggregateBuildStatus({ passed: 0 })).toBeNull();
  });

  test("a single run is its own status", () => {
    for (const status of [
      "running",
      "new",
      "passed",
      "unresolved",
      "failed",
      "aborted",
      "empty",
    ] as RunStatus[]) {
      expect(aggregateBuildStatus({ [status]: 1 })).toMatchObject({
        status,
        total: 1,
        inBucket: 1,
      });
    }
  });

  // The precedence is the point of the aggregation: a later passing test must
  // never turn a gate green while an earlier one is still failing.
  test.each<[string, Partial<Record<RunStatus, number>>, RunStatus]>([
    [
      "aborted beats everything",
      { aborted: 1, failed: 2, passed: 9 },
      "aborted",
    ],
    ["failed beats unresolved", { failed: 1, unresolved: 3 }, "failed"],
    [
      "unresolved beats empty, running and passed",
      { unresolved: 1, empty: 1, running: 1, passed: 5 },
      "unresolved",
    ],
    ["empty beats running", { empty: 1, running: 4 }, "empty"],
    [
      "running beats new and passed (pending until all settle)",
      { running: 1, new: 2, passed: 7 },
      "running",
    ],
    ["new beats passed", { new: 1, passed: 10 }, "new"],
    ["all passed", { passed: 12 }, "passed"],
  ])("%s", (_label, counts, expected) => {
    expect(aggregateBuildStatus(counts)?.status).toBe(expected);
  });

  test("the gate stays red when a failing test is followed by passing ones", () => {
    const agg = aggregateBuildStatus({ unresolved: 1, passed: 40 })!;
    expect(presentationFor(agg.status).githubState).toBe("failure");
  });

  test("inBucket counts the runs that share the winner's GitHub state", () => {
    // failure bucket: failed + unresolved + empty
    expect(
      aggregateBuildStatus({ failed: 1, unresolved: 2, empty: 1, passed: 6 }),
    ).toMatchObject({ total: 10, inBucket: 4 });
    // success bucket: new + passed
    expect(aggregateBuildStatus({ new: 2, passed: 3 })).toMatchObject({
      status: "new",
      total: 5,
      inBucket: 5,
    });
    // pending bucket: running only
    expect(aggregateBuildStatus({ running: 3, passed: 9 })).toMatchObject({
      status: "running",
      total: 12,
      inBucket: 3,
    });
    // error bucket: aborted only
    expect(aggregateBuildStatus({ aborted: 1, unresolved: 4 })).toMatchObject({
      status: "aborted",
      total: 5,
      inBucket: 1,
    });
  });
});

describe("describeBuildStatus", () => {
  test("a single test keeps the run-level description unchanged", () => {
    const agg = aggregateBuildStatus({ unresolved: 1 })!;
    expect(describeBuildStatus(agg)).toBe(
      presentationFor("unresolved").description,
    );
  });

  test("several tests append how many are in the winning state", () => {
    const agg = aggregateBuildStatus({ unresolved: 2, passed: 12 })!;
    expect(describeBuildStatus(agg)).toBe(
      `${presentationFor("unresolved").description} (2 of 14 tests)`,
    );
  });

  test("never exceeds GitHub's 140-character status description limit", () => {
    const agg = aggregateBuildStatus({
      empty: 123456789,
      passed: 123456789,
    })!;
    expect(describeBuildStatus(agg).length).toBeLessThanOrEqual(140);
  });
});
