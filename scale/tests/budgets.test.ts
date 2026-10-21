import { describe, expect, it } from "vitest";

import {
  BUDGETS,
  evaluate,
  exitCode,
  type Budget,
  type Measurement,
  type Row,
  type Suite,
} from "../src/budgets.js";

const ALL: Suite[] = ["pipeline", "server", "browser"];

const m = (id: string, value: number | null): Measurement => ({ id, value });

describe("BUDGETS", () => {
  it("ids are unique and match the table", () => {
    const ids = BUDGETS.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([
      "P1",
      "P2",
      "P3",
      "P4",
      "P5",
      "P6",
      "R1",
      "R1-solo.findNext",
      "R1-solo.reviewNext",
      "R1-solo.worst",
      "R2.pendingCount",
      "R2.runsListPending",
      "R2-solo.pendingCount",
      "R2-solo.runsListPending",
      "R2-solo.buildsListNeedsReview",
      "R2-solo.worst",
      "R3.buildsList",
      "R3.buildsListNeedsReview",
      "R3.runsList",
      "R4.time",
      "R4.size",
      "R5.buildsGetById",
      "R5.checkpointGroup",
      "R6",
      "R7",
      "R8",
      "D1",
      "D2.firstRow",
      "D2.domMax",
      "D2.offscreenImages",
      "D2.imageKB",
      "D3.calls",
      "D3.refetches",
      "D4",
      "D5.open",
      "D5.next",
    ]);
  });

  it("carries the suite, owner, status, unit, comparison and threshold of the table", () => {
    const line = (b: Budget) =>
      [
        b.id,
        b.suite,
        b.owner,
        b.status,
        b.unit,
        `${b.compare} ${b.threshold}`,
      ].join(" | ");
    expect(BUDGETS.map(line)).toEqual([
      "P1 | pipeline | 2 | tracked | ratio | <= 1",
      "P2 | pipeline | 2 | tracked | ms | <= 5000",
      "P3 | pipeline | 2 | tracked | ms | <= 10000",
      "P4 | pipeline | 2 | tracked | ratio | >= 0.8",
      "P5 | pipeline | 2 | tracked | count | <= 0",
      "P6 | pipeline | 2 | tracked | count | <= 0",
      "R1 | server | 3 | tracked | ms | <= 50",
      "R1-solo.findNext | server | 1 | enforced | ms | <= 50",
      "R1-solo.reviewNext | server | 1 | enforced | ms | <= 50",
      "R1-solo.worst | server | 1 | enforced | ms | <= 50",
      "R2.pendingCount | server | 3 | tracked | ms | <= 50",
      "R2.runsListPending | server | 3 | tracked | ms | <= 50",
      "R2-solo.pendingCount | server | 1 | enforced | ms | <= 50",
      "R2-solo.runsListPending | server | 1 | enforced | ms | <= 50",
      "R2-solo.buildsListNeedsReview | server | 1 | enforced | ms | <= 50",
      "R2-solo.worst | server | 1 | enforced | ms | <= 50",
      "R3.buildsList | server | 3 | tracked | ms | <= 100",
      "R3.buildsListNeedsReview | server | 3 | tracked | ms | <= 100",
      "R3.runsList | server | 3 | tracked | ms | <= 100",
      "R4.time | server | 3 | tracked | ms | <= 250",
      "R4.size | server | 3 | tracked | KB | <= 250",
      "R5.buildsGetById | server | 3 | tracked | ms | <= 100",
      "R5.checkpointGroup | server | 3 | tracked | ms | <= 100",
      "R6 | server | 3 | tracked | ms | <= 10",
      "R7 | server | 3 | tracked | ms | <= 150",
      "R8 | server | 4 | tracked | count | <= 0",
      "D1 | browser | 4 | tracked | ms | <= 1500",
      "D2.firstRow | browser | 4 | tracked | ms | <= 1500",
      "D2.domMax | browser | 4 | tracked | elements | <= 5000",
      "D2.offscreenImages | browser | 4 | tracked | count | <= 0",
      "D2.imageKB | browser | 4 | tracked | KB | <= 40",
      "D3.calls | browser | 4 | tracked | count | <= 4",
      "D3.refetches | browser | 4 | tracked | count | <= 1",
      "D4 | browser | 4 | tracked | count | <= 1",
      "D5.open | browser | 4 | tracked | ms | <= 1500",
      "D5.next | browser | 4 | tracked | ms | <= 300",
    ]);
  });

  it("describes every budget", () => {
    for (const b of BUDGETS) expect(b.description.length).toBeGreaterThan(0);
  });
});

