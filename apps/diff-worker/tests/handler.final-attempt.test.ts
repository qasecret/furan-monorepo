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

import { handleDiffJob } from "../src/handler.js";

// Wraps the real `recomputeRunStatus` in a spy so one test can make it fail
// INSIDE the core transaction; every other call runs the real thing.
vi.mock("@furan/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@furan/db")>();
  return {
    ...actual,
    recomputeRunStatus: vi.fn(actual.recomputeRunStatus),
  };
});

/**
 * Ruling R9: a failed diff attempt writes `aborted` only when it is the job's
 * FINAL attempt. `recomputeRunStatus` keeps `aborted` (a lifecycle state), so
 * writing it on an attempt BullMQ is about to retry would stick even after the
 * retry succeeds.
 *
 * Ruling R11: a failure AFTER the core transaction committed never writes
 * `aborted` (the committed rollup is valid and `aborted` would stick), and the
 * `diff_job_failed` log is a warning while a retry is still coming.
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

desc("handleDiffJob — aborted only on the final attempt (integration)", () => {
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

  async function runStatus(runId: string): Promise<string> {
    const [row] = await db
      .select({ status: testRuns.status })
      .from(testRuns)
      .where(eq(testRuns.id, runId));
    return row!.status;
  }

  /** Collects the run channel's event types published while `fn` runs. */
  async function eventsDuring(
    runId: string,
    fn: () => Promise<void>,
  ): Promise<Array<{ type: string; status?: string }>> {
    const events: Array<{ type: string; status?: string }> = [];
    const sub = new Redis(process.env.REDIS_URL!);
    await sub.subscribe(`run:${runId}:events`);
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

  it("a non-final failed attempt leaves the status alone and rethrows", async () => {
    // No screenshots → the handler throws run_has_no_screenshots.
    const s = await seedRun();
    vi.mocked(mockLogger.warn).mockClear();
    vi.mocked(mockLogger.error).mockClear();

    const events = await eventsDuring(s.runId, async () => {
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

    const events = await eventsDuring(s.runId, async () => {
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
    expect(failedLogs("error")).toHaveLength(1);
    expect(failedLogs("warn")).toHaveLength(0);
  }, 60_000);

  it("a failed attempt followed by a successful retry ends with the rollup status", async () => {
    const s = await seedRun();
    // The candidate's image is not in storage yet: attempt 1 fails reading it.
    const { candidateKey, candidateImg } = await seedChangedCheckpoint(s);
    const job = { runId: s.runId, projectId: s.projectId } as DiffJob;

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
    const [shot] = await db
      .select({ verdict: screenshots.verdict })
      .from(screenshots)
      .where(eq(screenshots.runId, s.runId));
    expect(shot!.verdict).toBe("unresolved");
  }, 60_000);

  it("a final-attempt failure after the core transaction committed keeps the derived status", async () => {
    const s = await seedRun();
    const { candidateKey, candidateImg } = await seedChangedCheckpoint(s);
    await storage.put(candidateKey, candidateImg, "image/png");
    // Redis is down for everything after the commit: the core transaction
    // (verdicts + recomputed status) has already landed when this throws.
    const flakyRedis = new Proxy(redis, {
      get(target, prop) {
        if (prop === "publish") {
          return async (channel: string, message: string) => {
            if (JSON.parse(message).type === "diff.completed") {
              throw new Error("redis_down_after_commit");
            }
            return target.publish(channel, message);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    vi.mocked(mockLogger.error).mockClear();

    const events = await eventsDuring(s.runId, async () => {
      await expect(
        handleDiffJob(
          { runId: s.runId, projectId: s.projectId } as DiffJob,
          mockLogger,
          { db, storage, redis: flakyRedis },
          { finalAttempt: true },
        ),
      ).rejects.toThrow(/redis_down_after_commit/);
    });

    // The committed rollup stands: `aborted` would be permanent, since
    // recomputeRunStatus keeps it.
    expect(await runStatus(s.runId)).toBe("unresolved");
    expect(events.find((e) => e.status === "aborted")).toBeUndefined();
    // It is still logged, at error (final attempt), and flagged as post-commit.
    const logged = failedLogs("error");
    expect(logged).toHaveLength(1);
    expect(logged[0]![0]).toMatchObject({
      runId: s.runId,
      coreCommitted: true,
    });
  }, 60_000);

  it("a final-attempt failure inside the core transaction still aborts the run", async () => {
    // The commit flag must only be set once the transaction has committed: a
    // failure that rolls it back leaves no derived status to protect.
    const s = await seedRun();
    const { candidateKey, candidateImg } = await seedChangedCheckpoint(s);
    await storage.put(candidateKey, candidateImg, "image/png");
    vi.mocked(recomputeRunStatus).mockRejectedValueOnce(
      new Error("recompute_failed_in_tx"),
    );

    await expect(
      handleDiffJob(
        { runId: s.runId, projectId: s.projectId } as DiffJob,
        mockLogger,
        { db, storage, redis },
        { finalAttempt: true },
      ),
    ).rejects.toThrow(/recompute_failed_in_tx/);

    expect(await runStatus(s.runId)).toBe("aborted");
    // The rolled-back transaction wrote no verdict.
    const [shot] = await db
      .select({ verdict: screenshots.verdict })
      .from(screenshots)
      .where(eq(screenshots.runId, s.runId));
    expect(shot!.verdict).toBeNull();
  }, 60_000);
});
