import { randomUUID } from "node:crypto";

import {
  and,
  asc,
  baselines,
  baselineWriteTime,
  checkpointDecisions,
  createDb,
  diffRegions,
  eq,
  inArray,
  projects,
  recomputeRunStatus,
  recomputeRunTotals,
  screenshots,
  sql,
  testRuns,
  testVariations,
  users,
  type DB,
} from "@furan/db";
import { createQueue, diffJobId, type DiffJob, type Queue } from "@furan/queue";
import { createStorage, objectKey, type Storage } from "@furan/storage";
import { Redis } from "ioredis";
import { Registry } from "prom-client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { commitStep } from "../src/commit-step.js";
import { diffStep, type StepResult } from "../src/diff-step.js";
import {
  handleDiffJob,
  loadStepContext,
  type DiffJobOutcome,
  type StepJob,
} from "../src/handler.js";
import { startDiffWorker } from "../src/runtime.js";

import { stepJobsFor } from "./helpers/step-jobs.js";
import {
  createStepSeeder,
  square,
  type ScenarioSpec,
  type Seeded,
} from "./helpers/step-seed.js";

// `diffStep` runs as itself unless a test slips a hook in after it, between
// the diff and the commit.
vi.mock("../src/diff-step.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/diff-step.js")>();
  return { ...actual, diffStep: vi.fn(actual.diffStep) };
});
const { diffStep: realDiffStep } = await vi.importActual<
  typeof import("../src/diff-step.js")
>("../src/diff-step.js");

/**
 * One step per job under a version guard (spec 2026-10-23 §3, §4): a step job
 * diffs its step and commits it under run → step locks, re-checking the
 * step's version; the run totals and status are recomputed in that commit.
 */

const skip =
  !process.env.DATABASE_URL ||
  !process.env.REDIS_URL ||
  !process.env.S3_ENDPOINT;
const desc = skip ? describe.skip : describe;

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
  child: () => mockLogger,
} as unknown as Parameters<typeof handleDiffJob>[1];

type Sample = {
  metricName?: string;
  labels: Record<string, string | number | undefined>;
  value: number;
};

async function histogramSeries(
  registry: Registry,
  name: string,
  labels: Record<string, string> = {},
): Promise<{ count: number; sum: number }> {
  const metric = (await registry.getMetricsAsJSON()).find(
    (m) => m.name === name,
  );
  if (!metric) return { count: 0, sum: 0 };
  const samples = metric.values as Sample[];
  const pick = (suffix: string): number =>
    samples.find(
      (s) =>
        s.metricName === `${name}${suffix}` &&
        Object.entries(labels).every(([k, v]) => s.labels[k] === v),
    )?.value ?? 0;
  return { count: pick("_count"), sum: pick("_sum") };
}

