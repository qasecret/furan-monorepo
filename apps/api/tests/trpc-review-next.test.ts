import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";

import { Registry } from "@furan/telemetry";
import { createTRPCClient, httpBatchLink, TRPCClientError } from "@trpc/client";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { recordReviewNext } from "../src/lib/review/metrics.js";
import type { AppRouter } from "../src/trpc/v1/router.js";

import { createTestApp, type TestApp } from "./helpers.js";
import {
  addReviewBuild,
  addReviewRun,
  cleanupReviewSeeds,
  seedReviewRun,
  type ReviewRunSpec,
  type ReviewSeed,
  type ReviewUser,
} from "./review-fixtures.js";

const skip = !process.env.DATABASE_URL;
const d = skip ? describe.skip : describe;

function makeClient(baseUrl: string, jwt?: string) {
  return createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: `${baseUrl}/trpc`,
        headers: jwt ? { authorization: `Bearer ${jwt}` } : {},
      }),
    ],
  });
}
type Client = ReturnType<typeof makeClient>;

/** The tRPC error code an HTTP call was refused with. */
async function refusedWith(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(TRPCClientError);
    return (e as TRPCClientError<AppRouter>).data?.code ?? "";
  }
  throw new Error("expected the call to be refused");
}

type MetricsJson = Awaited<ReturnType<Registry["getMetricsAsJSON"]>>;

/** The samples of one metric, by sample name (`_count`, `_sum`, `_bucket`). */
function samples(json: MetricsJson, name: string) {
  const metric = json.find((m) => m.name === name);
  return (metric?.values ?? []).map((v) => ({
    name: (v as { metricName?: string }).metricName ?? name,
    labels: v.labels,
    value: v.value,
  }));
}

/** The counter's value for one `scope` label (0 when never counted). */
function scopeCount(json: MetricsJson, scope: string): number {
  return (
    samples(json, "furan_review_next_total").find(
      (s) => s.labels.scope === scope,
    )?.value ?? 0
  );
}

function histogramCount(json: MetricsJson): number {
  return (
    samples(json, "furan_review_next_seconds").find(
      (s) => s.name === "furan_review_next_seconds_count",
    )?.value ?? 0
  );
}

const MOBILE = "375x812";
const DESKTOP = "1280x720";

describe("recordReviewNext", () => {
  test("counts by scope and observes the seconds in the buckets", async () => {
    const registry = new Registry();
    recordReviewNext(registry, "run", 0.03);
    recordReviewNext(registry, "run", 0.4);
    recordReviewNext(registry, "none", 0.001);

    const json = await registry.getMetricsAsJSON();
    expect(scopeCount(json, "run")).toBe(2);
    expect(scopeCount(json, "none")).toBe(1);
    expect(scopeCount(json, "batch")).toBe(0);

    const hist = samples(json, "furan_review_next_seconds");
    const bucket = (le: number | string) =>
      hist.find(
        (s) =>
          s.name === "furan_review_next_seconds_bucket" && s.labels.le === le,
      )?.value;
    // 0.001 is inside the first bucket, 0.03 inside 0.05, 0.4 inside 0.5.
    expect(bucket(0.005)).toBe(1);
    expect(bucket(0.025)).toBe(1);
    expect(bucket(0.05)).toBe(2);
    expect(bucket(0.25)).toBe(2);
    expect(bucket(0.5)).toBe(3);
    expect(bucket(1)).toBe(3);
    expect(bucket("+Inf")).toBe(3);
    expect(histogramCount(json)).toBe(3);
    expect(
      hist.find((s) => s.name === "furan_review_next_seconds_sum")?.value,
    ).toBeCloseTo(0.431, 6);
  });

  test("a negative or non-finite duration is counted but never observed, and never throws", async () => {
    const registry = new Registry();
    expect(() => {
      recordReviewNext(registry, "batch", -1);
      recordReviewNext(registry, "batch", Number.NaN);
      recordReviewNext(registry, "batch", Infinity);
    }).not.toThrow();
    const json = await registry.getMetricsAsJSON();
    expect(scopeCount(json, "batch")).toBe(3);
    expect(histogramCount(json)).toBe(0);
  });

  test("metrics are per-registry (no cross-registry bleed)", async () => {
    const a = new Registry();
    const b = new Registry();
    recordReviewNext(a, "run", 0.01);
    recordReviewNext(b, "run", 0.01);
    recordReviewNext(b, "run", 0.01);
    expect(scopeCount(await a.getMetricsAsJSON(), "run")).toBe(1);
    expect(scopeCount(await b.getMetricsAsJSON(), "run")).toBe(2);
  });
});