describe("evaluate", () => {
  const verdictOf = (rows: Row[], id: string) =>
    rows.find((r) => r.id === id)?.verdict;

  it("returns one row per budget, in order, carrying the budget's fields", () => {
    const rows = evaluate(BUDGETS, [], ALL);
    expect(rows.map((r) => r.id)).toEqual(BUDGETS.map((b) => b.id));
    expect(rows[0]).toMatchObject({ id: "P1", suite: "pipeline", owner: 2 });
  });

  it("passes and fails by compare", () => {
    // P4 is `>= 0.8`.
    const pass = evaluate(BUDGETS, [m("P4", 0.9)], ALL);
    expect(verdictOf(pass, "P4")).toBe("pass");
    expect(pass.find((r) => r.id === "P4")?.value).toBe(0.9);
    expect(verdictOf(evaluate(BUDGETS, [m("P4", 0.7)], ALL), "P4")).toBe(
      "fail",
    );
    // P2 is `<= 5000`; the threshold itself passes.
    expect(verdictOf(evaluate(BUDGETS, [m("P2", 5000)], ALL), "P2")).toBe(
      "pass",
    );
    expect(verdictOf(evaluate(BUDGETS, [m("P2", 5001)], ALL), "P2")).toBe(
      "fail",
    );
    // P4 is `>= 0.8`; the threshold itself passes.
    expect(verdictOf(evaluate(BUDGETS, [m("P4", 0.8)], ALL), "P4")).toBe(
      "pass",
    );
  });

  it("evaluate marks a measurement error and exitCode is 1", () => {
    // Every budget measures exactly at its threshold (a pass), so an `error`
    // row is the only thing that can make the exit code 1: it is not masked by
    // `missing` rows.
    const atThreshold: Measurement[] = BUDGETS.map((b) => m(b.id, b.threshold));
    const clean = evaluate(BUDGETS, atThreshold, ALL);
    expect(clean.every((r) => r.verdict === "pass")).toBe(true);
    expect(exitCode(clean, "large")).toBe(0);
    expect(exitCode(clean, "smoke")).toBe(0);

    // The suite threw midway: R7 carries the error instead of a value.
    const rows = evaluate(
      BUDGETS,
      atThreshold.map((x) =>
        x.id === "R7"
          ? { id: "R7", value: null, error: "approve threw: boom" }
          : x,
      ),
      ALL,
    );
    const r7 = rows.find((r) => r.id === "R7");
    expect(r7?.verdict).toBe("error");
    expect(r7?.note).toBe("approve threw: boom");
    expect(rows.filter((r) => r.verdict !== "pass").map((r) => r.id)).toEqual([
      "R7",
    ]);
    expect(exitCode(rows, "large")).toBe(1);
    expect(exitCode(rows, "smoke")).toBe(1);
  });

  it("lets an error win over a value", () => {
    const rows = evaluate(
      BUDGETS,
      [{ id: "P2", value: 1, error: "suite threw after measuring" }],
      ALL,
    );
    expect(verdictOf(rows, "P2")).toBe("error");
  });

  it("is missing when the suite ran but nothing was measured", () => {
    const rows = evaluate(BUDGETS, [m("P1", 1)], ["pipeline"]);
    expect(verdictOf(rows, "P1")).toBe("pass");
    expect(verdictOf(rows, "P2")).toBe("missing");
    expect(exitCode(rows, "smoke")).toBe(1);
    expect(exitCode(rows, "large")).toBe(1);
  });

  it("is missing when the measurement's value is null or not a number", () => {
    const rows = evaluate(
      BUDGETS,
      [m("P1", null), m("P2", Number.NaN)],
      ["pipeline"],
    );
    expect(verdictOf(rows, "P1")).toBe("missing");
    expect(verdictOf(rows, "P2")).toBe("missing");
  });

  it("is skipped when the suite did not run, and exitCode ignores it", () => {
    const rows = evaluate(BUDGETS, [], []);
    expect(rows.every((r) => r.verdict === "skipped")).toBe(true);
    expect(exitCode(rows, "large")).toBe(0);
    expect(exitCode(rows, "smoke")).toBe(0);
  });

  it("skips only the suites that did not run", () => {
    const rows = evaluate(BUDGETS, [m("P1", 1)], ["pipeline"]);
    expect(verdictOf(rows, "P1")).toBe("pass");
    expect(verdictOf(rows, "R1")).toBe("skipped");
    expect(verdictOf(rows, "D1")).toBe("skipped");
  });

  it("ignores a measurement for a suite that did not run", () => {
    const rows = evaluate(BUDGETS, [m("R1", 5)], ["pipeline"]);
    expect(verdictOf(rows, "R1")).toBe("skipped");
  });

  it("carries a measurement's note through", () => {
    const rows = evaluate(
      BUDGETS,
      [{ id: "R6", value: 4, samples: 50, note: "key owned by one row" }],
      ALL,
    );
    expect(rows.find((r) => r.id === "R6")?.note).toBe("key owned by one row");
  });

  it("does not mutate its inputs", () => {
    const measurements = [m("P1", 1)];
    const before = JSON.stringify([BUDGETS, measurements]);
    evaluate(BUDGETS, measurements, ALL);
    expect(JSON.stringify([BUDGETS, measurements])).toBe(before);
  });
});

