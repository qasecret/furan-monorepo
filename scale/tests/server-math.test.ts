import { describe, expect, it } from "vitest";

import {
  disjointSlices,
  failedRequests,
  measureCalls,
  serverMinusStorage,
  type CallSample,
} from "../src/suites/server-math.js";

const sample = (
  key: string,
  ms: number,
  status = 200,
  bytes = 10,
): CallSample => ({ key, ms, status, bytes });

/** 1..n ms, all 200. */
const ramp = (key: string, n: number): CallSample[] =>
  Array.from({ length: n }, (_, i) => sample(key, i + 1));

describe("disjointSlices", () => {
  it("splits in order into contiguous slices that differ by at most one", () => {
    const items = Array.from({ length: 10 }, (_, i) => i);
    const out = disjointSlices(items, 3);
    expect(out).toEqual([
      [0, 1, 2, 3],
      [4, 5, 6],
      [7, 8, 9],
    ]);
    expect(out.flat()).toEqual(items);
  });

  it("leaves the last reviewers empty when there are fewer items", () => {
    expect(disjointSlices(["a", "b"], 3)).toEqual([["a"], ["b"], []]);
  });

  it("refuses a non-positive reviewer count", () => {
    expect(() => disjointSlices([1], 0)).toThrow(RangeError);
  });
});

describe("measureCalls", () => {
  it("is the nearest-rank p95 of the calls under the given keys", () => {
    const m = measureCalls(
      "R1",
      [...ramp("review.next", 100)],
      ["review.next"],
    );
    expect(m.value).toBe(95);
    expect(m.samples).toBe(100);
    expect(m.error).toBeUndefined();
  });

  it("pools several keys into one budget", () => {
    const m = measureCalls(
      "R5.buildsGetById",
      [...ramp("a", 50), ...ramp("b", 50), ...ramp("c", 50)],
      ["a", "b"],
    );
    expect(m.samples).toBe(100);
    expect(m.value).toBe(48);
  });

  it("times only the calls that succeeded and notes the failed ones for R8", () => {
    const m = measureCalls(
      "R1",
      [
        ...ramp("review.next", 20),
        sample("review.next", 9_000, 500),
        sample("review.next", 9_000, 431),
        sample("review.next", 9_000, 0),
      ],
      ["review.next"],
    );
    expect(m.value).toBe(19);
    expect(m.samples).toBe(20);
    expect(m.error).toBeUndefined();
    expect(m.note).toMatch(/3 failed/);
  });

  it("marks the budget error when the api refused what the harness sent", () => {
    const m = measureCalls(
      "R7",
      [...ramp("review.approve", 20), sample("review.approve", 3, 409)],
      ["review.approve"],
    );
    expect(m.error).toMatch(/409/);
  });

  it("has no value when nothing was measured", () => {
    const m = measureCalls("R7", ramp("other", 3), ["review.approve"]);
    expect(m.value).toBeNull();
    expect(m.error).toBeUndefined();
    expect(m.note).toMatch(/no calls/);
  });
});

describe("failedRequests", () => {
  it("adds the server's 5xx to the client's size refusals and transport failures", () => {
    const out = failedRequests(2, [
      sample("a", 1, 200),
      sample("a", 1, 413),
      sample("a", 1, 414),
      sample("a", 1, 431),
      sample("a", 1, 0),
      sample("a", 1, 500),
      sample("a", 1, 404),
    ]);
    // The client's 500 is already one of the server's 5xx; the 404 is no size refusal.
    expect(out.value).toBe(2 + 3 + 1);
    expect(out.note).toMatch(/2 5xx/);
    expect(out.note).toMatch(/3 size/);
    expect(out.note).toMatch(/1 transport/);
  });
});

describe("serverMinusStorage", () => {
  it("subtracts the storage get's p95 from the server time's p95", () => {
    const server = Array.from({ length: 100 }, (_, i) => i + 11);
    const storage = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(serverMinusStorage(server, storage)).toEqual({
      value: 10,
      serverP95: 105,
      storageP95: 95,
    });
  });

  it("never goes below zero", () => {
    expect(serverMinusStorage([1, 2], [5, 6]).value).toBe(0);
  });
});