d("review.next", () => {
  let h: TestApp;
  let baseUrl: string;
  const seeds: ReviewSeed[] = [];

  beforeAll(async () => {
    h = await createTestApp();
    h.app.log.level = "silent";
    await h.app.listen({ port: 0, host: "127.0.0.1" });
    const addr = h.app.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });
  afterAll(async () => {
    await cleanupReviewSeeds(h, seeds);
    await h.close();
  });

  const as = (u: ReviewUser | null): Client =>
    makeClient(baseUrl, u?.jwt ?? undefined);

  async function seed(spec: ReviewRunSpec): Promise<ReviewSeed> {
    const s = await seedReviewRun(h, spec);
    seeds.push(s);
    return s;
  }

  /** A batch with a, b (passed), c, in one run: `a` is followed by `c`. */
  const abc = (): Promise<ReviewSeed> =>
    seed({
      checkpoints: [
        { name: "a", verdict: "unresolved" },
        { name: "b", verdict: "passed" },
        { name: "c", verdict: "unresolved" },
      ],
    });

  /** A copy: prom-client hands out its live sample objects, which later `inc`s mutate. */
  async function metricsJson(): Promise<MetricsJson> {
    return structuredClone(await h.telemetry.metrics.getMetricsAsJSON());
  }

  test("member reads the next step", async () => {
    const s = await abc();
    const [a, , c] = s.shotsInOrder;

    const r = await as(s.editor).review.next.query({
      projectId: s.projectId,
      at: { buildId: s.buildId, runId: s.runId, checkpointId: a!.id },
    });
    expect(r).toEqual({
      target: { buildId: s.buildId, runId: s.runId, checkpointId: c!.id },
      scope: "run",
      remaining: { run: 1, batch: 1, batchUnfiltered: 1, projectBatches: 1 },
      nextBatch: null,
    });
  });

  test("without `at` it starts at the newest batch with a pending step", async () => {
    const s = await abc();
    const [a] = s.shotsInOrder;

    const r = await as(s.editor).review.next.query({ projectId: s.projectId });
    expect(r.scope).toBe("batch");
    expect(r.target).toEqual({
      buildId: s.buildId,
      runId: s.runId,
      checkpointId: a!.id,
    });
  });

  test("an admin who is not a member reads it", async () => {
    const s = await abc();
    const r = await as(s.admin).review.next.query({
      projectId: s.projectId,
      at: { buildId: s.buildId },
    });
    expect(r.scope).toBe("batch");
    expect(r.target?.buildId).toBe(s.buildId);
  });

  // The brief named this "guest may read". The gate is `projectMember("read")`,
  // and that middleware refuses a guest everywhere (like `runs.facets`,
  // `builds.list`, ...): a guest has no project-scoped read at all.
  test("a guest member is FORBIDDEN, like every project-scoped read", async () => {
    const s = await abc();
    expect(
      await refusedWith(
        as(s.guest).review.next.query({ projectId: s.projectId }),
      ),
    ).toBe("FORBIDDEN");
  });

  test("outsider is FORBIDDEN", async () => {
    const s = await abc();
    expect(
      await refusedWith(
        as(s.outsider).review.next.query({
          projectId: s.projectId,
          at: { buildId: s.buildId },
        }),
      ),
    ).toBe("FORBIDDEN");
  });

  test("a member of another project is FORBIDDEN, and nobody signed in is UNAUTHORIZED", async () => {
    const mine = await abc();
    const theirs = await abc();
    expect(
      await refusedWith(
        as(mine.editor).review.next.query({ projectId: theirs.projectId }),
      ),
    ).toBe("FORBIDDEN");
    expect(
      await refusedWith(
        as(null).review.next.query({ projectId: mine.projectId }),
      ),
    ).toBe("UNAUTHORIZED");
  });

  describe("`at` must belong to the project", () => {
    test("an at.buildId from another project is NOT_FOUND", async () => {
      const mine = await abc();
      const theirs = await abc();
      expect(
        await refusedWith(
          as(mine.editor).review.next.query({
            projectId: mine.projectId,
            at: { buildId: theirs.buildId },
          }),
        ),
      ).toBe("NOT_FOUND");
      // An unknown build looks the same.
      expect(
        await refusedWith(
          as(mine.editor).review.next.query({
            projectId: mine.projectId,
            at: { buildId: randomUUID() },
          }),
        ),
      ).toBe("NOT_FOUND");
    });

    test("an admin gets the same NOT_FOUND for a build of another project", async () => {
      const mine = await abc();
      const theirs = await abc();
      expect(
        await refusedWith(
          as(mine.admin).review.next.query({
            projectId: mine.projectId,
            at: { buildId: theirs.buildId },
          }),
        ),
      ).toBe("NOT_FOUND");
    });

    test("an at.runId from another project, or from another build, is NOT_FOUND", async () => {
      const mine = await abc();
      const theirs = await abc();
      const other = await addReviewBuild(h, mine, {
        spec: { checkpoints: [{ name: "z", verdict: "unresolved" }] },
      });
      const query = (at: { buildId: string; runId: string }) =>
        refusedWith(
          as(mine.editor).review.next.query({
            projectId: mine.projectId,
            at,
          }),
        );
      // The run is real but belongs to another project.
      expect(await query({ buildId: mine.buildId, runId: theirs.runId })).toBe(
        "NOT_FOUND",
      );
      // The run is in the project but not in `at.buildId`.
      expect(await query({ buildId: mine.buildId, runId: other.runId })).toBe(
        "NOT_FOUND",
      );
      expect(await query({ buildId: mine.buildId, runId: randomUUID() })).toBe(
        "NOT_FOUND",
      );
    });

    test("a checkpointId not in at.runId is NOT_FOUND", async () => {
      const s = await abc();
      const second = await addReviewRun(h, s, {
        checkpoints: [{ name: "d", verdict: "unresolved" }],
      });
      const foreign = await abc();
      const query = (checkpointId: string) =>
        refusedWith(
          as(s.editor).review.next.query({
            projectId: s.projectId,
            at: { buildId: s.buildId, runId: s.runId, checkpointId },
          }),
        );
      // A step of the same build, but of the other run.
      expect(await query(second.shotsInOrder[0]!.id)).toBe("NOT_FOUND");
      // A step of another project, and an unknown one.
      expect(await query(foreign.shotsInOrder[0]!.id)).toBe("NOT_FOUND");
      expect(await query(randomUUID())).toBe("NOT_FOUND");
    });

    test("a checkpointId without a runId is NOT_FOUND, even when the step is real", async () => {
      const s = await abc();
      expect(
        await refusedWith(
          as(s.editor).review.next.query({
            projectId: s.projectId,
            at: { buildId: s.buildId, checkpointId: s.shotsInOrder[0]!.id },
          }),
        ),
      ).toBe("NOT_FOUND");
    });

    test("a build and a run alone are valid positions", async () => {
      const s = await abc();
      const client = as(s.editor);
      const inBuild = await client.review.next.query({
        projectId: s.projectId,
        at: { buildId: s.buildId },
      });
      expect(inBuild.target?.checkpointId).toBe(s.shotsInOrder[0]!.id);
      const inRun = await client.review.next.query({
        projectId: s.projectId,
        at: { buildId: s.buildId, runId: s.runId },
      });
      expect(inRun.scope).toBe("run");
      expect(inRun.target?.checkpointId).toBe(s.shotsInOrder[0]!.id);
    });
  });

  describe("input", () => {
    test("excludeBuildIds > 50 is BAD_REQUEST", async () => {
      const s = await abc();
      const ids = (n: number) => Array.from({ length: n }, () => randomUUID());
      expect(
        await refusedWith(
          as(s.editor).review.next.query({
            projectId: s.projectId,
            excludeBuildIds: ids(51),
          }),
        ),
      ).toBe("BAD_REQUEST");
      // 50 is the limit.
      const ok = await as(s.editor).review.next.query({
        projectId: s.projectId,
        excludeBuildIds: ids(50),
      });
      expect(ok.target?.buildId).toBe(s.buildId);
    });

    test("malformed ids, facets and directions are BAD_REQUEST", async () => {
      const s = await abc();
      const client = as(s.editor);
      const bad = (input: Record<string, unknown>) =>
        refusedWith(
          client.review.next.query({
            projectId: s.projectId,
            ...input,
          } as never),
        );
      expect(await bad({ projectId: "nope" })).toBe("BAD_REQUEST");
      expect(await bad({ at: { buildId: "nope" } })).toBe("BAD_REQUEST");
      expect(await bad({ direction: "sideways" })).toBe("BAD_REQUEST");
      expect(await bad({ facets: { viewport: "" } })).toBe("BAD_REQUEST");
      expect(await bad({ facets: { viewport: "x".repeat(33) } })).toBe(
        "BAD_REQUEST",
      );
      expect(await bad({ facets: { browser: "x".repeat(65) } })).toBe(
        "BAD_REQUEST",
      );
      expect(await bad({ facets: { os: "x".repeat(65) } })).toBe("BAD_REQUEST");
      expect(await bad({ facets: { device: "x".repeat(65) } })).toBe(
        "BAD_REQUEST",
      );
      // The limits themselves are fine.
      const edge = await client.review.next.query({
        projectId: s.projectId,
        facets: {
          browser: "b".repeat(64),
          viewport: "v".repeat(32),
          os: "o".repeat(64),
          device: "d".repeat(64),
        },
      });
      expect(edge.scope).toBe("none");
    });
  });

  describe("the input reaches the queue", () => {
    test("direction prev walks backwards", async () => {
      const s = await abc();
      const [a, , c] = s.shotsInOrder;
      const r = await as(s.editor).review.next.query({
        projectId: s.projectId,
        at: { buildId: s.buildId, runId: s.runId, checkpointId: c!.id },
        direction: "prev",
      });
      expect(r.target?.checkpointId).toBe(a!.id);
      expect(r.scope).toBe("run");
    });

    test("facets scope the walk", async () => {
      const s = await seed({
        checkpoints: [
          { name: "a", verdict: "unresolved", viewport: DESKTOP },
          { name: "b", verdict: "unresolved", viewport: MOBILE },
          { name: "c", verdict: "unresolved", viewport: DESKTOP },
        ],
      });
      const [a, b, c] = s.shotsInOrder;
      const at = { buildId: s.buildId, runId: s.runId, checkpointId: a!.id };
      const client = as(s.editor);
      expect(
        (await client.review.next.query({ projectId: s.projectId, at })).target
          ?.checkpointId,
      ).toBe(b!.id);
      const desktop = await client.review.next.query({
        projectId: s.projectId,
        at,
        facets: { viewport: DESKTOP },
      });
      expect(desktop.target?.checkpointId).toBe(c!.id);
      expect(desktop.remaining.run).toBe(1);
      expect(desktop.remaining.batchUnfiltered).toBe(2);
    });

    test("excludeBuildIds keeps a batch from being the next one", async () => {
      const s = await seed({
        checkpoints: [{ name: "only", verdict: "unresolved" }],
      });
      const newer = await addReviewBuild(h, s, {
        spec: { checkpoints: [{ name: "n", verdict: "unresolved" }] },
      });
      const at = {
        buildId: s.buildId,
        runId: s.runId,
        checkpointId: s.shotsInOrder[0]!.id,
      };
      const client = as(s.editor);
      const open = await client.review.next.query({
        projectId: s.projectId,
        at,
      });
      expect(open.scope).toBe("nextBatch");
      expect(open.target?.buildId).toBe(newer.buildId);
      expect(open.nextBatch?.buildId).toBe(newer.buildId);

      const skipped = await client.review.next.query({
        projectId: s.projectId,
        at,
        excludeBuildIds: [newer.buildId],
      });
      expect(skipped.scope).toBe("none");
      expect(skipped.target).toBeNull();
      expect(skipped.nextBatch).toBeNull();
    });
  });

  test("metrics count by scope", async () => {
    const run = await abc();
    const batch = await seed({
      checkpoints: [{ name: "p", verdict: "unresolved" }],
    });
    await addReviewRun(h, batch, {
      checkpoints: [{ name: "q", verdict: "unresolved" }],
    });
    const nextBatch = await seed({
      checkpoints: [{ name: "x", verdict: "unresolved" }],
    });
    await addReviewBuild(h, nextBatch, {
      spec: { checkpoints: [{ name: "y", verdict: "unresolved" }] },
    });
    const none = await seed({
      checkpoints: [{ name: "solo", verdict: "unresolved" }],
    });

    const stepAt = (s: ReviewSeed, i = 0) => ({
      buildId: s.buildId,
      runId: s.runId,
      checkpointId: s.shotsInOrder[i]!.id,
    });
    const before = await metricsJson();

    const calls = [
      { s: run, scope: "run" },
      { s: batch, scope: "batch" },
      { s: nextBatch, scope: "nextBatch" },
      { s: none, scope: "none" },
    ] as const;
    for (const { s, scope } of calls) {
      const r = await as(s.editor).review.next.query({
        projectId: s.projectId,
        at: stepAt(s),
      });
      expect(r.scope).toBe(scope);
    }
    // A second `run` answer.
    await as(run.editor).review.next.query({
      projectId: run.projectId,
      at: stepAt(run),
    });

    // Refusals are not counted: a failed gate, an `at` that is not the
    // project's, a malformed input.
    await refusedWith(
      as(run.outsider).review.next.query({ projectId: run.projectId }),
    );
    await refusedWith(
      as(run.editor).review.next.query({
        projectId: run.projectId,
        at: { buildId: none.buildId },
      }),
    );
    await refusedWith(
      as(run.editor).review.next.query({
        projectId: run.projectId,
        excludeBuildIds: Array.from({ length: 51 }, () => randomUUID()),
      }),
    );

    const after = await metricsJson();
    const delta = (scope: string) =>
      scopeCount(after, scope) - scopeCount(before, scope);
    expect(delta("run")).toBe(2);
    expect(delta("batch")).toBe(1);
    expect(delta("nextBatch")).toBe(1);
    expect(delta("none")).toBe(1);
    expect(histogramCount(after) - histogramCount(before)).toBe(5);
  });
});
