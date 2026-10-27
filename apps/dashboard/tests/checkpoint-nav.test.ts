import { describe, expect, test } from "vitest";

import { summarizeCheckpoints } from "../src/components/diff-viewer/checkpoint-nav";

const step = (over: Record<string, unknown> = {}) => ({
  id: "c1",
  name: "home" as string | null,
  state: "unresolved" as string | null,
  ...over,
});

describe("summarizeCheckpoints", () => {
  test("keeps the step's id, name and state, in the list's order", () => {
    const out = summarizeCheckpoints([
      step(),
      step({ id: "c2", name: "search", state: null }),
    ]);
    expect(out).toEqual([
      { id: "c1", name: "home", state: "unresolved" },
      { id: "c2", name: "search", state: null },
    ]);
  });

  test("an unnamed step is named by its id", () => {
    const [s] = summarizeCheckpoints([step({ name: null })]);
    expect(s!.name).toBe("c1");
  });
});
