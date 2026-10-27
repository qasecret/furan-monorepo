import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  asc,
  baselines,
  builds,
  checkpointDecisions,
  createDb,
  diffRegions,
  eq,
  projects,
  sql,
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

import { diffRunPerStep } from "./helpers/step-jobs.js";

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

    // The baseline predates the candidate run, as in real use: auto-approve
    // never writes a row above a baseline created after the candidate run.
    await db.insert(baselines).values({
      baselineName: "home",
      testVariationId: v.id,
      testRunId: br.id,
      userId,
      branchName: "main",
    });

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
    variationId: string;
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
          testVariationId: opts.variationId,
          name: "home",
          imageKey: sharedKey,
          viewport: vp,
          browser: "chromium",
        })
        .onConflictDoNothing({
          target: [screenshots.runId, screenshots.name, screenshots.viewport],
        });
      await db
        .insert(screenshots)
        .values({
          runId: opts.candidateRunId,
          projectId: opts.projectId,
          testVariationId: opts.variationId,
          name: "home",
          imageKey: sharedKey,
          viewport: vp,
          browser: "chromium",
        })
        .onConflictDoNothing({
          target: [screenshots.runId, screenshots.name, screenshots.viewport],
        });
    }
  }

  async function seedMismatchedScreenshots(opts: {
    baselineRunId: string;
    candidateRunId: string;
    projectId: string;
    variationId: string;
    /** The mobile checkpoint's own variation (identity includes viewport). */
    mobileVariationId: string;
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
        testVariationId: opts.variationId,
        name: "home",
        imageKey: baselineKey,
        viewport: VP_DESKTOP,
        browser: "chromium",
      })
      .onConflictDoNothing({
        target: [screenshots.runId, screenshots.name, screenshots.viewport],
      });
    await db
      .insert(screenshots)
      .values({
        runId: opts.candidateRunId,
        projectId: opts.projectId,
        testVariationId: opts.variationId,
        name: "home",
        imageKey: baselineKey,
        viewport: VP_DESKTOP,
        browser: "chromium",
      })
      .onConflictDoNothing({
        target: [screenshots.runId, screenshots.name, screenshots.viewport],
      });
    // Mobile: baseline always uses baselineKey; candidate uses
    // candidateMobileKey which may differ.
    await db
      .insert(screenshots)
      .values({
        runId: opts.baselineRunId,
        projectId: opts.projectId,
        testVariationId: opts.mobileVariationId,
        name: "home",
        imageKey: baselineKey,
        viewport: VP_MOBILE,
        browser: "chromium",
      })
      .onConflictDoNothing({
        target: [screenshots.runId, screenshots.name, screenshots.viewport],
      });
    await db
      .insert(screenshots)
      .values({
        runId: opts.candidateRunId,
        projectId: opts.projectId,
        testVariationId: opts.mobileVariationId,
        name: "home",
        imageKey: candidateMobileKey,
        viewport: VP_MOBILE,
        browser: "chromium",
      })
      .onConflictDoNothing({
        target: [screenshots.runId, screenshots.name, screenshots.viewport],
      });
  }

  it("single-viewport hash match auto-approves the run", async () => {
    const ctx = await setupProject({ autoApproveFeature: true });
    await seedMatchingScreenshots({
      ...ctx,
      viewports: [VP_DESKTOP],
    });

    await diffRunPerStep(
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

    await diffRunPerStep(
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

  it("multi-viewport one-mismatch: only the matching checkpoint auto-approves, the other is diffed", async () => {
    // Auto-approve is per checkpoint (review flow spec §3): the matching
    // desktop checkpoint passes and becomes its variation's baseline, while
    // the mismatching mobile checkpoint falls through to the engine. Each
    // viewport is its own variation with its own baseline, as in real data.
    const ctx = await setupProject({ autoApproveFeature: true });
    const [mobile] = await db
      .insert(testVariations)
      .values({ name: "home", projectId: ctx.projectId, viewport: VP_MOBILE })
      .returning();
    await db.insert(baselines).values({
      baselineName: "home",
      testVariationId: mobile.id,
      testRunId: ctx.baselineRunId,
      userId,
      branchName: "main",
    });
    await seedMismatchedScreenshots({
      ...ctx,
      mobileVariationId: mobile.id,
      mismatchOnMobile: true,
    });

    await diffRunPerStep(
      { runId: ctx.candidateRunId, projectId: ctx.projectId },
      mockLogger,
      { db, storage, redis },
    );

    const auto = await db
      .select()
      .from(baselines)
      .where(eq(baselines.testRunId, ctx.candidateRunId));
    expect(auto.length).toBe(1);
    expect(auto[0]!.testVariationId).toBe(ctx.variationId);
    expect(auto[0]!.userId).toBeNull();

    const shots = await db
      .select({ viewport: screenshots.viewport, verdict: screenshots.verdict })
      .from(screenshots)
      .where(eq(screenshots.runId, ctx.candidateRunId));
    expect(
      Object.fromEntries(shots.map((s) => [s.viewport, s.verdict])),
    ).toEqual({ [VP_DESKTOP]: "passed", [VP_MOBILE]: "unresolved" });
    const [row] = await db
      .select()
      .from(testRuns)
      .where(eq(testRuns.id, ctx.candidateRunId))
      .limit(1);
    expect(row.status).toBe("unresolved");
  });

  it("autoApproveFeature=false falls through to engine path", async () => {
    const ctx = await setupProject({ autoApproveFeature: false });
    await seedMatchingScreenshots({
      ...ctx,
      viewports: [VP_DESKTOP],
    });

    await diffRunPerStep(
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

  it("first-baseline (no prior baseline) takes first-baseline path, not auto-approve", async () => {
    // Setup: project + a candidate run with NO baselines pointer row.
    // ADR-038: the handler resolves testVariationId from the first screenshot,
    // so we must seed at least one screenshot for the first-baseline path to
    // fire (without it the handler throws run_has_no_screenshots).
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
        status: "running",
        branchName: "main",
        name: "home",
      })
      .returning();

    // Seed a screenshot so the handler can resolve the testVariationId.
    // No baselines row → resolveBaseline returns null → first-baseline path.
    const fixtureBytes = FIXTURE("baseline-a.png");
    const imageKey = `${uniq}-fb-${objectKey(fixtureBytes)}`;
    await storage.put(imageKey, fixtureBytes, "image/png");
    await db.insert(screenshots).values({
      runId: cr.id,
      projectId: p.id,
      testVariationId: v.id,
      name: "home",
      imageKey,
      viewport: "1280x720",
      browser: "chromium",
    });

    // Note: no baselines row inserted, so resolveBaseline returns null and
    // the handler takes the first-baseline branch (which, per spec §3.2,
    // ALSO seeds a baselines row — distinct from the auto-approve fast
    // path). The distinguishing signal is the test_runs.status value:
    // first-baseline → "new", auto-approve → "passed".

    await diffRunPerStep({ runId: cr.id, projectId: p.id }, mockLogger, {
      db,
      storage,
      redis,
    });

    const updated = await db
      .select()
      .from(testRuns)
      .where(eq(testRuns.id, cr.id))
      .limit(1);
    // Must NOT be "passed" (that would mean auto-approve fired).
    expect(updated[0]!.status).toBe("new");
    // The first-baseline path also inserts an auto-seeded baselines row,
    // identical in shape to the auto-approve fast path (userId=NULL).
    const auto = await db
      .select()
      .from(baselines)
      .where(eq(baselines.testRunId, cr.id));
    expect(auto.length).toBe(1);
    expect(auto[0]!.userId).toBeNull();
  });
  // I1: auto-approve sets the verdict `passed` but must never rewrite a
  // reviewer's baseline, nor write one that sorts above a baseline created
  // after the candidate run. One test per guard; each leaves `baselines`
  // exactly as it was (row count, user, created_at).
  describe("never rewrites a reviewer's or a newer baseline", () => {
    /** Every baseline row of a variation, created_at at full µs precision. */
    async function baselineRows(variationId: string) {
      return db
        .select({
          id: baselines.id,
          testRunId: baselines.testRunId,
          userId: baselines.userId,
          baselineName: baselines.baselineName,
          createdAt: sql<string>`${baselines.createdAt}::text`,
        })
        .from(baselines)
        .where(eq(baselines.testVariationId, variationId))
        .orderBy(asc(baselines.id));
    }

    async function verdictsOf(runId: string) {
      const rows = await db
        .select({ verdict: screenshots.verdict })
        .from(screenshots)
        .where(eq(screenshots.runId, runId));
      return rows.map((r) => r.verdict);
    }

    async function putImage(name: string): Promise<string> {
      const bytes = FIXTURE(name);
      const key = objectKey(bytes);
      await storage.put(key, bytes, "image/png");
      return key;
    }

    it("(a) an active decision on the checkpoint: verdict passed, no baseline write", async () => {
      // A hash match whose checkpoint a reviewer has rejected: auto-seeding
      // its image as the baseline would overrule the reviewer.
      const ctx = await setupProject({ autoApproveFeature: true });
      await seedMatchingScreenshots({ ...ctx, viewports: [VP_DESKTOP] });
      const [shot] = await db
        .select({ id: screenshots.id })
        .from(screenshots)
        .where(eq(screenshots.runId, ctx.candidateRunId));
      await db.insert(checkpointDecisions).values({
        projectId: ctx.projectId,
        runId: ctx.candidateRunId,
        screenshotId: shot!.id,
        actionId: randomUUID(),
        decision: "rejected",
        actorId: userId,
        source: "viewer",
      });
      const before = await baselineRows(ctx.variationId);

      await diffRunPerStep(
        { runId: ctx.candidateRunId, projectId: ctx.projectId },
        mockLogger,
        { db, storage, redis },
      );

      expect(await baselineRows(ctx.variationId)).toEqual(before);
      expect(await verdictsOf(ctx.candidateRunId)).toEqual(["passed"]);
    });

    it("(b) the paired baseline is the checkpoint's own row: the approver and its time are kept", async () => {
      // The candidate run was approved by a reviewer (no decision row: a
      // legacy approval), so its own (variation, run) row is the current
      // baseline and a re-diff hash-matches it. Its created_at is set before
      // the run's so guard (c) cannot be what keeps it.
      const ctx = await setupProject({ autoApproveFeature: true });
      await seedMatchingScreenshots({ ...ctx, viewports: [VP_DESKTOP] });
      await db.insert(baselines).values({
        baselineName: "approved-by-reviewer",
        testVariationId: ctx.variationId,
        testRunId: ctx.candidateRunId,
        userId,
        branchName: "main",
        createdAt: sql`(SELECT created_at - interval '1 second' FROM test_runs WHERE id = ${ctx.candidateRunId})`,
      });
      // ...and newest on the branch, so the pairing resolves to it.
      await db
        .update(baselines)
        .set({ createdAt: sql`created_at - interval '1 hour'` })
        .where(eq(baselines.testRunId, ctx.baselineRunId));
      const before = await baselineRows(ctx.variationId);

      await diffRunPerStep(
        { runId: ctx.candidateRunId, projectId: ctx.projectId },
        mockLogger,
        { db, storage, redis },
      );

      expect(await baselineRows(ctx.variationId)).toEqual(before);
      const own = (await baselineRows(ctx.variationId)).find(
        (b) => b.testRunId === ctx.candidateRunId,
      );
      expect(own!.userId).toBe(userId);
      expect(await verdictsOf(ctx.candidateRunId)).toEqual(["passed"]);
    });

    it("(c) a baseline created after the candidate run: a past-baseline match writes nothing", async () => {
      // r0 (image A) was the baseline; r1 (image A) was captured; then r2
      // (image B) was approved. Re-diffing the OLDER r1 pairs with r2 (no hash
      // match) and matches r0 among the past baselines. Writing r1's row would
      // make A, an older image, the current baseline again.
      const uniq = `${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
      const [p] = await db
        .insert(projects)
        .values({ name: `dw-aa-newer-${uniq}`, autoApproveFeature: true })
        .returning();
      const [b] = await db
        .insert(builds)
        .values({ projectId: p!.id, userId, isRunning: false })
        .returning();
      const [v] = await db
        .insert(testVariations)
        .values({ name: "home", projectId: p!.id })
        .returning();
      const newRun = async (status: "passed" | "running") => {
        const [r] = await db
          .insert(testRuns)
          .values({
            buildId: b!.id,
            projectId: p!.id,
            testVariationId: v!.id,
            status,
            branchName: "main",
            name: "home",
          })
          .returning();
        return r!;
      };
      const imageA = await putImage("baseline-a.png");
      const imageB = await putImage("candidate-a-major.png");
      const shot = async (runId: string, imageKey: string) => {
        await db.insert(screenshots).values({
          runId,
          projectId: p!.id,
          testVariationId: v!.id,
          name: "home",
          imageKey,
          viewport: VP_DESKTOP,
          browser: "chromium",
        });
      };

      const r0 = await newRun("passed");
      await shot(r0.id, imageA);
      await db.insert(baselines).values({
        baselineName: imageA,
        testVariationId: v!.id,
        testRunId: r0.id,
        userId,
        branchName: "main",
        createdAt: sql`clock_timestamp()`,
      });
      const r1 = await newRun("running");
      await shot(r1.id, imageA);
      const r2 = await newRun("passed");
      await shot(r2.id, imageB);
      await db.insert(baselines).values({
        baselineName: imageB,
        testVariationId: v!.id,
        testRunId: r2.id,
        userId,
        branchName: "main",
        createdAt: sql`clock_timestamp()`,
      });
      const before = await baselineRows(v!.id);

      await diffRunPerStep({ runId: r1.id, projectId: p!.id }, mockLogger, {
        db,
        storage,
        redis,
      });

      expect(await baselineRows(v!.id)).toEqual(before);
      expect(await verdictsOf(r1.id)).toEqual(["passed"]);
    });
  });
});
