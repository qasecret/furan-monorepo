import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  baselines,
  builds,
  createDb,
  diffRegions,
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
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { handleDiffJob } from "../src/handler.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = (n: string): Buffer =>
  readFileSync(join(__dirname, "fixtures", n));

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

/**
 * ADR-032: pre-engine auto-approve when per-viewport screenshot hashes
 * exactly match the resolved baseline. The handler short-circuits the
 * L1+L2 diff, writes the run row, inserts a baselines row with
 * userId=NULL, and publishes the SSE events.
 */
desc("handleDiffJob — auto-approve (integration)", () => {
  let db: DB;
  let closeDb: () => Promise<void>;
  let storage: Storage;
  let redis: Redis;
  let userId: string;

  const VP_DESKTOP = "1280x720";
  const VP_MOBILE = "375x667";

  beforeAll(async () => {
    const created = createDb();
    db = created.db;
    closeDb = created.close;
    storage = createStorage();
    redis = new Redis(process.env.REDIS_URL!);

    const uniq = Date.now();
    const [u] = await db
      .insert(users)
      .values({
        email: `dw-aa-${uniq}@x.test`,
        hashedPassword: "x",
        firstName: "dw",
        lastName: "aa",
        role: "admin",
      })
      .returning();
    userId = u.id;
  });
  afterAll(async () => {
    await redis.quit();
    await closeDb();
  });

  async function setupProject(opts: { autoApproveFeature: boolean }): Promise<{
    projectId: string;
    baselineRunId: string;
    candidateRunId: string;
    variationId: string;
  }> {
    const uniq = `${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
    const [p] = await db
      .insert(projects)
      .values({
        name: `dw-aa-${uniq}`,
        autoApproveFeature: opts.autoApproveFeature,
      })
      .returning();
    const [b] = await db
      .insert(builds)
      .values({ projectId: p.id, userId, isRunning: false })
      .returning();
    const [v] = await db
      .insert(testVariations)
      .values({ name: "home", projectId: p.id })
      .returning();

    const [br] = await db
      .insert(testRuns)
      .values({
        buildId: b.id,
        projectId: p.id,
        testVariationId: v.id,
        status: "passed",
        branchName: "main",
        name: "home",
      })
      .returning();

    const [cr] = await db
      .insert(testRuns)
      .values({
        buildId: b.id,
        projectId: p.id,
        testVariationId: v.id,
        status: "new",
        branchName: "main",
        name: "home",
      })
      .returning();

    await db.insert(baselines).values({
      baselineName: "home",
      testVariationId: v.id,
      testRunId: br.id,
      userId,
      branchName: "main",
    });

    return {
      projectId: p.id,
      baselineRunId: br.id,
      candidateRunId: cr.id,
      variationId: v.id,
    };
  }

  async function seedMatchingScreenshots(opts: {
    baselineRunId: string;
    candidateRunId: string;
    projectId: string;
    viewports: string[];
  }): Promise<void> {
    const bytes = FIXTURE("baseline-a.png");
    const sharedKey = objectKey(bytes);
    await storage.put(sharedKey, bytes, "image/png");
    for (const vp of opts.viewports) {
      await db
        .insert(screenshots)
        .values({
          runId: opts.baselineRunId,
          projectId: opts.projectId,
          imageKey: sharedKey,
          viewport: vp,
          browser: "chromium",
        })
        .onConflictDoNothing({
          target: [screenshots.runId, screenshots.viewport],
        });
      await db
        .insert(screenshots)
        .values({
          runId: opts.candidateRunId,
          projectId: opts.projectId,
          imageKey: sharedKey,
          viewport: vp,
          browser: "chromium",
        })
        .onConflictDoNothing({
          target: [screenshots.runId, screenshots.viewport],
        });
    }
  }

  async function seedMismatchedScreenshots(opts: {
    baselineRunId: string;
    candidateRunId: string;
    projectId: string;
    mismatchOnMobile: boolean;
  }): Promise<void> {
    const baselineBytes = FIXTURE("baseline-a.png");
    const candidateMobileBytes = opts.mismatchOnMobile
      ? FIXTURE("candidate-a-major.png")
      : baselineBytes;
    const baselineKey = objectKey(baselineBytes);
    const candidateMobileKey = objectKey(candidateMobileBytes);
    await storage.put(baselineKey, baselineBytes, "image/png");
    if (opts.mismatchOnMobile) {
      await storage.put(candidateMobileKey, candidateMobileBytes, "image/png");
    }

    // Desktop: shared key (matching).
    await db
      .insert(screenshots)
      .values({
        runId: opts.baselineRunId,
        projectId: opts.projectId,
        imageKey: baselineKey,
        viewport: VP_DESKTOP,
        browser: "chromium",
      })
      .onConflictDoNothing({
        target: [screenshots.runId, screenshots.viewport],
      });
    await db
      .insert(screenshots)
      .values({
        runId: opts.candidateRunId,
        projectId: opts.projectId,
        imageKey: baselineKey,
        viewport: VP_DESKTOP,
        browser: "chromium",
      })
      .onConflictDoNothing({
        target: [screenshots.runId, screenshots.viewport],
      });
    // Mobile: baseline always uses baselineKey; candidate uses
    // candidateMobileKey which may differ.
    await db
      .insert(screenshots)
      .values({
        runId: opts.baselineRunId,
        projectId: opts.projectId,
        imageKey: baselineKey,
        viewport: VP_MOBILE,
        browser: "chromium",
      })
      .onConflictDoNothing({
        target: [screenshots.runId, screenshots.viewport],
      });
    await db
      .insert(screenshots)
      .values({
        runId: opts.candidateRunId,
        projectId: opts.projectId,
        imageKey: candidateMobileKey,
        viewport: VP_MOBILE,
        browser: "chromium",
      })
      .onConflictDoNothing({
        target: [screenshots.runId, screenshots.viewport],
      });
  }

  it("single-viewport hash match auto-approves the run", async () => {
    const ctx = await setupProject({ autoApproveFeature: true });
    await seedMatchingScreenshots({
      ...ctx,
      viewports: [VP_DESKTOP],
    });

    await handleDiffJob(
      { runId: ctx.candidateRunId, projectId: ctx.projectId },
      mockLogger,
      { db, storage, redis },
    );

    const [row] = await db
      .select()
      .from(testRuns)
      .where(eq(testRuns.id, ctx.candidateRunId))
      .limit(1);
    expect(row.status).toBe("passed");
    expect(row.diffPercent).toBe(0);
    expect(row.merge).toBe(true);

    const auto = await db
      .select()
      .from(baselines)
      .where(eq(baselines.testRunId, ctx.candidateRunId));
    expect(auto.length).toBe(1);
    expect(auto[0]!.userId).toBeNull();

    const dr = await db
      .select()
      .from(diffRegions)
      .where(eq(diffRegions.runId, ctx.candidateRunId));
    expect(dr.length).toBe(0);
  });

  it("multi-viewport all-match auto-approves the run", async () => {
    const ctx = await setupProject({ autoApproveFeature: true });
    await seedMatchingScreenshots({
      ...ctx,
      viewports: [VP_DESKTOP, VP_MOBILE],
    });

    await handleDiffJob(
      { runId: ctx.candidateRunId, projectId: ctx.projectId },
      mockLogger,
      { db, storage, redis },
    );

    const auto = await db
      .select()
      .from(baselines)
      .where(eq(baselines.testRunId, ctx.candidateRunId));
    expect(auto.length).toBe(1);
    expect(auto[0]!.userId).toBeNull();
  });

  it("multi-viewport one-mismatch falls through to engine path", async () => {
    const ctx = await setupProject({ autoApproveFeature: true });
    await seedMismatchedScreenshots({ ...ctx, mismatchOnMobile: true });

    await handleDiffJob(
      { runId: ctx.candidateRunId, projectId: ctx.projectId },
      mockLogger,
      { db, storage, redis },
    );

    const auto = await db
      .select()
      .from(baselines)
      .where(eq(baselines.testRunId, ctx.candidateRunId));
    expect(auto.length).toBe(0);
  });

  it("autoApproveFeature=false falls through to engine path", async () => {
    const ctx = await setupProject({ autoApproveFeature: false });
    await seedMatchingScreenshots({
      ...ctx,
      viewports: [VP_DESKTOP],
    });

    await handleDiffJob(
      { runId: ctx.candidateRunId, projectId: ctx.projectId },
      mockLogger,
      { db, storage, redis },
    );

    const auto = await db
      .select()
      .from(baselines)
      .where(eq(baselines.testRunId, ctx.candidateRunId));
    expect(auto.length).toBe(0);
  });

  it("first-baseline (no prior baseline) does not auto-approve", async () => {
    // Setup: project + a candidate run with NO baselines pointer row.
    const uniq = `${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
    const [p] = await db
      .insert(projects)
      .values({
        name: `dw-aa-fb-${uniq}`,
        autoApproveFeature: true,
      })
      .returning();
    const [b] = await db
      .insert(builds)
      .values({ projectId: p.id, userId, isRunning: false })
      .returning();
    const [v] = await db
      .insert(testVariations)
      .values({ name: "home", projectId: p.id })
      .returning();
    const [cr] = await db
      .insert(testRuns)
      .values({
        buildId: b.id,
        projectId: p.id,
        testVariationId: v.id,
        status: "new",
        branchName: "main",
        name: "home",
      })
      .returning();
    // Note: no baselines row inserted, so resolveBaseline returns null.

    await handleDiffJob({ runId: cr.id, projectId: p.id }, mockLogger, {
      db,
      storage,
      redis,
    });

    const auto = await db
      .select()
      .from(baselines)
      .where(eq(baselines.testRunId, cr.id));
    expect(auto.length).toBe(0);
  });
});
