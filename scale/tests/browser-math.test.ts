import { describe, expect, it } from "vitest";

import {
  countBrowserFailures,
  offscreenImages,
  refetchesPerQuery,
  routeShape,
  storageKeyOf,
  unpackTrpcCalls,
  unpackTrpcPaths,
  walkPlan,
} from "../src/suites/browser-math.js";

const ORIGIN = "http://127.0.0.1:41234";

/** A batched GET as the dashboard's `httpBatchLink` sends it. */
const batchedGet = (calls: [path: string, input: unknown][]): string => {
  const input = Object.fromEntries(calls.map(([, i], n) => [String(n), i]));
  return `${ORIGIN}/api/trpc/${calls.map(([p]) => p).join(",")}?batch=1&input=${encodeURIComponent(JSON.stringify(input))}`;
};

describe("unpackTrpcPaths", () => {
  it("unpacks a batched GET into its procedure paths, in order", () => {
    expect(
      unpackTrpcPaths(
        "/api/trpc/runs.getById,builds.getById?batch=1&input=%7B%7D",
      ),
    ).toEqual(["runs.getById", "builds.getById"]);
  });

  it("takes an absolute URL and an unbatched call", () => {
    expect(
      unpackTrpcPaths(
        `${ORIGIN}/api/trpc/review.approve?input=${encodeURIComponent("{}")}`,
      ),
    ).toEqual(["review.approve"]);
    expect(unpackTrpcPaths(`${ORIGIN}/api/trpc/runs.list`)).toEqual([
      "runs.list",
    ]);
  });

  it("decodes percent-encoded commas between the paths", () => {
    expect(
      unpackTrpcPaths(`${ORIGIN}/api/trpc/runs.list%2Cbuilds.getById?batch=1`),
    ).toEqual(["runs.list", "builds.getById"]);
  });

  it("is empty for anything that is not a tRPC call", () => {
    expect(unpackTrpcPaths(`${ORIGIN}/api/api/v1/storage/abc`)).toEqual([]);
    expect(unpackTrpcPaths(`${ORIGIN}/inbox`)).toEqual([]);
    expect(unpackTrpcPaths(`${ORIGIN}/api/trpc/`)).toEqual([]);
  });
});

describe("unpackTrpcCalls", () => {
  it("pairs each path of a batched GET with its own input", () => {
    const url = batchedGet([
      ["runs.listCheckpoints", { runId: "a" }],
      ["runs.listCheckpoints", { runId: "b" }],
      ["builds.getById", { buildId: "x" }],
    ]);
    expect(unpackTrpcCalls(url)).toEqual([
      { path: "runs.listCheckpoints", input: '{"runId":"a"}' },
      { path: "runs.listCheckpoints", input: '{"runId":"b"}' },
      { path: "builds.getById", input: '{"buildId":"x"}' },
    ]);
  });

  it("takes an unbatched input as the one call's, and none as empty", () => {
    const url = `${ORIGIN}/api/trpc/runs.getById?input=${encodeURIComponent('{"runId":"r"}')}`;
    expect(unpackTrpcCalls(url)).toEqual([
      { path: "runs.getById", input: '{"runId":"r"}' },
    ]);
    expect(unpackTrpcCalls(`${ORIGIN}/api/trpc/users.me`)).toEqual([
      { path: "users.me", input: "" },
    ]);
  });

  it("keeps the paths when the input cannot be read", () => {
    expect(
      unpackTrpcCalls(`${ORIGIN}/api/trpc/a,b?batch=1&input=not-json`),
    ).toEqual([
      { path: "a", input: "" },
      { path: "b", input: "" },
    ]);
  });
});