describe("exitCode", () => {
  // R7 is tracked, R1-solo.worst is enforced; both are `<= ms`.
  it("a tracked fail does not fail large", () => {
    const rows = evaluate(BUDGETS, [m("R7", 9999)], ["server"]).map((r) =>
      r.verdict === "missing" ? { ...r, verdict: "skipped" as const } : r,
    );
    expect(rows.find((r) => r.id === "R7")?.verdict).toBe("fail");
    expect(exitCode(rows, "large")).toBe(0);
  });

  it("an enforced fail fails large", () => {
    const rows = evaluate(BUDGETS, [m("R1-solo.worst", 9999)], ["server"]).map(
      (r) =>
        r.verdict === "missing" ? { ...r, verdict: "skipped" as const } : r,
    );
    expect(rows.find((r) => r.id === "R1-solo.worst")?.verdict).toBe("fail");
    expect(exitCode(rows, "large")).toBe(1);
  });

  it("smoke ignores thresholds but fails on missing", () => {
    const failing = evaluate(BUDGETS, [m("R1-solo.worst", 9999)], ["server"]);
    // Every other server budget is missing, so smoke fails on those ...
    expect(exitCode(failing, "smoke")).toBe(1);
    // ... but with only the enforced fail left, smoke passes.
    const onlyFail = failing.filter((r) => r.verdict === "fail");
    expect(onlyFail.map((r) => r.id)).toEqual(["R1-solo.worst"]);
    expect(exitCode(onlyFail, "smoke")).toBe(0);
    expect(exitCode(onlyFail, "large")).toBe(1);
  });

  it("is 0 for an all-pass table", () => {
    const rows: Row[] = BUDGETS.map((b) => ({
      ...b,
      value: b.threshold,
      verdict: "pass",
    }));
    expect(exitCode(rows, "large")).toBe(0);
    expect(exitCode(rows, "smoke")).toBe(0);
  });
});
