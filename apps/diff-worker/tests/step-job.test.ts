import { randomUUID } from "node:crypto";

import {
  and,
  asc,
  autoRuleApplications,
  baselines,
  baselineWriteTime,
  bumpStepGenerations,
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
import { createStorage, objectKey, type Storage } from "@furan/storage";
import { Redis } from "ioredis";
import { Registry } from "prom-client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { commitStep, persistRuleApplications } from "../src/commit-step.js";
import { createDiffMetrics } from "../src/diff-metrics.js";
import { diffStep, type StepResult } from "../src/diff-step.js";
import {
  handleDiffJob,
  loadStepContext,
  type StepJob,
} from "../src/handler.js";

import { counterValue, histogramSeries } from "./helpers/metrics.js";
import { pgCode } from "./helpers/pg.js";
import { stepJobsFor } from "./helpers/step-jobs.js";
import {
  createStepSeeder,
  square,
  type ScenarioSpec,
  type Seeded,
} from "./helpers/step-seed.js";
import { withDiffWorker } from "./helpers/worker.js";

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

const RULES_DURATION = "furan_diff_rules_evaluation_duration_seconds";

// The candidate DOM of a step whose change is wrapped by `#box` (at 0,0).
const BOX_DOM =
  '<!doctype html><html lang="en"><head><title>t</title></head><body><div id="box">box</div></body></html>';
const BOX_0 = { x: 0, y: 0, width: 144, height: 144 };

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

  /** The worker, in this process, on its own queue (`withDiffWorker`). */
  const withWorker = (fn: Parameters<typeof withDiffWorker>[1]) =>
    withDiffWorker({ db, storage, redis, logger: mockLogger }, fn);

  it("diffs one step and stores its results", async () => {
    const s = await seed({
      // A rule the step's change does not match: the job still evaluates it.
      ruleSelectors: ["#box"],
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
      // A committed job records its step's rule evaluation.
      expect((await histogramSeries(registry, RULES_DURATION)).count).toBe(1);
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
      ruleSelectors: ["#box"],
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
        // Its rules were evaluated, but a stale job records no rule metrics.
        expect((await histogramSeries(registry, RULES_DURATION)).count).toBe(0);
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

  it("the cheap check: a job re-queued or deleted before its diff is stale and never diffs", async () => {
    const s = await seed({
      ruleSelectors: ["#box"],
      steps: [
        { name: "home", baseline: await red0(), candidate: await blue0() },
        { name: "cart", baseline: await red0(), candidate: await blue0() },
      ],
    });
    // Both steps queued at version 1.
    const jobs = await stepJobsFor(db, runOf(s));
    const old = jobs.find((j) => j.screenshotId === s.shotId.home)!;
    const gone = jobs.find((j) => j.screenshotId === s.shotId.cart)!;
    // home is queued again (version 2) before its job runs...
    await db.transaction((tx) =>
      bumpStepGenerations(tx, s.candidateRunId, [s.shotId.home!]),
    );
    // ...and cart is deleted before its job runs.
    await db.delete(screenshots).where(eq(screenshots.id, s.shotId.cart!));
    vi.mocked(diffStep).mockClear();

    await withWorker(async ({ registry, outcomes, run }) => {
      await run(old);
      await run(gone);

      expect(outcomes).toEqual([
        { checkpoints: 0, stale: true },
        { checkpoints: 0, stale: true },
      ]);
      expect(
        (
          await histogramSeries(registry, "furan_diff_job_duration_seconds", {
            outcome: "stale",
          })
        ).count,
      ).toBe(2);
      expect(
        await histogramSeries(registry, "furan_diff_job_checkpoints"),
      ).toEqual({ count: 2, sum: 0 });
      expect((await histogramSeries(registry, RULES_DURATION)).count).toBe(0);
    });

    // Neither job got as far as the diff, so nothing was written.
    expect(vi.mocked(diffStep)).not.toHaveBeenCalled();
    const home = await stepRow(s.shotId.home!);
    expect(home.verdict).toBeNull();
    expect(home.diffImageKey).toBeNull();
    expect(home.diffGeneration).toBe(old.generation + 1);
    expect(
      await db
        .select({ id: diffRegions.id })
        .from(diffRegions)
        .where(eq(diffRegions.runId, s.candidateRunId)),
    ).toEqual([]);
    expect((await runRow(s.candidateRunId)).status).toBe("running");
  }, 60_000);

  it("a step or run deleted between the diff and the commit makes the commit stale", async () => {
    const deps = { db, storage, redis };
    const changed = async () =>
      seed({
        steps: [
          { name: "home", baseline: await red0(), candidate: await blue0() },
        ],
      });

    // The step goes.
    const s1 = await changed();
    const job1 = await jobOf(s1, "home");
    const result1 = await diffNow(s1, "home");
    await db.delete(screenshots).where(eq(screenshots.id, s1.shotId.home!));
    expect(await commitStep(deps, job1, result1, mockLogger)).toEqual({
      kind: "stale",
    });

    // The whole run goes.
    const s2 = await changed();
    const job2 = await jobOf(s2, "home");
    const result2 = await diffNow(s2, "home");
    await db.delete(testRuns).where(eq(testRuns.id, s2.candidateRunId));
    expect(await commitStep(deps, job2, result2, mockLogger)).toEqual({
      kind: "stale",
    });

    for (const s of [s1, s2]) {
      expect(
        await db
          .select({ id: diffRegions.id })
          .from(diffRegions)
          .where(eq(diffRegions.runId, s.candidateRunId)),
      ).toEqual([]);
    }
  }, 60_000);

  it("the rule applications of a superseded commit are stale, not an error", async () => {
    // The `#box` rule auto-approves the step's change, so its result carries a
    // winning decision for its one region.
    const s = await seed({
      ruleSelectors: ["#box"],
      steps: [
        {
          name: "home",
          baseline: await red0(),
          candidate: await blue0(),
          candidateDom: BOX_DOM,
          candidateMap: { "#box": BOX_0 },
        },
      ],
    });
    const registry = new Registry();
    const deps = {
      db,
      storage,
      redis,
      metrics: createDiffMetrics(registry),
    };
    const run = { runId: s.candidateRunId, projectId: s.projectId };

    const job1 = await jobOf(s, "home");
    const result1 = await diffNow(s, "home");
    expect(result1.ruleDecisions).toHaveLength(1);
    const first = await commitStep(deps, job1, result1, mockLogger);
    // A newer version commits before the first one's applications run: its
    // commit replaced the regions they point at.
    const job2 = await jobOf(s, "home");
    const result2 = await diffNow(s, "home");
    const second = await commitStep(deps, job2, result2, mockLogger);
    if (first.kind !== "committed" || second.kind !== "committed") {
      throw new Error("both commits should have landed");
    }
    vi.mocked(mockLogger.info).mockClear();
    vi.mocked(mockLogger.error).mockClear();

    await persistRuleApplications(
      deps,
      { ...run, result: result1, regionIds: first.regionIds },
      mockLogger,
    );

    expect(vi.mocked(mockLogger.info)).toHaveBeenCalledWith(
      expect.objectContaining({ screenshotId: s.shotId.home }),
      "auto_rule_applications_stale",
    );
    expect(vi.mocked(mockLogger.error)).not.toHaveBeenCalled();
    expect(
      await counterValue(registry, "furan_diff_rules_evaluation_errors_total"),
    ).toBe(0);
    const applications = () =>
      db
        .select({
          id: autoRuleApplications.id,
          region: autoRuleApplications.diffRegionId,
        })
        .from(autoRuleApplications)
        .where(eq(autoRuleApplications.testRunId, s.candidateRunId));
    expect(await applications()).toEqual([]);

    // The current version's applications land, and link its region.
    await persistRuleApplications(
      deps,
      { ...run, result: result2, regionIds: second.regionIds },
      mockLogger,
    );
    const landed = await applications();
    expect(landed.map((a) => a.region)).toEqual(second.regionIds);
    const [region] = await db
      .select({ resolvedBy: diffRegions.resolvedByApplicationId })
      .from(diffRegions)
      .where(eq(diffRegions.id, second.regionIds[0]!));
    expect(region!.resolvedBy).toBe(landed[0]!.id);
    expect(vi.mocked(mockLogger.error)).not.toHaveBeenCalled();
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

    // Two commits of the SAME current version at once, on two connections (a
    // retry racing its original): they queue on the run lock, both commit,
    // and the step keeps exactly one set of its regions, the last writer's.
    const v7 = await version(await red144());
    const race = await Promise.all([
      commit(v7.job, v7.result),
      commit(v7.job, v7.result),
    ]);
    expect(race.map((c) => c.kind)).toEqual(["committed", "committed"]);
    await expectStored(v7.result);
    const kept = (await regionsOf(home)).map((r) => r.id).sort();
    const sets = race.map((c) =>
      c.kind === "committed" ? [...c.regionIds].sort() : [],
    );
    expect(sets).toContainEqual(kept);
    expect((await stepRow(home)).diffGeneration).toBe(v7.job.generation);
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