describe("refetchesPerQuery", () => {
  it("counts the most calls of one path inside a window", () => {
    const calls = [
      { path: "runs.list", t: 0 },
      { path: "runs.list", t: 1000 },
      { path: "runs.list", t: 3500 },
    ];
    expect(refetchesPerQuery(calls, 3000)).toBe(2);
  });

  it("is the largest over the queries, each counted on its own", () => {
    const calls = [
      { path: "runs.list", t: 0 },
      { path: "builds.getById", t: 10 },
      { path: "builds.getById", t: 20 },
      { path: "builds.getById", t: 30 },
      { path: "runs.list", t: 4000 },
    ];
    expect(refetchesPerQuery(calls, 3000)).toBe(3);
  });

  it("tells queries of one path apart by their input", () => {
    // One refetch of each run's step list is one per query, not 3.
    const calls = ["a", "b", "c"].map((runId) => ({
      path: "runs.listCheckpoints",
      input: JSON.stringify({ runId }),
      t: 100,
    }));
    expect(refetchesPerQuery(calls, 3000)).toBe(1);
    expect(
      refetchesPerQuery(
        [...calls, { ...calls[0]!, t: 200 }] as typeof calls,
        3000,
      ),
    ).toBe(2);
  });

  it("is 0 with no calls", () => {
    expect(refetchesPerQuery([], 3000)).toBe(0);
  });
});

describe("storageKeyOf", () => {
  it("reads the key of a storage-proxy URL, through the /api prefix", () => {
    const key = "ab".repeat(32);
    expect(storageKeyOf(`${ORIGIN}/api/api/v1/storage/${key}`)).toBe(key);
    expect(storageKeyOf(`/api/v1/storage/${key}?x=1`)).toBe(key);
  });

  it("is null for any other URL", () => {
    expect(storageKeyOf(`${ORIGIN}/api/trpc/runs.list`)).toBeNull();
    expect(storageKeyOf(`${ORIGIN}/api/api/v1/storage/`)).toBeNull();
  });
});

describe("offscreenImages", () => {
  const url = (key: string) => `${ORIGIN}/api/api/v1/storage/${key}`;

  it("counts only keys not in the visible set", () => {
    const requests = [url("a"), url("b"), url("c"), url("d")].map((u) => ({
      url: u,
    }));
    expect(offscreenImages(requests, new Set(["a", "c"]))).toBe(2);
    expect(offscreenImages(requests, new Set(["a", "b", "c", "d"]))).toBe(0);
    expect(offscreenImages(requests, new Set())).toBe(4);
  });

  it("lets each visible card account for one fetch of its key", () => {
    // Keys are content-addressed: two cards can show the same image. Two
    // visible cards with key a account for two fetches of it, not three.
    const requests = [url("a"), url("a"), url("a")].map((u) => ({ url: u }));
    expect(offscreenImages(requests, ["a", "a"])).toBe(1);
    expect(offscreenImages(requests, ["a", "a", "a"])).toBe(0);
  });

  it("ignores requests that are not step images", () => {
    expect(
      offscreenImages(
        [{ url: `${ORIGIN}/api/trpc/runs.list` }, { url: url("a") }],
        new Set(["a"]),
      ),
    ).toBe(0);
  });
});

describe("walkPlan", () => {
  it("walks forward when the run is long enough", () => {
    expect(walkPlan(500, 50)).toEqual(Array(50).fill("next"));
  });

  it("turns back at either end, so every move stays inside the run", () => {
    expect(walkPlan(4, 8)).toEqual([
      "next",
      "next",
      "next",
      "prev",
      "prev",
      "prev",
      "next",
      "next",
    ]);
    // Replaying it never leaves 0..steps-1.
    let at = 0;
    for (const move of walkPlan(20, 50)) {
      at += move === "next" ? 1 : -1;
      expect(at).toBeGreaterThanOrEqual(0);
      expect(at).toBeLessThan(20);
    }
  });

  it("refuses a run with nowhere to go", () => {
    expect(() => walkPlan(1, 5)).toThrow(/at least 2 steps/);
  });
});

