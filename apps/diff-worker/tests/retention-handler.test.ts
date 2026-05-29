import {
  builds,
  createDb,
  eq,
  projects,
  screenshots,
  testRuns,
  testVariations,
  users,
  type DB,
} from "@furan/db";
import { createStorage, objectKey, type Storage } from "@furan/storage";
import { Redis } from "ioredis";
import { Registry } from "prom-client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  createRetentionMetrics,
  handleRetentionJob,
  type RetentionMetrics,
} from "../src/retention-handler.js";

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
} as unknown as Parameters<typeof handleRetentionJob>[1];

/**
 * Pull a counter's current value for a given label set straight from
 * prom-client. The Counter's `.get()` is async (it await-resolves any
 * registered collect callback before returning the snapshot).
 */
async function counterValue(
  metric: RetentionMetrics["deletedRuns"],
  projectId: string,
): Promise<number> {
  const snap = await metric.get();
  const match = snap.values.find(
    (v) => (v.labels as { project_id?: string }).project_id === projectId,
  );
  return match?.value ?? 0;
}

desc("handleRetentionJob (integration)", () => {
  let db: DB;
  let closeDb: () => Promise<void>;
  let storage: Storage;
  let redis: Redis;
  let metrics: RetentionMetrics;
  let projectId: string;
  let userId: string;
  let buildId: string;
  let variationId: string;

  beforeEach(async () => {
    const created = createDb();
    db = created.db;
    closeDb = created.close;
    storage = createStorage();
    redis = new Redis(process.env.REDIS_URL!);
    // Fresh registry per test so counter values are isolated.
    metrics = createRetentionMetrics(new Registry());

    const uniq = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const [u] = await db
      .insert(users)
      .values({
        email: `ret-${uniq}@x.test`,
        hashedPassword: "x",
        firstName: "ret",
        lastName: "tester",
        role: "admin",
      })
      .returning();
    userId = u.id;
    const [p] = await db
      .insert(projects)
      .values({
        name: `ret-${uniq}`,
        mainBranchName: "main",
        retentionDays: 7,
      })
      .returning();
    projectId = p.id;

    const [b] = await db
      .insert(builds)
      .values({ projectId: p.id, userId: u.id, isRunning: false })
      .returning();
    buildId = b.id;
    const [v] = await db
      .insert(testVariations)
      .values({
        name: "v",
        projectId: p.id,
        branchName: "main",
        browser: "chromium",
        viewport: "1280x720",
      })
      .returning();
    variationId = v.id;
  }, 30_000);

  afterEach(async () => {
    // Per-test scoped cleanup: cascade-delete the single project the test
    // created. FK cascades scrub test_runs, screenshots, diff_regions,
    // baselines, test_variations, builds.
    try {
      if (db && projectId) {
        // Best-effort lock cleanup in case a test exited mid-handler.
        await redis.del(`retention-lock:${projectId}`);
        await db.delete(projects).where(eq(projects.id, projectId));
      }
    } catch {
      /* best-effort */
    }
    // Also clear users we created.
    try {
      if (db && userId) {
        await db.delete(users).where(eq(users.id, userId));
      }
    } catch {
      /* best-effort */
    }
    if (redis) redis.disconnect();
    if (closeDb) await closeDb();
  });

  test("deletes runs older than retentionDays; metric reflects count", async () => {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    // retentionDays=7 → keep <7d, delete >=7d.
    const [recent] = await db
      .insert(testRuns)
      .values({
        name: "recent",
        projectId,
        testVariationId: variationId,
        buildId,
        branchName: "main",
        status: "passed",
        createdAt: new Date(now - 1 * day),
      })
      .returning();
    const [old1] = await db
      .insert(testRuns)
      .values({
        name: "old-10d",
        projectId,
        testVariationId: variationId,
        buildId,
        branchName: "main",
        status: "passed",
        createdAt: new Date(now - 10 * day),
      })
      .returning();
    const [old2] = await db
      .insert(testRuns)
      .values({
        name: "old-30d",
        projectId,
        testVariationId: variationId,
        buildId,
        branchName: "main",
        status: "passed",
        createdAt: new Date(now - 30 * day),
      })
      .returning();

    await handleRetentionJob({ projectIds: [projectId] }, mockLogger, {
      db,
      redis,
      storage,
      metrics,
    });

    const remaining = await db
      .select({ id: testRuns.id })
      .from(testRuns)
      .where(eq(testRuns.projectId, projectId));
    expect(remaining.map((r) => r.id).sort()).toEqual([recent.id].sort());
    expect(await counterValue(metrics.deletedRuns, projectId)).toBe(2);

    // Reference the captured ids so eslint doesn't whine about unused
    // returning() values.
    expect(old1.id).toBeDefined();
    expect(old2.id).toBeDefined();
  }, 30_000);

  test("project with retentionDays=0 is skipped (no deletes, no metric)", async () => {
    // Flip retentionDays to 0 for this project.
    await db
      .update(projects)
      .set({ retentionDays: 0 })
      .where(eq(projects.id, projectId));

    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    await db.insert(testRuns).values({
      name: "ancient",
      projectId,
      testVariationId: variationId,
      buildId,
      branchName: "main",
      status: "passed",
      createdAt: new Date(now - 365 * day),
    });

    await handleRetentionJob({ projectIds: [projectId] }, mockLogger, {
      db,
      redis,
      storage,
      metrics,
    });

    const remaining = await db
      .select({ id: testRuns.id })
      .from(testRuns)
      .where(eq(testRuns.projectId, projectId));
    expect(remaining.length).toBe(1);
    expect(await counterValue(metrics.deletedRuns, projectId)).toBe(0);
  }, 30_000);

  test("held lock causes skip + lockSkipped metric increment", async () => {
    const lockKey = `retention-lock:${projectId}`;
    // Pre-acquire the lock as if another worker were mid-sweep.
    await redis.set(lockKey, "held-by-other", "EX", 3600);

    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const [oldRun] = await db
      .insert(testRuns)
      .values({
        name: "old",
        projectId,
        testVariationId: variationId,
        buildId,
        branchName: "main",
        status: "passed",
        createdAt: new Date(now - 30 * day),
      })
      .returning();

    try {
      await handleRetentionJob({ projectIds: [projectId] }, mockLogger, {
        db,
        redis,
        storage,
        metrics,
      });

      // Nothing deleted — lock was held.
      const remaining = await db
        .select({ id: testRuns.id })
        .from(testRuns)
        .where(eq(testRuns.projectId, projectId));
      expect(remaining.length).toBe(1);
      expect(remaining[0].id).toBe(oldRun.id);
      expect(await counterValue(metrics.deletedRuns, projectId)).toBe(0);
      expect(await counterValue(metrics.lockSkipped, projectId)).toBe(1);

      // The lock value MUST still be the foreign holder's value — proves
      // the handler didn't `del` someone else's lock on its way out.
      const value = await redis.get(lockKey);
      expect(value).toBe("held-by-other");
    } finally {
      await redis.del(lockKey);
    }
  }, 30_000);

  test("dryRun: nothing deleted; logged would-delete count", async () => {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    await db.insert(testRuns).values({
      name: "old-a",
      projectId,
      testVariationId: variationId,
      buildId,
      branchName: "main",
      status: "passed",
      createdAt: new Date(now - 30 * day),
    });
    await db.insert(testRuns).values({
      name: "old-b",
      projectId,
      testVariationId: variationId,
      buildId,
      branchName: "main",
      status: "passed",
      createdAt: new Date(now - 60 * day),
    });

    const logger = {
      ...mockLogger,
      info: vi.fn(),
    } as unknown as Parameters<typeof handleRetentionJob>[1];

    await handleRetentionJob(
      { projectIds: [projectId], dryRun: true },
      logger,
      { db, redis, storage, metrics },
    );

    const remaining = await db
      .select({ id: testRuns.id })
      .from(testRuns)
      .where(eq(testRuns.projectId, projectId));
    expect(remaining.length).toBe(2);
    expect(await counterValue(metrics.deletedRuns, projectId)).toBe(0);

    // Confirm the dry-run log fired with the right count.
    const infoMock = (logger as unknown as { info: ReturnType<typeof vi.fn> })
      .info;
    const dryRunCall = infoMock.mock.calls.find(
      (c) => c[1] === "retention_dry_run",
    );
    expect(dryRunCall).toBeDefined();
    expect((dryRunCall![0] as { wouldDelete: number }).wouldDelete).toBe(2);
  }, 30_000);

  test("orphan sweep deletes storage objects for cascade-deleted screenshots", async () => {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    // Old run whose screenshot's image_key will be orphaned post-delete.
    const [old] = await db
      .insert(testRuns)
      .values({
        name: "old-with-screenshot",
        projectId,
        testVariationId: variationId,
        buildId,
        branchName: "main",
        status: "passed",
        createdAt: new Date(now - 30 * day),
      })
      .returning();

    // Synthesize unique bytes per test run via the uniq suffix so we
    // never collide with a stale screenshots row from a prior failed run.
    const uniqBytes = Buffer.from(
      `retention-test-${old.id}-${Date.now()}`,
      "utf8",
    );
    const imageKey = objectKey(uniqBytes);
    await storage.put(imageKey, uniqBytes, "image/png");
    await db.insert(screenshots).values({
      runId: old.id,
      projectId,
      testVariationId: variationId,
      name: "checkpoint-1",
      imageKey,
      viewport: "1280x720",
      browser: "chromium",
    });

    // Confirm the object exists pre-sweep.
    const headBefore = await storage.head(imageKey);
    expect(headBefore).not.toBeNull();
    expect(headBefore!.size).toBe(uniqBytes.length);

    await handleRetentionJob({ projectIds: [projectId] }, mockLogger, {
      db,
      redis,
      storage,
      metrics,
    });

    // Cascade should have nuked the screenshots row.
    const surviving = await db
      .select({ id: screenshots.id })
      .from(screenshots)
      .where(eq(screenshots.imageKey, imageKey));
    expect(surviving.length).toBe(0);

    // And the orphan sweep should have deleted the object from storage.
    const headAfter = await storage.head(imageKey);
    expect(headAfter).toBeNull();

    expect(await counterValue(metrics.deletedRuns, projectId)).toBe(1);
    expect(await counterValue(metrics.freedBytes, projectId)).toBe(
      uniqBytes.length,
    );
  }, 30_000);
});
