import { describe, expect, test } from "vitest";

import { nextPendingCheckpointId } from "../src/components/diff-viewer/checkpoint-nav";

const s = (id: string, state: string | null) => ({ id, state });

describe("nextPendingCheckpointId", () => {
  test("returns the next pending step after the current one", () => {
    expect(
      nextPendingCheckpointId(
        [s("a", "passed"), s("b", "unresolved"), s("c", "unresolved")],
        "a",
      ),
    ).toBe("b");
  });

  test("skips steps that need no review: passed, approved, rejected, not diffed", () => {
    expect(
      nextPendingCheckpointId(
        [
          s("a", "unresolved"),
          s("b", "passed"),
          s("c", "approved"),
          s("d", "rejected"),
          s("e", null),
          s("f", "unresolved"),
        ],
        "a",
      ),
    ).toBe("f");
  });

  test("includes new steps, which are pending too", () => {
    expect(
      nextPendingCheckpointId([s("a", "unresolved"), s("b", "new")], "a"),
    ).toBe("b");
  });

  test("wraps around to the start of the run", () => {
    expect(
      nextPendingCheckpointId(
        [s("a", "unresolved"), s("b", "approved"), s("c", "approved")],
        "c",
      ),
    ).toBe("a");
  });

  test("walks forward before it wraps", () => {
    expect(
      nextPendingCheckpointId(
        [s("a", "new"), s("b", "unresolved"), s("c", "new")],
        "b",
      ),
    ).toBe("c");
  });

  test("never returns the current step, even when it is the only pending one", () => {
    expect(
      nextPendingCheckpointId([s("a", "unresolved"), s("b", "passed")], "a"),
    ).toBeNull();
    expect(nextPendingCheckpointId([s("a", "new")], "a")).toBeNull();
  });

  test("returns null when nothing is pending", () => {
    expect(
      nextPendingCheckpointId([s("a", "approved"), s("b", "rejected")], "a"),
    ).toBeNull();
  });

  test("returns null when the current id is not in the list", () => {
    expect(nextPendingCheckpointId([s("a", "unresolved")], "x")).toBeNull();
  });
});