describe("routeShape", () => {
  const id = "0b7a2c1e-3f4d-4e5a-9b6c-7d8e9f0a1b2c";
  const key = "ab".repeat(32);

  it("drops the origin and query, and stands ids and keys in for themselves", () => {
    expect(
      routeShape(`${ORIGIN}/projects/${id}/runs/${id}/checkpoints/${id}?x=1`),
    ).toBe("/projects/:id/runs/:id/checkpoints/:id");
    expect(routeShape(`${ORIGIN}/api/api/v1/storage/${key}`)).toBe(
      "/api/api/v1/storage/:key",
    );
  });

  it("keeps procedure names and plain words", () => {
    expect(
      routeShape(`${ORIGIN}/api/trpc/runs.list,builds.getById?batch=1&input=x`),
    ).toBe("/api/trpc/runs.list,builds.getById");
    expect(routeShape(`${ORIGIN}/inbox`)).toBe("/inbox");
  });
});

describe("countBrowserFailures", () => {
  const api = (path: string) => `${ORIGIN}/api${path}`;

  it("counts size refusals, transport failures and 5xx the api did not answer", () => {
    const out = countBrowserFailures(
      [
        { url: `${ORIGIN}/inbox`, status: 500, byProxy: false },
        { url: api("/trpc/runs.list"), status: 502, byProxy: true },
        { url: api("/trpc/runs.list"), status: 431, byProxy: false },
        { url: api("/trpc/a,b"), status: 414, byProxy: false },
        { url: api("/auth/login"), status: 413, byProxy: false },
        { url: api("/trpc/runs.list"), status: 404, byProxy: false },
        { url: api("/trpc/runs.list"), status: 200, byProxy: false },
      ],
      [
        {
          url: api("/trpc/runs.list"),
          errorText: "net::ERR_CONNECTION_RESET",
          closing: false,
        },
      ],
    );
    expect(out.count).toBe(1 + 1 + 3 + 1);
    expect(out.inHistogram).toBe(0);
    expect(out.sample[0]).toBe("500 /inbox");
    expect(out.sample).toContain("502 /api/trpc/runs.list");
  });

  it("samples a transport failure with its error", () => {
    const out = countBrowserFailures(
      [],
      [
        {
          url: api("/trpc/runs.list?batch=1"),
          errorText: "net::ERR_CONNECTION_RESET",
          closing: false,
        },
      ],
    );
    expect(out.count).toBe(1);
    expect(out.sample).toEqual([
      "failed net::ERR_CONNECTION_RESET /api/trpc/runs.list",
    ]);
  });

  it("leaves a 5xx the api answered to the api's histogram, which has it", () => {
    const out = countBrowserFailures(
      [{ url: api("/trpc/runs.list"), status: 500, byProxy: false }],
      [],
    );
    expect(out.count).toBe(0);
    expect(out.inHistogram).toBe(1);
  });

  it("never counts an abort: the suite's (closing a context) or the page's own", () => {
    const out = countBrowserFailures(
      [],
      [
        { url: api("/trpc/a"), errorText: "net::ERR_ABORTED", closing: true },
        { url: api("/trpc/a"), errorText: "net::ERR_ABORTED", closing: true },
        { url: api("/trpc/b"), errorText: "net::ERR_ABORTED", closing: false },
      ],
    );
    expect(out.count).toBe(0);
    expect(out.aborted).toEqual({ suite: 2, page: 1 });
  });

  it("strips ids from the sample, and keeps it short", () => {
    const id = "0b7a2c1e-3f4d-4e5a-9b6c-7d8e9f0a1b2c";
    const out = countBrowserFailures(
      Array.from({ length: 9 }, () => ({
        url: `${ORIGIN}/projects/${id}`,
        status: 500,
        byProxy: false,
      })),
      [],
    );
    expect(out.count).toBe(9);
    expect(out.sample.length).toBeLessThanOrEqual(5);
    expect(out.sample.join(" ")).not.toContain(id);
  });

  it("is all zeros with nothing failing", () => {
    expect(countBrowserFailures([], [])).toEqual({
      count: 0,
      inHistogram: 0,
      aborted: { suite: 0, page: 0 },
      sample: [],
    });
  });
});