/** A Postgres error code, wherever the driver or Drizzle put it. */
function pgCode(err: unknown): string | undefined {
  for (let e = err; e; e = (e as { cause?: unknown }).cause) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

desc("step jobs (integration)", () => {
  let db: DB;
  let closeDb: () => Promise<void>;
  let storage: Storage;
  let redis: Redis;
  let userId: string;
  const projectIds: string[] = [];
  let seed: (spec: ScenarioSpec) => Promise<Seeded>;

  beforeAll(async () => {
    const created = createDb();
    db = created.db;
    closeDb = created.close;
    storage = createStorage();
    redis = new Redis(process.env.REDIS_URL!);
    const [u] = await db
      .insert(users)
      .values({
        email: `dw-step-job-${Date.now()}@x.test`,
        hashedPassword: "x",
        firstName: "dw",
        lastName: "step-job",
        role: "admin",
      })
      .returning();
    userId = u!.id;
    seed = createStepSeeder({ db, storage, userId, projectIds });
  }, 60_000);

  afterAll(async () => {
    for (const id of projectIds) {
      try {
        await db.delete(projects).where(eq(projects.id, id));
      } catch {
        /* best-effort cleanup */
      }
    }
    await redis.quit();
    await closeDb();
  });

  const red0 = () => square("red", 0);
  const blue0 = () => square("blue", 0);
  const red144 = () => square("red", 144);

  const runOf = (s: Seeded) => ({
    runId: s.candidateRunId,
    projectId: s.projectId,
  });

  /** The step job of one step, after queueing every step of the run. */
  async function jobOf(s: Seeded, name: string): Promise<StepJob> {
    const jobs = await stepJobsFor(db, runOf(s));
    return jobs.find((j) => j.screenshotId === s.shotId[name])!;
  }

  async function stepRow(id: string) {
    const [row] = await db
      .select({
        verdict: screenshots.verdict,
        verdictAt: sql<string | null>`${screenshots.verdictAt}::text`,
        diffGeneration: screenshots.diffGeneration,
        diffPercent: screenshots.diffPercent,
        pixelMismatchCount: screenshots.pixelMismatchCount,
        baselineSource: screenshots.baselineSource,
        vlmDescription: screenshots.vlmDescription,
        ruleResolved: screenshots.ruleResolved,
        diffSignature: screenshots.diffSignature,
        diffImageKey: screenshots.diffImageKey,
        diffFailedAt: screenshots.diffFailedAt,
        diffError: screenshots.diffError,
      })
      .from(screenshots)
      .where(eq(screenshots.id, id));
    return row!;
  }

  async function regionsOf(screenshotId: string) {
    return db
      .select({
        id: diffRegions.id,
        bbox: diffRegions.bbox,
        description: diffRegions.description,
      })
      .from(diffRegions)
      .where(eq(diffRegions.screenshotId, screenshotId))
      .orderBy(asc(diffRegions.id));
  }

  async function runRow(runId: string) {
    const [row] = await db
      .select({
        status: testRuns.status,
        diffPercent: testRuns.diffPercent,
        pixelMisMatchCount: testRuns.pixelMisMatchCount,
        diffName: testRuns.diffName,
        baselineSource: testRuns.baselineSource,
        vlmDescription: testRuns.vlmDescription,
        resolutionSource: testRuns.resolutionSource,
        primarySignature: testRuns.primarySignature,
      })
      .from(testRuns)
      .where(eq(testRuns.id, runId));
    return row!;
  }

  /** Points a step at a new candidate image, stored under its own key. */
  async function setCandidate(screenshotId: string, img: Buffer) {
    const key = `${objectKey(img)}-${randomUUID()}`;
    await storage.put(key, img, "image/png");
    await db
      .update(screenshots)
      .set({ imageKey: key })
      .where(eq(screenshots.id, screenshotId));
  }

  /** What `diffStep` returns for a step as it is stored now. */
  async function diffNow(s: Seeded, name: string): Promise<StepResult> {
    const project = await db.query.projects.findFirst({
      where: eq(projects.id, s.projectId),
    });
    const run = await db.query.testRuns.findFirst({
      where: eq(testRuns.id, s.candidateRunId),
    });
    const [cs] = await db
      .select()
      .from(screenshots)
      .where(eq(screenshots.id, s.shotId[name]!));
    const ctx = await loadStepContext({ db, storage, redis }, mockLogger, {
      project: project!,
      run: run!,
      variationIds: [cs!.testVariationId],
    });
    return realDiffStep(ctx, cs!);
  }

  /**
   * The worker, in this process, on its own queue: every job it handles runs
   * the real `handleDiffJob`, and its outcome is recorded.
   */
  async function withWorker(
    fn: (w: {
      queue: Queue<DiffJob>;
      registry: Registry;
      outcomes: DiffJobOutcome[];
      run: (job: StepJob) => Promise<void>;
    }) => Promise<void>,
  ): Promise<void> {
    const prefix = `furan-step-job-${randomUUID().slice(0, 8)}`;
    const queue = createQueue("diff", { prefix });
    const registry = new Registry();
    const outcomes: DiffJobOutcome[] = [];
    const runtime = startDiffWorker({
      db,
      storage,
      redis,
      logger: mockLogger,
      registry,
      queuePrefix: prefix,
      concurrency: 1,
      sweeper: false,
      handler: async (...args) => {
        const outcome = await handleDiffJob(...args);
        outcomes.push(outcome);
        return outcome;
      },
    });
    const run = async (job: StepJob): Promise<void> => {
      const jobId = diffJobId(job.screenshotId, job.generation);
      const done = new Promise<void>((resolve, reject) => {
        runtime.worker.on("completed", (j) => {
          if (j.id === jobId) resolve();
        });
        runtime.worker.on("failed", (j, err) => {
          if (j?.id === jobId) reject(err);
        });
      });
      await queue.add("diff", job, { jobId, attempts: 1 });
      await done;
    };
    try {
      await fn({ queue, registry, outcomes, run });
    } finally {
      await runtime.close();
      const client = await queue.client;
      await queue.obliterate({ force: true });
      await queue.close();
      client.disconnect();
    }
  }

  it("diffs one step and stores its results", async () => {
    const s = await seed({
      steps: [
        { name: "home", baseline: await red0(), candidate: await blue0() },
        { name: "cart", baseline: await blue0(), candidate: await blue0() },
      ],
    });
    // An earlier failed diff of the step, which a successful one clears.
    await db
      .update(screenshots)
      .set({
        verdict: "unresolved",
        diffFailedAt: new Date(),
        diffError: "internal",
      })
      .where(eq(screenshots.id, s.shotId.home!));
    const job = await jobOf(s, "home");

    await withWorker(async ({ registry, outcomes, run }) => {
      await run(job);

      expect(outcomes).toEqual([{ checkpoints: 1 }]);
      expect(
        await histogramSeries(registry, "furan_diff_job_checkpoints"),
      ).toEqual({ count: 1, sum: 1 });
      expect(
        (
          await histogramSeries(registry, "furan_diff_job_duration_seconds", {
            outcome: "completed",
          })
        ).count,
      ).toBe(1);
    });

    const home = await stepRow(s.shotId.home!);
    expect(home).toMatchObject({
      verdict: "unresolved",
      diffGeneration: job.generation,
      diffPercent: 12.825625,
      pixelMismatchCount: 20521,
      baselineSource: "this_branch",
      vlmDescription: null,
      ruleResolved: false,
      diffFailedAt: null,
      diffError: null,
    });
    expect(home.verdictAt).not.toBeNull();
    expect(home.diffSignature).toMatch(/^v1:/);
    expect(home.diffImageKey).toMatch(/^[0-9a-f]{64}$/);
    expect(await regionsOf(s.shotId.home!)).toHaveLength(1);
    // Only that step: cart is still waiting for its own job.
    expect((await stepRow(s.shotId.cart!)).verdict).toBeNull();
    expect(await runRow(s.candidateRunId)).toMatchObject({
      status: "running",
      diffPercent: 12.825625,
      pixelMisMatchCount: 20521,
      diffName: home.diffImageKey,
      baselineSource: "this_branch",
    });
  }, 60_000);

  it("a version bumped during the diff leaves no write (stale)", async () => {
    const s = await seed({
      steps: [
        { name: "home", baseline: await red0(), candidate: await blue0() },
      ],
    });
    const home = s.shotId.home!;
    const first = await jobOf(s, "home");
    await handleDiffJob(first, mockLogger, { db, storage, redis });
    const before = await stepRow(home);
    const regionsBefore = await regionsOf(home);
    expect(before.verdict).toBe("unresolved");
    expect(regionsBefore).toHaveLength(1);

    // The step is re-uploaded as its baseline's image: a diff of it would
    // pass with no region. Version 2 is queued for it...
    await setCandidate(home, await red0());
    const second = await jobOf(s, "home");
    // ...and while version 2 diffs, version 3 is queued.
    let bumpedTo: number | undefined;
    vi.mocked(diffStep).mockImplementationOnce(async (ctx, cs) => {
      const result = await realDiffStep(ctx, cs);
      bumpedTo = (await jobOf(s, "home")).generation;
      return result;
    });

    const events: string[] = [];
    const sub = new Redis(process.env.REDIS_URL!);
    await sub.subscribe(`run:${s.candidateRunId}:events`);
    sub.on("message", (_ch, msg) => events.push(msg));
    await new Promise((r) => setTimeout(r, 100));
    try {
      await withWorker(async ({ registry, outcomes, run }) => {
        await run(second);

        expect(outcomes).toEqual([{ checkpoints: 0, stale: true }]);
        expect(
          (
            await histogramSeries(registry, "furan_diff_job_duration_seconds", {
              outcome: "stale",
            })
          ).count,
        ).toBe(1);
        expect(
          (
            await histogramSeries(registry, "furan_diff_job_duration_seconds", {
              outcome: "completed",
            })
          ).count,
        ).toBe(0);
        expect(
          await histogramSeries(registry, "furan_diff_job_checkpoints"),
        ).toEqual({ count: 1, sum: 0 });
      });
      await new Promise((r) => setTimeout(r, 200));
    } finally {
      sub.disconnect();
    }

    expect(bumpedTo).toBe(second.generation + 1);
    const after = await stepRow(home);
    expect(after).toEqual({ ...before, diffGeneration: bumpedTo });
    expect(await regionsOf(home)).toEqual(regionsBefore);
    // A stale job publishes nothing.
    expect(events).toEqual([]);
  }, 60_000);

  it("two versions of one step committing in either order: the newest wins, no duplicate regions", async () => {
    const s = await seed({
      steps: [
        { name: "home", baseline: await red0(), candidate: await blue0() },
      ],
    });
    const home = s.shotId.home!;
    const deps = { db, storage, redis };
    const commit = (job: StepJob, result: StepResult) =>
      commitStep(deps, job, result, mockLogger);

    /** Queues a new version of the step with `img`, and diffs it. */
    async function version(img: Buffer) {
      await setCandidate(home, img);
      const job = await jobOf(s, "home");
      return { job, result: await diffNow(s, "home") };
    }
    async function expectStored(result: StepResult) {
      expect((await stepRow(home)).diffImageKey).toBe(result.diffImageKey);
      const regions = await regionsOf(home);
      expect(regions).toHaveLength(result.regions.length);
      expect(regions.map((r) => r.bbox)).toEqual(
        expect.arrayContaining(result.regions.map((r) => r.bbox)),
      );
    }

    // The recolour: one region. The move: two.
    const recolor = await version(await blue0());
    const moved = await version(await red144());
    expect(recolor.result.regions).toHaveLength(1);
    expect(moved.result.regions).toHaveLength(2);

    // Newest first, then the older: the older is stale.
    expect((await commit(moved.job, moved.result)).kind).toBe("committed");
    expect(await commit(recolor.job, recolor.result)).toEqual({
      kind: "stale",
    });
    await expectStored(moved.result);

    // Two new versions, the older committing first: it is already stale.
    const v3 = await version(await blue0());
    const v4 = await version(await red144());
    expect(await commit(v3.job, v3.result)).toEqual({ kind: "stale" });
    expect((await commit(v4.job, v4.result)).kind).toBe("committed");
    await expectStored(v4.result);

    // An older version that committed while it was current is replaced, not
    // added to, by the newer one.
    const v5 = await version(await blue0());
    expect((await commit(v5.job, v5.result)).kind).toBe("committed");
    await expectStored(v5.result);
    const v6 = await version(await red144());
    expect((await commit(v6.job, v6.result)).kind).toBe("committed");
    await expectStored(v6.result);

    // Both at once: one commits, the other is stale.
    const v7 = await version(await blue0());
    const v8 = await version(await red144());
    const both = await Promise.all([
      commit(v7.job, v7.result),
      commit(v8.job, v8.result),
    ]);
    expect(both.map((c) => c.kind)).toEqual(["stale", "committed"]);
    await expectStored(v8.result);
    expect((await stepRow(home)).diffGeneration).toBe(v8.job.generation);
  }, 60_000);

  it("four steps of one run committing concurrently give consistent totals and status", async () => {
    const s = await seed({
      steps: [
        { name: "home", baseline: await red0(), candidate: await blue0() },
        { name: "moved", baseline: await red0(), candidate: await red144() },
        { name: "same", baseline: await blue0(), candidate: await blue0() },
        { name: "first", baseline: null, candidate: await red0() },
      ],
    });
    const ownRegions: Record<string, number> = {
      home: 1,
      moved: 2,
      same: 0,
      first: 0,
    };

    // Several rounds, each re-queueing every step, for more interleavings.
    for (let round = 0; round < 3; round++) {
      const jobs = await stepJobsFor(db, runOf(s));
      const outcomes = await Promise.all(
        jobs.map((job) =>
          handleDiffJob(job, mockLogger, { db, storage, redis }),
        ),
      );
      expect(outcomes).toEqual(jobs.map(() => ({ checkpoints: 1 })));

      const stored = await runRow(s.candidateRunId);
      // Recomputing from the stored steps changes nothing...
      await db.transaction((tx) => recomputeRunTotals(tx, s.candidateRunId));
      expect(await runRow(s.candidateRunId)).toEqual(stored);
      // ...and the status is the rollup of the stored verdicts.
      const rollup = await db.transaction((tx) =>
        recomputeRunStatus(tx, s.candidateRunId),
      );
      expect(rollup).toEqual({
        before: stored.status,
        after: stored.status,
        changed: false,
      });
      expect(stored).toMatchObject({
        status: "unresolved",
        diffPercent: 25.785625,
        pixelMisMatchCount: 61778,
        diffName: (await stepRow(s.shotId.moved!)).diffImageKey,
        baselineSource: "this_branch",
      });
      // Each step holds exactly its own regions.
      for (const [name, count] of Object.entries(ownRegions)) {
        expect(await regionsOf(s.shotId[name]!)).toHaveLength(count);
      }
      const all = await db
        .select({ id: diffRegions.id })
        .from(diffRegions)
        .where(eq(diffRegions.runId, s.candidateRunId));
      expect(all).toHaveLength(3);
    }
  }, 120_000);

  it("totals and status change in the same transaction", async () => {
    // The recolour commits first (12.8%, the run still `running`); the move
    // last (25.8%), which is also the commit that ends `running`.
    for (let round = 0; round < 3; round++) {
      const s = await seed({
        steps: [
          { name: "home", baseline: await red0(), candidate: await blue0() },
          { name: "moved", baseline: await red0(), candidate: await red144() },
        ],
      });
      const jobs = await stepJobsFor(db, runOf(s));

      type Seen = {
        status: string;
        diffPercent: number | null;
        diffName: string | null;
        baselineSource: string | null;
      };
      const seen: Seen[] = [];
      let done = false;
      // Status first, then the totals, in one snapshot.
      const read = () =>
        db.transaction(
          async (tx) => {
            const [a] = await tx
              .select({ status: testRuns.status })
              .from(testRuns)
              .where(eq(testRuns.id, s.candidateRunId));
            const [b] = await tx
              .select({
                diffPercent: testRuns.diffPercent,
                diffName: testRuns.diffName,
                baselineSource: testRuns.baselineSource,
              })
              .from(testRuns)
              .where(eq(testRuns.id, s.candidateRunId));
            return { ...a!, ...b! };
          },
          { isolationLevel: "repeatable read" },
        );
      const reader = (async () => {
        while (!done) seen.push(await read());
      })();
      try {
        for (const job of jobs) {
          await handleDiffJob(job, mockLogger, { db, storage, redis });
        }
      } finally {
        done = true;
        await reader;
      }
      const final = await read();
      seen.push(final);

      expect(final.status).toBe("unresolved");
      expect(final.diffPercent).toBe(25.785625);
      for (const row of seen.filter((r) => r.status !== "running")) {
        expect(row).toEqual(final);
      }
    }
  }, 120_000);

  it("concurrent decision and step commit do not deadlock", async () => {
    // A hash match, so the commit auto-approves and takes the variation lock.
    const s = await seed({
      autoApproveFeature: true,
      steps: [
        {
          name: "home",
          baseline: await blue0(),
          candidate: await blue0(),
          sameKey: true,
        },
      ],
    });
    const home = s.shotId.home!;
    const variationId = s.variationId.home!;
    const runId = s.candidateRunId;
    const result = await diffNow(s, "home");
    expect(result.autoApprove?.strategy).toBe("hash");
    const [shot] = await db
      .select({ imageKey: screenshots.imageKey })
      .from(screenshots)
      .where(eq(screenshots.id, home));

    const jitter = () => Math.floor(Math.random() * 5);
    const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

    /**
     * The review decision core's lock sequence for an approve of this step
     * (apps/api/src/lib/review; not imported across apps), statement for
     * statement in the same modes: its runs ascending, then its variations
     * ascending, then the promotion's write phase in a savepoint.
     */
    const decide = () =>
      db.transaction(async (tx) => {
        // decide.ts:155 → targets.ts:102-126 (lockRunsBy).
        await tx
          .select({ id: testRuns.id })
          .from(testRuns)
          .where(
            and(
              inArray(testRuns.id, [runId]),
              eq(testRuns.projectId, s.projectId),
            ),
          )
          .orderBy(asc(testRuns.id))
          .for("no key update");
        await tx.execute(sql`SELECT pg_sleep(${jitter() / 1000})`);
        // decide.ts:172 → targets.ts:136-141 (lockVariations).
        await tx
          .select({ id: testVariations.id })
          .from(testVariations)
          .where(inArray(testVariations.id, [variationId]))
          .orderBy(asc(testVariations.id))
          .for("no key update");
        // decide.ts:181, the write phase's savepoint.
        await tx.transaction(async (sp) => {
          // promote.ts:121-134 and 140-156.
          await sp
            .select({ id: testVariations.id })
            .from(testVariations)
            .where(eq(testVariations.id, variationId))
            .for("no key update");
          await sp
            .select({ id: baselines.id })
            .from(baselines)
            .where(
              and(
                eq(baselines.testVariationId, variationId),
                eq(baselines.testRunId, runId),
              ),
            )
            .for("no key update");
          // promote.ts:175-198.
          await sp
            .update(testVariations)
            .set({ baselineName: shot!.imageKey, updatedAt: new Date() })
            .where(eq(testVariations.id, variationId));
          // promote.ts:215-235.
          await sp
            .insert(baselines)
            .values({
              baselineName: shot!.imageKey,
              testVariationId: variationId,
              testRunId: runId,
              userId,
              branchName: "main",
              createdAt: baselineWriteTime(),
            })
            .onConflictDoUpdate({
              target: [baselines.testVariationId, baselines.testRunId],
              set: {
                baselineName: shot!.imageKey,
                userId,
                createdAt: baselineWriteTime(),
                updatedAt: new Date(),
              },
            });
          // decide.ts:209-212.
          await sp.insert(checkpointDecisions).values({
            projectId: s.projectId,
            runId,
            screenshotId: home,
            actionId: randomUUID(),
            decision: "approved",
            actorId: userId,
            source: "viewer",
          });
          // decide.ts:215.
          await recomputeRunStatus(sp, runId);
        });
      });

    for (let i = 0; i < 20; i++) {
      const job = await jobOf(s, "home");
      const settled = await Promise.allSettled([
        pause(jitter()).then(decide),
        pause(jitter()).then(() =>
          commitStep({ db, storage, redis }, job, result, mockLogger),
        ),
      ]);
      const errors = settled.flatMap((r) =>
        r.status === "rejected" ? [r.reason] : [],
      );
      expect(errors.map(pgCode)).not.toContain("40P01");
      expect(errors).toEqual([]);
      expect(
        (settled[1] as PromiseFulfilledResult<{ kind: string }>).value.kind,
      ).toBe("committed");
      // The next iteration decides afresh.
      await db
        .delete(checkpointDecisions)
        .where(eq(checkpointDecisions.screenshotId, home));
    }
    expect((await stepRow(home)).verdict).toBe("passed");
  }, 120_000);
});
