import {
  baselines,
  builds,
  createDb,
  eq,
  projects,
  recomputeRunStatus,
  screenshots,
  testRuns,
  testVariations,
  users,
  type DB,
} from "@furan/db";
import type { DiffJob } from "@furan/queue";
import { createStorage, objectKey, type Storage } from "@furan/storage";
import { Redis } from "ioredis";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { persistRuleApplications } from "../src/commit-step.js";
import { handleDiffJob } from "../src/handler.js";

import { stepJobsFor } from "./helpers/step-jobs.js";

// Wraps the real `recomputeRunStatus` in a spy so one test can make it fail
// INSIDE the core transaction; every other call runs the real thing.
vi.mock("@furan/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@furan/db")>();
  return {
    ...actual,
    recomputeRunStatus: vi.fn(actual.recomputeRunStatus),
  };
});

// Wraps the real `persistRuleApplications` (the first thing a step job does
// after its commit) so one test can make it fail AFTER the commit; every other
// call runs the real thing.
vi.mock("../src/commit-step.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/commit-step.js")>();
  return {
    ...actual,
    persistRuleApplications: vi.fn(actual.persistRuleApplications),
  };
});

/**
 * Ruling R9: a failed diff attempt writes its failure only when it is the job's
 * FINAL attempt. A step job's failure marks that step `unresolved` with a
 * reason code (`markStepDiffFailed`); an old whole-run job's marks the run
 * `aborted`, which `recomputeRunStatus` keeps (a lifecycle state), so writing
 * either on an attempt BullMQ is about to retry would stick even after the
 * retry succeeds.
 *
 * Ruling R11: a failure AFTER the core transaction committed never fails the
 * step or aborts the run (the committed result and rollup are valid), and the
 * `diff_job_failed` log is a warning while a retry is still coming.
 *
 * Ruling R22: a step job NEVER aborts its run. The abort survives only for an
 * old whole-run payload (no `screenshotId`), the zero-step tests below.
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

async function square(color: "red" | "blue"): Promise<Buffer> {
  const fg =
    color === "red"
      ? { r: 220, g: 30, b: 30, alpha: 1 }
      : { r: 30, g: 30, b: 220, alpha: 1 };
  return sharp({
    create: {
      width: 400,
      height: 400,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    },
  })
    .composite([
      {
        input: {
          create: { width: 144, height: 144, channels: 4, background: fg },
        },
        left: 0,
        top: 0,
      },
    ])
    .png()
    .toBuffer();
}

desc("handleDiffJob — failures land on the final attempt (integration)", () => {
  let db: DB;
  let closeDb: () => Promise<void>;
  let storage: Storage;
  let redis: Redis;
  let userId: string;
  const projectIds: string[] = [];

  beforeAll(async () => {
    const created = createDb();
    db = created.db;
    closeDb = created.close;
    storage = createStorage();
    redis = new Redis(process.env.REDIS_URL!);
    const [u] = await db
      .insert(users)
      .values({
        email: `dw-final-${Date.now()}@x.test`,
        hashedPassword: "x",
        firstName: "dw",
        lastName: "final-attempt",
        role: "admin",
      })
      .returning();
    userId = u!.id;
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

  /** A `running` run on main; one variation, optionally baselined. */
  async function seedRun(): Promise<{
    projectId: string;
    buildId: string;
    variationId: string;
    runId: string;
  }> {
    const uniq = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
    const [p] = await db
      .insert(projects)
      .values({ name: `dw-final-${uniq}`, mainBranchName: "main" })
      .returning();
    projectIds.push(p!.id);
    const [b] = await db
      .insert(builds)
      .values({ projectId: p!.id, userId, isRunning: true })
      .returning();
    const [v] = await db
      .insert(testVariations)
      .values({
        name: "home",
        projectId: p!.id,
        branchName: "main",
        browser: "chromium",
        viewport: "400x400",
      })
      .returning();
    const [r] = await db
      .insert(testRuns)
      .values({
        name: "candidate",
        projectId: p!.id,
        buildId: b!.id,
        branchName: "main",
        status: "running",
      })
      .returning();
    return {
      projectId: p!.id,
      buildId: b!.id,
      variationId: v!.id,
      runId: r!.id,
    };
  }

  /**
   * Gives a seeded run a baselined checkpoint and a CHANGED candidate image
   * (red → blue), so a completed diff derives `unresolved`. The candidate's
   * image is returned, not stored: callers decide when it exists.
   */
  async function seedChangedCheckpoint(s: {
    projectId: string;
    buildId: string;
    variationId: string;
    runId: string;
  }): Promise<{ candidateKey: string; candidateImg: Buffer }> {
    const uniq = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
    // Baseline run + screenshot + baselines row for the variation.
    const [br] = await db
      .insert(testRuns)
      .values({
        name: "baseline",
        projectId: s.projectId,
        buildId: s.buildId,
        branchName: "main",
        status: "passed",
      })
      .returning();
    const baselineImg = await square("red");
    const baselineKey = `${objectKey(baselineImg)}-${uniq}-bl`;
    await storage.put(baselineKey, baselineImg, "image/png");
    await db.insert(screenshots).values({
      runId: br!.id,
      projectId: s.projectId,
      testVariationId: s.variationId,
      name: "home",
      imageKey: baselineKey,
      viewport: "400x400",
      browser: "chromium",
    });
    await db.insert(baselines).values({
      baselineName: baselineKey,
      testVariationId: s.variationId,
      testRunId: br!.id,
      branchName: "main",
      userId,
    });
    const candidateImg = await square("blue");
    const candidateKey = `${objectKey(candidateImg)}-${uniq}-cd`;
    await db.insert(screenshots).values({
      runId: s.runId,
      projectId: s.projectId,
      testVariationId: s.variationId,
      name: "home",
      imageKey: candidateKey,
      viewport: "400x400",
      browser: "chromium",
    });
    return { candidateKey, candidateImg };
  }

  /** The run's one step job, at a newly queued version (spec 2026-10-23). */
  async function stepJob(s: { runId: string; projectId: string }) {
    const [job] = await stepJobsFor(db, s);
    return job!;
  }

  async function runStatus(runId: string): Promise<string> {
    const [row] = await db
      .select({ status: testRuns.status })
      .from(testRuns)
      .where(eq(testRuns.id, runId));
    return row!.status;
  }

  /** The failure columns of the run's only step. */
  async function stepFailure(runId: string) {
    const [row] = await db
      .select({
        verdict: screenshots.verdict,
        diffPercent: screenshots.diffPercent,
        diffFailedAt: screenshots.diffFailedAt,
        diffError: screenshots.diffError,
      })
      .from(screenshots)
      .where(eq(screenshots.runId, runId));
    return row!;
  }

  /**
   * Collects the frames published on the run's channel and its project's
   * while `fn` runs. Run-channel frames carry a `type`, project-channel
   * frames an `event`.
   */
  async function eventsDuring(
    s: { runId: string; projectId: string },
    fn: () => Promise<void>,
  ): Promise<Array<{ type?: string; event?: string; status?: string }>> {
    const events: Array<{ type?: string; event?: string; status?: string }> =
      [];
    const sub = new Redis(process.env.REDIS_URL!);
    await sub.subscribe(
      `run:${s.runId}:events`,
      `project:${s.projectId}:events:raw`,
    );
    sub.on("message", (_ch, msg) => events.push(JSON.parse(msg)));
    await new Promise((r) => setTimeout(r, 100));
    try {
      await fn();
    } finally {
      await new Promise((r) => setTimeout(r, 200));
      sub.disconnect();
    }
    return events;
  }

  /** The `diff_job_failed` calls a logger level received. */
  function failedLogs(level: "warn" | "error") {
    return vi
      .mocked(mockLogger[level])
      .mock.calls.filter((c) => c[1] === "diff_job_failed");
  }

  // The two tests below send an old whole-run payload (no `screenshotId`): the
  // only job that still aborts its run (R22). A run with no steps is split into
  // nothing, so the handler throws `run_has_no_screenshots`.
  it("a non-final failed attempt leaves the status alone and rethrows", async () => {
    // No screenshots → the handler throws run_has_no_screenshots.
    const s = await seedRun();
    vi.mocked(mockLogger.warn).mockClear();
    vi.mocked(mockLogger.error).mockClear();

    const events = await eventsDuring(s, async () => {
      await expect(
        handleDiffJob(
          { runId: s.runId, projectId: s.projectId } as DiffJob,
          mockLogger,
          { db, storage, redis },
          { finalAttempt: false },
        ),
      ).rejects.toThrow(/run_has_no_screenshots/);
    });

    expect(await runStatus(s.runId)).toBe("running");
    expect(events.find((e) => e.type === "run.completed")).toBeUndefined();
    // A retry is coming, so this is a warning, not an error.
    expect(failedLogs("warn")).toHaveLength(1);
    expect(failedLogs("error")).toHaveLength(0);
  }, 60_000);

  it("the final failed attempt writes aborted and publishes it", async () => {
    const s = await seedRun();
    vi.mocked(mockLogger.warn).mockClear();
    vi.mocked(mockLogger.error).mockClear();

    const events = await eventsDuring(s, async () => {
      await expect(
        handleDiffJob(
          { runId: s.runId, projectId: s.projectId } as DiffJob,
          mockLogger,
          { db, storage, redis },
          { finalAttempt: true },
        ),
      ).rejects.toThrow(/run_has_no_screenshots/);
    });

    expect(await runStatus(s.runId)).toBe("aborted");
    expect(events.find((e) => e.type === "run.completed")?.status).toBe(
      "aborted",
    );
    // And the project channel's mirror, so the dashboard lists refresh.
    expect(events.filter((e) => e.event === "testRun_updated")).toHaveLength(1);
    expect(failedLogs("error")).toHaveLength(1);
    expect(failedLogs("warn")).toHaveLength(0);
  }, 60_000);

  it("the final failure of an already aborted run publishes nothing", async () => {
    // An SDK or capture abort got there first: the guarded write changes
    // nothing (R50), so there is no status change to announce.
    const s = await seedRun();
    await db
      .update(testRuns)
      .set({ status: "aborted" })
      .where(eq(testRuns.id, s.runId));

    const events = await eventsDuring(s, async () => {
      await expect(
        handleDiffJob(
          { runId: s.runId, projectId: s.projectId } as DiffJob,
          mockLogger,
          { db, storage, redis },
          { finalAttempt: true },
        ),
      ).rejects.toThrow(/run_has_no_screenshots/);
    });

    expect(events).toEqual([]);
    const [run] = await db
      .select({
        status: testRuns.status,
        abortedByDiff: testRuns.abortedByDiff,
      })
      .from(testRuns)
      .where(eq(testRuns.id, s.runId));
    expect(run).toEqual({ status: "aborted", abortedByDiff: false });
  }, 60_000);

  it("a failing project publish on the whole-run abort is logged under its own key", async () => {
    const s = await seedRun();
    const down = new Proxy(redis, {
      get(target, prop) {
        if (prop === "publish") {
          return async () => {
            throw new Error("redis_down");
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    vi.mocked(mockLogger.warn).mockClear();

    // The job's own error is what rejects, not the publish's.
    await expect(
      handleDiffJob(
        { runId: s.runId, projectId: s.projectId } as DiffJob,
        mockLogger,
        { db, storage, redis: down },
        { finalAttempt: true },
      ),
    ).rejects.toThrow(/run_has_no_screenshots/);

    expect(await runStatus(s.runId)).toBe("aborted");
    expect(
      vi
        .mocked(mockLogger.warn)
        .mock.calls.filter(
          (c) => c[1] === "diff_worker_project_publish_failed",
        ),
    ).toHaveLength(1);
  }, 60_000);

  it("a failed attempt followed by a successful retry ends with the rollup status", async () => {
    const s = await seedRun();
    // The candidate's image is not in storage yet: attempt 1 fails reading it.
    const { candidateKey, candidateImg } = await seedChangedCheckpoint(s);
    const job = await stepJob(s);

    await expect(
      handleDiffJob(
        job,
        mockLogger,
        { db, storage, redis },
        { finalAttempt: false },
      ),
    ).rejects.toThrow();
    expect(await runStatus(s.runId)).toBe("running");

    // The transient cause clears; BullMQ's retry (here the last attempt)
    // succeeds and the run takes the rollup of its verdicts.
    await storage.put(candidateKey, candidateImg, "image/png");
    await handleDiffJob(
      job,
      mockLogger,
      { db, storage, redis },
      { finalAttempt: true },
    );

    expect(await runStatus(s.runId)).toBe("unresolved");
    // The retry's own result: a diff found, no failure.
    expect(await stepFailure(s.runId)).toMatchObject({
      verdict: "unresolved",
      diffFailedAt: null,
      diffError: null,
    });
  }, 60_000);

  it("a final-attempt failure after the core transaction committed keeps the derived status", async () => {
    const s = await seedRun();
    const { candidateKey, candidateImg } = await seedChangedCheckpoint(s);
    await storage.put(candidateKey, candidateImg, "image/png");
    // Something fails right after the commit: the core transaction (verdicts +
    // recomputed status) has already landed when this throws. (The events are
    // best-effort and no longer throw, and the rule audit trail is fail-open,
    // so the fault is injected.)
    vi.mocked(persistRuleApplications).mockRejectedValueOnce(
      new Error("failed_after_commit"),
    );
    vi.mocked(mockLogger.error).mockClear();

    const job = await stepJob(s);

    await expect(
      handleDiffJob(
        job,
        mockLogger,
        { db, storage, redis },
        { finalAttempt: true },
      ),
    ).rejects.toThrow(/failed_after_commit/);

    // The committed rollup stands: `aborted` would be permanent, since
    // recomputeRunStatus keeps it.
    expect(await runStatus(s.runId)).toBe("unresolved");
    // And the committed step is not failed over `persistRuleApplications`
    // throwing after the commit: it keeps the diff it found (numbers, no
    // failure).
    const committed = await stepFailure(s.runId);
    expect(committed).toMatchObject({
      verdict: "unresolved",
      diffFailedAt: null,
      diffError: null,
    });
    expect(committed.diffPercent).not.toBeNull();
    // It is still logged, at error (final attempt), and flagged as post-commit.
    const logged = failedLogs("error");
    expect(logged).toHaveLength(1);
    expect(logged[0]![0]).toMatchObject({
      runId: s.runId,
      coreCommitted: true,
    });
  }, 60_000);

  it("a final-attempt failure inside the core transaction fails the step, not the run", async () => {
    // The commit flag must only be set once the transaction has committed: a
    // failure that rolls it back leaves no result to protect, so the step
    // fails. The run is never aborted for it (R22).
    const s = await seedRun();
    const { candidateKey, candidateImg } = await seedChangedCheckpoint(s);
    await storage.put(candidateKey, candidateImg, "image/png");
    const job = await stepJob(s);
    vi.mocked(recomputeRunStatus).mockRejectedValueOnce(
      new Error("recompute_failed_in_tx"),
    );
    vi.mocked(mockLogger.error).mockClear();

    await expect(
      handleDiffJob(
        job,
        mockLogger,
        { db, storage, redis },
        { finalAttempt: true },
      ),
    ).rejects.toThrow(/recompute_failed_in_tx/);

    // The failed step makes the run unresolved; `aborted` would be permanent.
    expect(await runStatus(s.runId)).toBe("unresolved");
    // The rolled-back transaction wrote none of the diff's result: the step
    // carries the failure and a reason code, nothing else.
    expect(await stepFailure(s.runId)).toMatchObject({
      verdict: "unresolved",
      diffPercent: null,
      diffError: "internal",
    });
    expect((await stepFailure(s.runId)).diffFailedAt).not.toBeNull();
    expect(failedLogs("error")[0]![0]).toMatchObject({
      runId: s.runId,
      code: "internal",
      coreCommitted: false,
    });
  }, 60_000);

  // Ruling R46: an abort the OLD whole-run pipeline wrote must not outlive a
  // later step job that leaves every checkpoint with a verdict. Only an abort
  // the diff pipeline wrote heals. A step job no longer writes one itself
  // (R22), so the tests seed what an older worker left behind.
  describe("a later successful diff heals a pipeline abort", () => {
    async function runRow(runId: string) {
      const [row] = await db
        .select({
          status: testRuns.status,
          abortedByDiff: testRuns.abortedByDiff,
        })
        .from(testRuns)
        .where(eq(testRuns.id, runId));
      return row!;
    }

    it("job k fails its step alone, then job k+1 succeeds: the failure is cleared", async () => {
      const s = await seedRun();
      // Job k: the candidate image is missing, and it is the final attempt.
      const { candidateKey, candidateImg } = await seedChangedCheckpoint(s);
      const job = await stepJob(s);
      await expect(
        handleDiffJob(
          job,
          mockLogger,
          { db, storage, redis },
          { finalAttempt: true },
        ),
      ).rejects.toThrow();
      // The step carries the failure; the run is unresolved because of it, not
      // aborted.
      expect(await stepFailure(s.runId)).toMatchObject({
        verdict: "unresolved",
        diffError: "object_missing",
      });
      expect(await runRow(s.runId)).toEqual({
        status: "unresolved",
        abortedByDiff: false,
      });

      // Job k+1 (the step queued again, at a new version) diffs it.
      await storage.put(candidateKey, candidateImg, "image/png");
      await handleDiffJob(
        await stepJob(s),
        mockLogger,
        { db, storage, redis },
        { finalAttempt: true },
      );

      expect(await stepFailure(s.runId)).toMatchObject({
        verdict: "unresolved",
        diffFailedAt: null,
        diffError: null,
      });
      expect(await runRow(s.runId)).toEqual({
        status: "unresolved",
        abortedByDiff: false,
      });
    }, 60_000);

    it("an abort an older worker wrote heals once a step job succeeds: the run takes its real rollup", async () => {
      const s = await seedRun();
      const { candidateKey, candidateImg } = await seedChangedCheckpoint(s);
      await storage.put(candidateKey, candidateImg, "image/png");
      // What a whole-run job's final failure used to write.
      await db
        .update(testRuns)
        .set({ status: "aborted", abortedByDiff: true })
        .where(eq(testRuns.id, s.runId));

      await handleDiffJob(
        await stepJob(s),
        mockLogger,
        { db, storage, redis },
        { finalAttempt: true },
      );

      expect(await runRow(s.runId)).toEqual({
        status: "unresolved",
        abortedByDiff: false,
      });
    }, 60_000);

    it("an SDK abort followed by a successful diff stays aborted", async () => {
      const s = await seedRun();
      const { candidateKey, candidateImg } = await seedChangedCheckpoint(s);
      await storage.put(candidateKey, candidateImg, "image/png");
      // POST /runs/:id/abort writes `aborted` and leaves the flag false.
      await db
        .update(testRuns)
        .set({ status: "aborted", abortedByDiff: false })
        .where(eq(testRuns.id, s.runId));

      await handleDiffJob(
        await stepJob(s),
        mockLogger,
        { db, storage, redis },
        { finalAttempt: true },
      );

      expect(await runRow(s.runId)).toEqual({
        status: "aborted",
        abortedByDiff: false,
      });
    }, 60_000);

    // R50: an SDK (or capture) abort is final. A diff job in flight that then
    // fails its final attempt must not re-flag it as the pipeline's, or the
    // next successful diff would heal it: a CI false pass. The failed step is
    // recorded, and the run's `aborted` stands.
    it("an SDK abort, then a final-attempt failure, then a successful diff stays aborted", async () => {
      const s = await seedRun();
      // The candidate image is missing: the in-flight job will fail.
      const { candidateKey, candidateImg } = await seedChangedCheckpoint(s);
      const job = await stepJob(s);
      await db
        .update(testRuns)
        .set({ status: "aborted", abortedByDiff: false })
        .where(eq(testRuns.id, s.runId));

      await expect(
        handleDiffJob(
          job,
          mockLogger,
          { db, storage, redis },
          { finalAttempt: true },
        ),
      ).rejects.toThrow();
      expect(await stepFailure(s.runId)).toMatchObject({
        verdict: "unresolved",
        diffError: "object_missing",
      });
      expect(await runRow(s.runId)).toEqual({
        status: "aborted",
        abortedByDiff: false,
      });

      await storage.put(candidateKey, candidateImg, "image/png");
      await handleDiffJob(
        job,
        mockLogger,
        { db, storage, redis },
        { finalAttempt: true },
      );

      expect(await runRow(s.runId)).toEqual({
        status: "aborted",
        abortedByDiff: false,
      });
    }, 60_000);

    it("a job that leaves a checkpoint without a verdict does not heal", async () => {
      // A checkpoint uploaded while job k+1 runs has no verdict when it
      // commits: the run stays aborted until a job diffs that one too.
      const s = await seedRun();
      const { candidateKey, candidateImg } = await seedChangedCheckpoint(s);
      await storage.put(candidateKey, candidateImg, "image/png");
      await db
        .update(testRuns)
        .set({ status: "aborted", abortedByDiff: true })
        .where(eq(testRuns.id, s.runId));
      const [lateVariation] = await db
        .insert(testVariations)
        .values({
          name: "late",
          projectId: s.projectId,
          branchName: "main",
          browser: "chromium",
          viewport: "400x400",
        })
        .returning();
      let inserted = false;
      const lateUpload = new Proxy(storage, {
        get(target, prop) {
          const value = Reflect.get(target, prop, target);
          if (prop !== "get") {
            return typeof value === "function" ? value.bind(target) : value;
          }
          return async (key: string) => {
            if (!inserted && key === candidateKey) {
              inserted = true;
              await db.insert(screenshots).values({
                runId: s.runId,
                projectId: s.projectId,
                testVariationId: lateVariation!.id,
                name: "late",
                imageKey: `late-${s.runId}`,
                viewport: "400x400",
                browser: "chromium",
              });
            }
            return target.get(key);
          };
        },
      });

      await handleDiffJob(
        await stepJob(s),
        mockLogger,
        { db, storage: lateUpload, redis },
        { finalAttempt: true },
      );

      expect(inserted).toBe(true);
      expect(await runRow(s.runId)).toEqual({
        status: "aborted",
        abortedByDiff: true,
      });
    }, 60_000);
  });
});
