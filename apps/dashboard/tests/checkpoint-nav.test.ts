import { describe, expect, test } from "vitest";

import { nextUnresolvedCheckpointId } from "../src/components/diff-viewer/checkpoint-nav";

const s = (id: string, status: string) => ({ id, status });

describe("nextUnresolvedCheckpointId", () => {
  test("returns the next unresolved after current", () => {
    expect(
      nextUnresolvedCheckpointId(
        [s("a", "passed"), s("b", "unresolved"), s("c", "unresolved")],
        "a",
      ),
    ).toBe("b");
  });
  test("skips resolved checkpoints", () => {
    expect(
      nextUnresolvedCheckpointId(
        [s("a", "unresolved"), s("b", "passed"), s("c", "unresolved")],
        "a",
      ),
    ).toBe("c");
  });
  test("returns null when none remain after current", () => {
    expect(
      nextUnresolvedCheckpointId([s("a", "unresolved"), s("b", "passed")], "a"),
    ).toBeNull();
  });
  test("returns null when current id not found", () => {
    expect(nextUnresolvedCheckpointId([s("a", "unresolved")], "x")).toBeNull();
  });
});
