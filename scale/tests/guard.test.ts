import { describe, expect, it } from "vitest";

import { BUDGETS, evaluate } from "../src/budgets.js";
import { runSuiteGuarded } from "../src/guard.js";

describe("runSuiteGuarded", () => {
  it("returns what the suite measured", async () => {
    const measured = [{ id: "P1", value: 1 }];
    expect(await runSuiteGuarded("pipeline", async () => measured)).toBe(
      measured,
    );
  });

  it("records the error on every budget of a suite that throws", async () => {
    const out = await runSuiteGuarded("pipeline", async () => {
      throw new Error("boom");
    });
    const ids = BUDGETS.filter((b) => b.suite === "pipeline").map((b) => b.id);
    expect(out.map((m) => m.id)).toEqual(ids);
    expect(out.every((m) => m.value === null && m.error === "boom")).toBe(true);
    // ...and the verdict is `error`, so the run fails.
    const rows = evaluate(BUDGETS, out, ["pipeline"]);
    expect(
      rows
        .filter((r) => r.suite === "pipeline")
        .every((r) => r.verdict === "error"),
    ).toBe(true);
  });

  it("reports a suite with no runner as an error, not as skipped", async () => {
    const out = await runSuiteGuarded("browser", undefined);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]?.error).toMatch(/not implemented/);
  });

  it("keeps a connection string password out of the recorded error", async () => {
    const out = await runSuiteGuarded("server", async () => {
      throw new Error("connect redis://:s3cret@cache.example:6379 failed");
    });
    expect(out[0]?.error).not.toContain("s3cret");
  });
});
