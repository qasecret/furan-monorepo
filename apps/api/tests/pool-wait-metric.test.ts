import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createTestApp, type TestApp } from "./helpers.js";
import {
  cleanupReviewSeeds,
  cp,
  seedReviewRun,
  type ReviewSeed,
} from "./review-fixtures.js";

/**
 * `furan_db_pool_wait_seconds` (spec 2026-10-27 §8): how long a tRPC
 * procedure waits for its request transaction, from asking for it to the
 * transaction's callback starting. One sample per procedure that opens one
 * (an authenticated call), whether it then succeeds or fails; no labels.
 */

const POOL_WAIT = "furan_db_pool_wait_seconds";

const skip = !process.env.DATABASE_URL;
const d = skip ? describe.skip : describe;

/** prom-client's per-series value; `metricName` marks a histogram's `_count`. */
interface SeriesValue {
  value: number;
  labels: Record<string, string | number>;
  metricName?: string;
}

d("the pool-wait metric", () => {
  let h: TestApp;
  let s: ReviewSeed;

  beforeAll(async () => {
    h = await createTestApp();
    s = await seedReviewRun(h, { checkpoints: [cp("home", "unresolved")] });
  });

  afterAll(async () => {
    if (h) {
      await cleanupReviewSeeds(h, [s].filter(Boolean));
      await h.close();
    }
  });

  /** The histogram's sample count, and the labels of every series it has. */
  async function poolWait(): Promise<{ count: number; labels: object[] }> {
    const metric = h.telemetry.metrics.getSingleMetric(POOL_WAIT);
    expect(metric).toBeDefined();
    const { values } = await metric!.get();
    const series = values as SeriesValue[];
    const counts = series.filter((v) => v.metricName === `${POOL_WAIT}_count`);
    expect(counts).toHaveLength(1);
    return {
      count: counts[0]!.value,
      labels: series.map(({ labels }) => {
        const { le: _le, ...rest } = labels;
        return rest;
      }),
    };
  }

  /** One tRPC GET (a batch when `procedures` has more than one). */
  async function call(
    procedures: string[],
    inputs: unknown[],
    jwt: string | null,
  ): Promise<Array<{ result?: unknown; error?: unknown }>> {
    const batch = procedures.length > 1;
    const input = batch
      ? Object.fromEntries(inputs.map((v, i) => [String(i), v]))
      : inputs[0];
    const res = await h.app.inject({
      method: "GET",
      url: `/trpc/${procedures.join(",")}?${batch ? "batch=1&" : ""}input=${encodeURIComponent(
        JSON.stringify(input),
      )}`,
      headers: jwt ? { authorization: `Bearer ${jwt}` } : {},
    });
    const body = res.json() as
      | Array<{ result?: unknown; error?: unknown }>
      | { result?: unknown; error?: unknown };
    return Array.isArray(body) ? body : [body];
  }

  test("pool wait is observed once per procedure", async () => {
    // A passing procedure: one sample.
    let before = (await poolWait()).count;
    const [ok] = await call(
      ["builds.pendingCount"],
      [{ projectId: s.projectId }],
      s.editor.jwt,
    );
    expect(ok!.result).toBeDefined();
    expect((await poolWait()).count).toBe(before + 1);

    // A failing procedure (the gate answers NOT_FOUND inside the request
    // transaction): one sample.
    before = (await poolWait()).count;
    const [missing] = await call(
      ["runs.getById"],
      [{ runId: randomUUID() }],
      s.editor.jwt,
    );
    expect(missing!.error).toBeDefined();
    expect((await poolWait()).count).toBe(before + 1);

    // A failing body (the decision core refuses a step of another run): one.
    before = (await poolWait()).count;
    const refused = await h.app.inject({
      method: "POST",
      url: "/trpc/review.approve",
      headers: { authorization: `Bearer ${s.editor.jwt}` },
      payload: {
        runId: s.runId,
        actionId: randomUUID(),
        checkpointIds: [randomUUID()],
      },
    });
    // The core's refusal, not some other failure: PRECONDITION_FAILED.
    expect(refused.statusCode).toBe(412);
    expect(
      (refused.json() as { error?: { data?: { code?: string } } }).error?.data
        ?.code,
    ).toBe("PRECONDITION_FAILED");
    expect((await poolWait()).count).toBe(before + 1);

    // A batch of three: one sample per procedure.
    before = (await poolWait()).count;
    const results = await call(
      ["builds.pendingCount", "runs.getById", "builds.pendingCount"],
      [
        { projectId: s.projectId },
        { runId: s.runId },
        { projectId: s.projectId },
      ],
      s.editor.jwt,
    );
    expect(results.map((r) => r.result !== undefined)).toEqual([
      true,
      true,
      true,
    ]);
    expect((await poolWait()).count).toBe(before + 3);
  });

  test("an anonymous call opens no request transaction and adds no sample", async () => {
    const before = (await poolWait()).count;
    const [res] = await call(
      ["builds.pendingCount"],
      [{ projectId: s.projectId }],
      null,
    );
    expect(res!.error).toBeDefined();
    expect((await poolWait()).count).toBe(before);
  });

  test("it has no labels and is exposed on GET /metrics", async () => {
    await call(
      ["builds.pendingCount"],
      [{ projectId: s.projectId }],
      s.editor.jwt,
    );
    const { labels } = await poolWait();
    for (const l of labels) expect(l).toEqual({});

    const res = await h.app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(`# TYPE ${POOL_WAIT} histogram`);
    const lines = res.body
      .split("\n")
      .filter((l) => l.startsWith(`${POOL_WAIT}_`));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const keys = (/\{([^}]*)\}/.exec(line)?.[1] ?? "")
        .split(",")
        .filter(Boolean)
        .map((kv) => kv.split("=")[0])
        .filter((k) => k !== "le")
        .sort();
      // Its own series have no labels (a bucket has `le`); `service` and
      // `version` are the registry's defaults, on every metric.
      expect(keys).toEqual(["service", "version"]);
    }
    expect(
      lines.some((l) => l.startsWith(`${POOL_WAIT}_bucket{le="0.0005",`)),
    ).toBe(true);
    expect(
      lines.some((l) =>
        /^furan_db_pool_wait_seconds_count\{[^}]*\} [1-9]\d*$/.test(l),
      ),
    ).toBe(true);
    expect(lines.some((l) => l.startsWith(`${POOL_WAIT}_sum{`))).toBe(true);
  });
});
