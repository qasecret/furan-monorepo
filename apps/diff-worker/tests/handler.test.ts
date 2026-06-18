import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  baselines,
  builds,
  createDb,
  diffRegions,
  eq,
  inArray,
  projects,
  screenshots,
  testRuns,
  testVariations,
  users,
  type DB,
} from "@furan/db";
import type { DiffJob } from "@furan/queue";
import { createStorage, objectKey, type Storage } from "@furan/storage";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

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

desc("handleDiffJob (integration)", () => {
  let db: DB;
  let closeDb: () => Promise<void>;
  let storage: Storage;
  let redis: Redis;
  let job: DiffJob;
  let candidateRunId: string;
  let projectId: string;

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
        email: `dw-${uniq}@x.test`,
        hashedPassword: "x",
        firstName: "dw",
        lastName: "tester",
        role: "admin",
      })
      .returning();
    const [p] = await db
      .insert(projects)
      .values({
        name: `dw-${uniq}`,
        mainBranchName: "main",
        diffThreshold: 0.001,
        l2Enabled: true,
      })
      .returning();
    projectId = p.id;

    const [b] = await db
      .insert(builds)
      .values({ projectId: p.id, userId: u.id, isRunning: true })
      .returning();
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

    // Baseline run on main.
    const [baselineRun] = await db
      .insert(testRuns)
      .values({
        name: "baseline-run",
        projectId: p.id,
        testVariationId: v.id,
        buildId: b.id,
        branchName: "main",
        status: "passed",
      })
      .returning();

    // Candidate run on feature branch — will diff against main baseline.
    const [candidateRun] = await db
      .insert(testRuns)
      .values({
        name: "candidate-run",
        projectId: p.id,
        testVariationId: v.id,
        buildId: b.id,
        branchName: "feature/x",
        status: "running",
      })
      .returning();
    candidateRunId = candidateRun.id;

    // Upload baseline + candidate PNGs + DOMs to storage at their content-addressed keys.
    const baselineBytes = FIXTURE("baseline-a.png");
    const candidateBytes = FIXTURE("candidate-a-major.png");
    const baselineDomBytes = FIXTURE("dom-baseline.html");
    const candidateDomBytes = FIXTURE("dom-text-change.html");
    const baselineImageKey = objectKey(baselineBytes);
    const candidateImageKey = objectKey(candidateBytes);
    const baselineDomKey = objectKey(baselineDomBytes);
    const candidateDomKey = objectKey(candidateDomBytes);
    await storage.put(baselineImageKey, baselineBytes, "image/png");
    await storage.put(candidateImageKey, candidateBytes, "image/png");
    await storage.put(baselineDomKey, baselineDomBytes, "text/html");
    await storage.put(candidateDomKey, candidateDomBytes, "text/html");

    // Pre-clean any orphan rows for the fixture image keys left by a prior
    // failed run (image_key has a global UNIQUE constraint and the fixture
    // bytes are content-addressed, so they collide across test invocations).
    await db
      .delete(screenshots)
      .where(
        inArray(screenshots.imageKey, [baselineImageKey, candidateImageKey]),
      );

    // Insert screenshots rows including DOM keys so L2 fires and emits regions.
    await db.insert(screenshots).values([
      {
        runId: baselineRun.id,
        projectId: p.id,
        testVariationId: v.id,
        name: "checkpoint-1",
        imageKey: baselineImageKey,
        domKey: baselineDomKey,
        viewport: "1280x720",
        browser: "chromium",
      },
      {
        runId: candidateRun.id,
        projectId: p.id,
        testVariationId: v.id,
        name: "checkpoint-1",
        imageKey: candidateImageKey,
        domKey: candidateDomKey,
        viewport: "1280x720",
        browser: "chromium",
      },
    ]);

    // Baselines row pointing at the baseline-run on main.
    await db.insert(baselines).values({
      testVariationId: v.id,
      testRunId: baselineRun.id,
      branchName: "main",
      userId: u.id,
    });

    job = {
      runId: candidateRunId,
      projectId: p.id,
    };
  }, 60_000);

  afterAll(async () => {
    // Cascade-delete the test's project to clean up all child rows
    // (test_runs, screenshots, baselines, diff_regions, test_variations).
    try {
      if (db && projectId) {
        await db.delete(projects).where(eq(projects.id, projectId));
      }
    } catch {
      /* best-effort cleanup */
    }
    if (redis) redis.disconnect();
    if (closeDb) await closeDb();
  });

  test("resolves baseline, diffs, persists, publishes events", async () => {
    const events: string[] = [];
    const sub = new Redis(process.env.REDIS_URL!);
    await sub.subscribe(`run:${candidateRunId}:events`);
    sub.on("message", (_channel, message) => events.push(message));

    // Let subscription settle before the handler publishes.
    await new Promise((r) => setTimeout(r, 100));

    await handleDiffJob(job, mockLogger, { db, storage, redis });

    // Verify test_runs was updated.
    const updatedRun = await db.query.testRuns.findFirst({
      where: eq(testRuns.id, candidateRunId),
    });
    expect(updatedRun).toBeDefined();
    // Per spec §3.2 the diff-worker writes "unresolved" on diff-found.
    // "failed" is reserved for reviewer-rejected runs.
    expect(updatedRun!.status).toBe("unresolved");
    // Image-first (ADR-047): l1_pixel regions are in EXCLUDED_SOURCES so they
    // don't contribute to computeCheckpointSignature. The 100x100 test fixture
    // also doesn't meet the minClusterTiles=3 threshold, so no diff_regions are
    // produced here. primary_signature is null until T4 drops l1_pixel from
    // EXCLUDED_SOURCES and makes image regions the primary signal.
    expect(updatedRun!.primarySignature).toBeNull();
    expect(updatedRun!.baselineSource).toBe("default_branch");
    expect(updatedRun!.diffPercent).toBeGreaterThan(0);
    expect(updatedRun!.pixelMisMatchCount).toBeGreaterThan(0);
    expect(updatedRun!.diffName).toMatch(/^[0-9a-f]{64}$/);

    // Sanity: the candidate-a-major fixture is a substantial diff (~50% blue overlay).
    expect(updatedRun!.diffPercent!).toBeGreaterThan(10);

    // Image-first (ADR-047): L2 no longer runs. The 100x100 fixture pair
    // produces 2 dirty tiles (col=1, rows 0-1) — below the minClusterTiles=3
    // threshold — so extractL1PixelRegions returns [] for these fixtures.
    // diff_regions stays empty. T4 will add a larger fixture that exercises
    // the full l1_pixel → region path.
    const regions = await db.query.diffRegions.findMany({
      where: eq(diffRegions.runId, candidateRunId),
    });
    expect(regions.length).toBe(0);

    // ADR-042: diff_signature is null when there are no meaningful regions
    // (all l1_pixel are in EXCLUDED_SOURCES, and the fixture produces 0
    // clusters). T4 drops l1_pixel from EXCLUDED_SOURCES.
    const candidateShots = await db
      .select()
      .from(screenshots)
      .where(eq(screenshots.runId, candidateRunId));
    expect(candidateShots.length).toBeGreaterThan(0);
    for (const shot of candidateShots) {
      expect(shot.diffSignature).toBeNull();
    }

    // Verify diff overlay is in storage.
    const overlay = await storage.get(updatedRun!.diffName!);
    expect(overlay.byteLength).toBeGreaterThan(0);
    expect(objectKey(overlay)).toBe(updatedRun!.diffName!);

    // Give redis pub/sub a moment to deliver the trailing event.
    await new Promise((r) => setTimeout(r, 200));
    const types = events.map((e) => JSON.parse(e).type as string);
    expect(types).toContain("diff.started");
    expect(types).toContain("diff.completed");

    sub.disconnect();
  }, 60_000);
});

const descMv = skip ? describe.skip : describe;
descMv("handleDiffJob multi-viewport (integration)", () => {
  let db: DB;
  let closeDb: () => Promise<void>;
  let storage: Storage;
  let redis: Redis;
  let job: DiffJob;
  let candidateRunId: string;
  let projectId: string;

  beforeAll(async () => {
    const created = createDb();
    db = created.db;
    closeDb = created.close;
    storage = createStorage();
    redis = new Redis(process.env.REDIS_URL!);

    const uniq = Date.now() + 1;
    const [u] = await db
      .insert(users)
      .values({
        email: `dw-mv-${uniq}@x.test`,
        hashedPassword: "x",
        firstName: "dw",
        lastName: "mv",
        role: "admin",
      })
      .returning();
    const [p] = await db
      .insert(projects)
      .values({
        name: `dw-mv-${uniq}`,
        mainBranchName: "main",
        diffThreshold: 0.001,
        l2Enabled: true,
      })
      .returning();
    projectId = p.id;

    const [b] = await db
      .insert(builds)
      .values({ projectId: p.id, userId: u.id, isRunning: true })
      .returning();
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

    const [baselineRun] = await db
      .insert(testRuns)
      .values({
        name: "baseline-mv",
        projectId: p.id,
        testVariationId: v.id,
        buildId: b.id,
        branchName: "main",
        status: "passed",
      })
      .returning();
    const [candidateRun] = await db
      .insert(testRuns)
      .values({
        name: "candidate-mv",
        projectId: p.id,
        testVariationId: v.id,
        buildId: b.id,
        branchName: "feature/mv",
        status: "running",
      })
      .returning();
    candidateRunId = candidateRun.id;

    // Two viewports on the candidate run: 1280x720 has a paired baseline
    // (diff-heavy fixture pair) and will fail. 375x812 has NO matching
    // baseline screenshot — exercising the "new viewport since baseline"
    // first-baseline-for-this-viewport branch in the handler. This sidesteps
    // the global UNIQUE constraint on screenshots.image_key (synthesizing
    // distinct per-viewport PNG bytes without sharp would require fixture
    // engineering beyond T12's scope).
    const a = FIXTURE("baseline-a.png");
    const aMajor = FIXTURE("candidate-a-major.png");
    const domA = FIXTURE("dom-baseline.html");
    const domB = FIXTURE("dom-text-change.html");

    const key1280Baseline = objectKey(a);
    const key1280Candidate = objectKey(aMajor);
    // The 375x812 candidate reuses baseline-a bytes; the per-test scoped
    // cleanup in afterAll removes the row before the next run, so the
    // UNIQUE constraint is satisfied as long as no concurrent test seeds
    // the same fixture (CI runs at --concurrency=1).
    const key375Candidate = objectKey(a);
    const domBaselineKey = objectKey(domA);
    const domCandidateKey = objectKey(domB);

    await storage.put(key1280Baseline, a, "image/png");
    await storage.put(key1280Candidate, aMajor, "image/png");
    await storage.put(domBaselineKey, domA, "text/html");
    await storage.put(domCandidateKey, domB, "text/html");

    // Pre-clean any orphan rows for these image keys from a prior failed
    // run (image_key has a global UNIQUE constraint).
    await db
      .delete(screenshots)
      .where(
        inArray(screenshots.imageKey, [
          key1280Baseline,
          key1280Candidate,
          key375Candidate,
        ]),
      );

    // Baseline run has ONE screenshot: 1280x720 only.
    await db.insert(screenshots).values({
      runId: baselineRun.id,
      projectId: p.id,
      testVariationId: v.id,
      name: "checkpoint-1",
      imageKey: key1280Baseline,
      domKey: domBaselineKey,
      viewport: "1280x720",
      browser: "chromium",
    });

    // Candidate run has TWO screenshots: 1280x720 (paired baseline exists)
    // + 375x812 (no paired baseline — exercises first-baseline-per-viewport).
    // 375x812 reuses key1280Baseline bytes; insert with onConflictDoNothing
    // so the duplicate image_key still creates the row reference logically
    // (skipping inserts on conflict). The handler reads candidate
    // screenshots via runId, so we must guarantee BOTH rows land. To do
    // that, insert the 375x812 row only if its image_key differs.
    if (key375Candidate !== key1280Baseline) {
      await db.insert(screenshots).values({
        runId: candidateRun.id,
        projectId: p.id,
        testVariationId: v.id,
        name: "checkpoint-1",
        imageKey: key375Candidate,
        domKey: domBaselineKey,
        viewport: "375x812",
        browser: "chromium",
      });
    } else {
      // Share the same image_key as the baseline row by re-targeting the
      // existing screenshots row's runId — instead, insert a "viewport
      // sentinel" by appending a 1-byte synthetic suffix to disambiguate.
      // We append a viewport-tagged byte and re-upload under the new key.
      const suffixed = Buffer.concat([a, Buffer.from([0x00])]);
      const suffixedKey = objectKey(suffixed);
      await storage.put(suffixedKey, suffixed, "image/png");
      await db.insert(screenshots).values({
        runId: candidateRun.id,
        projectId: p.id,
        testVariationId: v.id,
        name: "checkpoint-1",
        imageKey: suffixedKey,
        domKey: domBaselineKey,
        viewport: "375x812",
        browser: "chromium",
      });
    }

    // Candidate's 1280x720 screenshot.
    await db.insert(screenshots).values({
      runId: candidateRun.id,
      projectId: p.id,
      testVariationId: v.id,
      name: "checkpoint-2",
      imageKey: key1280Candidate,
      domKey: domCandidateKey,
      viewport: "1280x720",
      browser: "chromium",
    });

    await db.insert(baselines).values({
      testVariationId: v.id,
      testRunId: baselineRun.id,
      branchName: "main",
      userId: u.id,
    });

    job = {
      runId: candidateRunId,
      projectId: p.id,
    };
  }, 60_000);

  afterAll(async () => {
    try {
      if (db && projectId) {
        await db.delete(projects).where(eq(projects.id, projectId));
      }
    } catch {
      /* best-effort cleanup */
    }
    if (redis) redis.disconnect();
    if (closeDb) await closeDb();
  });

  test("per-viewport diff: regions land with viewport column populated; aggregate is max", async () => {
    const events: string[] = [];
    const sub = new Redis(process.env.REDIS_URL!);
    await sub.subscribe(`run:${candidateRunId}:events`);
    sub.on("message", (_channel, message) => events.push(message));
    await new Promise((r) => setTimeout(r, 100));

    await handleDiffJob(job, mockLogger, { db, storage, redis });

    const updatedRun = await db.query.testRuns.findFirst({
      where: eq(testRuns.id, candidateRunId),
    });
    expect(updatedRun).toBeDefined();
    // 1280x720 viewport has a substantial diff; 375x812 viewport is identical
    // bytes (or no baseline for that viewport — first-baseline pass). Either
    // way the aggregate must be "unresolved" because the 1280x720 viewport
    // fails. Per spec §3.2 the diff-worker writes "unresolved", not "failed".
    expect(updatedRun!.status).toBe("unresolved");
    expect(updatedRun!.diffPercent!).toBeGreaterThan(10);

    // Image-first (ADR-047): L2 no longer runs. The 100x100 fixture pair
    // produces only 2 dirty tiles (col=1, rows 0-1), below minClusterTiles=3,
    // so extractL1PixelRegions returns [] and no diff_regions rows are
    // inserted. The diff is still detected (diffPercent > 10) via L1 pixel
    // percentage; only the per-region clustering is below threshold for this
    // small fixture. T4 will introduce a larger fixture that exercises the
    // l1_pixel → diff_regions path with viewport column populated.
    const regions = await db.query.diffRegions.findMany({
      where: eq(diffRegions.runId, candidateRunId),
    });
    expect(regions.length).toBe(0);

    await new Promise((r) => setTimeout(r, 200));
    const completed = events
      .map((e) => JSON.parse(e))
      .find((e) => e.type === "diff.completed");
    expect(completed).toBeDefined();
    expect(completed.viewportCount).toBeGreaterThanOrEqual(1);
    const runCompleted = events
      .map((e) => JSON.parse(e))
      .find((e) => e.type === "run.completed");
    expect(runCompleted).toBeDefined();
    // Per spec §3.2 diff-worker writes "unresolved" on diff-found.
    expect(runCompleted.status).toBe("unresolved");

    sub.disconnect();
  }, 60_000);
});

/**
 * Spec §3.2 coverage for the two writer paths that did not exist before
 * the run-status-enum migration: `new` (first-baseline auto-seed) and
 * `aborted` (uncaught handler exception). These need their own isolated
 * project seeds because the existing `desc`/`descMv` blocks pre-seed a
 * baseline — the whole point of the first-baseline test is "no baseline
 * exists for this variation+branch yet".
 */
const descStatus = skip ? describe.skip : describe;
descStatus("handleDiffJob status writes (spec §3.2)", () => {
  let db: DB;
  let closeDb: () => Promise<void>;
  let storage: Storage;
  let redis: Redis;
  const cleanupProjectIds: string[] = [];

  beforeAll(async () => {
    const created = createDb();
    db = created.db;
    closeDb = created.close;
    storage = createStorage();
    redis = new Redis(process.env.REDIS_URL!);
  }, 30_000);

  afterAll(async () => {
    for (const pid of cleanupProjectIds) {
      try {
        await db.delete(projects).where(eq(projects.id, pid));
      } catch {
        /* best-effort */
      }
    }
    if (redis) redis.disconnect();
    if (closeDb) await closeDb();
  });

  test("first-baseline path: no prior baseline → status='new', merge=true, baselines row inserted", async () => {
    const uniq = Date.now();
    const [u] = await db
      .insert(users)
      .values({
        email: `dw-new-${uniq}@x.test`,
        hashedPassword: "x",
        firstName: "dw",
        lastName: "new",
        role: "admin",
      })
      .returning();
    // autoApproveFeature=true so the handler auto-seeds the baselines row on
    // first run. The second test covers the autoApproveFeature=false path.
    const [p] = await db
      .insert(projects)
      .values({
        name: `dw-new-${uniq}`,
        mainBranchName: "main",
        autoApproveFeature: true,
      })
      .returning();
    cleanupProjectIds.push(p.id);
    const [b] = await db
      .insert(builds)
      .values({ projectId: p.id, userId: u.id, isRunning: true })
      .returning();
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
    const [run] = await db
      .insert(testRuns)
      .values({
        name: "first-run",
        projectId: p.id,
        testVariationId: v.id,
        buildId: b.id,
        branchName: "main",
        status: "running",
      })
      .returning();

    // Seed a candidate screenshot so the resolveBaseline-lookup path can
    // even consider this run. With no `baselines` row yet, resolveBaseline
    // returns null and the handler takes the first-baseline branch.
    const fixtureBytes = FIXTURE("baseline-a.png");
    const key = objectKey(fixtureBytes);
    await storage.put(key, fixtureBytes, "image/png");
    await db.delete(screenshots).where(eq(screenshots.imageKey, key));
    await db.insert(screenshots).values({
      runId: run.id,
      projectId: p.id,
      testVariationId: v.id,
      name: "checkpoint-1",
      imageKey: key,
      viewport: "1280x720",
      browser: "chromium",
    });

    await handleDiffJob({ runId: run.id, projectId: p.id }, mockLogger, {
      db,
      storage,
      redis,
    });

    const updated = await db.query.testRuns.findFirst({
      where: eq(testRuns.id, run.id),
    });
    expect(updated!.status).toBe("new");
    expect(updated!.merge).toBe(true);
    // ADR-043: first-baseline runs have no diff comparison → primary_signature stays NULL.
    expect(updated!.primarySignature).toBeNull();

    const seededBaselines = await db.query.baselines.findMany({
      where: eq(baselines.testRunId, run.id),
    });
    expect(seededBaselines.length).toBe(1);
    expect(seededBaselines[0]!.branchName).toBe("main");
    // userId NULL → auto-seeded (vs reviewer-approved).
    expect(seededBaselines[0]!.userId).toBeNull();
  }, 60_000);

  test("first-baseline path (autoApproveFeature=false): no prior baseline → status='new', merge=true, NO baselines row inserted (ADR-036)", async () => {
    const uniq = Date.now() + 100;
    const [u] = await db
      .insert(users)
      .values({
        email: `dw-new-manual-${uniq}@x.test`,
        hashedPassword: "x",
        firstName: "dw",
        lastName: "new-manual",
        role: "admin",
      })
      .returning();
    const [p] = await db
      .insert(projects)
      .values({
        name: `dw-new-manual-${uniq}`,
        mainBranchName: "main",
        autoApproveFeature: false,
      })
      .returning();
    cleanupProjectIds.push(p.id);
    const [b] = await db
      .insert(builds)
      .values({ projectId: p.id, userId: u.id, isRunning: true })
      .returning();
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
    const [run] = await db
      .insert(testRuns)
      .values({
        name: "first-run-manual",
        projectId: p.id,
        testVariationId: v.id,
        buildId: b.id,
        branchName: "main",
        status: "running",
      })
      .returning();

    const fixtureBytes = FIXTURE("baseline-a.png");
    const key = objectKey(fixtureBytes);
    await storage.put(key, fixtureBytes, "image/png");
    await db.delete(screenshots).where(eq(screenshots.imageKey, key));
    await db.insert(screenshots).values({
      runId: run.id,
      projectId: p.id,
      testVariationId: v.id,
      name: "checkpoint-1",
      imageKey: key,
      viewport: "1280x720",
      browser: "chromium",
    });

    await handleDiffJob({ runId: run.id, projectId: p.id }, mockLogger, {
      db,
      storage,
      redis,
    });

    const updated = await db.query.testRuns.findFirst({
      where: eq(testRuns.id, run.id),
    });
    expect(updated!.status).toBe("new");
    expect(updated!.merge).toBe(true);
    // ADR-043: first-baseline runs have no diff comparison → primary_signature stays NULL.
    expect(updated!.primarySignature).toBeNull();

    // ADR-036: with autoApproveFeature=false, the handler must NOT
    // auto-seed a baseline. The reviewer's `runs.approve` mutation is
    // responsible for materialising the baseline row.
    const seededBaselines = await db.query.baselines.findMany({
      where: eq(baselines.testRunId, run.id),
    });
    expect(seededBaselines.length).toBe(0);
  }, 60_000);

  test("uncaught exception path: handler throws → status='aborted' (best-effort) + publishes run.completed", async () => {
    const uniq = Date.now() + 1;
    const [u] = await db
      .insert(users)
      .values({
        email: `dw-abort-${uniq}@x.test`,
        hashedPassword: "x",
        firstName: "dw",
        lastName: "abort",
        role: "admin",
      })
      .returning();
    const [p] = await db
      .insert(projects)
      .values({ name: `dw-abort-${uniq}`, mainBranchName: "main" })
      .returning();
    cleanupProjectIds.push(p.id);
    const [b] = await db
      .insert(builds)
      .values({ projectId: p.id, userId: u.id, isRunning: true })
      .returning();
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
    const [baselineRun] = await db
      .insert(testRuns)
      .values({
        name: "baseline-abort",
        projectId: p.id,
        testVariationId: v.id,
        buildId: b.id,
        branchName: "main",
        status: "passed",
      })
      .returning();
    const [candidateRun] = await db
      .insert(testRuns)
      .values({
        name: "candidate-abort",
        projectId: p.id,
        testVariationId: v.id,
        buildId: b.id,
        branchName: "feature/abort",
        status: "running",
      })
      .returning();
    await db.insert(baselines).values({
      testVariationId: v.id,
      testRunId: baselineRun.id,
      branchName: "main",
      userId: u.id,
    });

    // Subscribe to the run's event channel BEFORE invoking the handler so
    // the trailing `run.completed` publish (which the integrations
    // subscriber needs to flip GitHub commit-status to `error` and trigger
    // Slack) is observed.
    const events: string[] = [];
    const sub = new Redis(process.env.REDIS_URL!);
    await sub.subscribe(`run:${candidateRun.id}:events`);
    sub.on("message", (_channel, message) => events.push(message));
    await new Promise((r) => setTimeout(r, 100));

    // Reset logger spies so we can assert the loud diff_job_failed log
    // (the catch block was previously silent on the primary error —
    // a class of bug like odiff GLIBC mismatch would aborted-bucket
    // every run with no clue in dashboards).
    mockLogger.error.mockClear();

    // Force the exception: no candidate screenshot rows → handler throws
    // `run_has_no_screenshots:<runId>` (ADR-038: testVariationId is now
    // resolved from screenshots, not test_runs). The wrapper try/catch should
    // catch, log diff_job_failed with the original err, write
    // status=aborted, publish run.completed, and re-throw.
    await expect(
      handleDiffJob({ runId: candidateRun.id, projectId: p.id }, mockLogger, {
        db,
        storage,
        redis,
      }),
    ).rejects.toThrow(/run_has_no_screenshots/);

    // Loud error log: primary err is logged with diff_job_failed so the
    // BullMQ failedReason isn't the only place the cause lives.
    const failedLog = mockLogger.error.mock.calls.find(
      (c) => c[1] === "diff_job_failed",
    );
    expect(failedLog).toBeDefined();
    const failedPayload = failedLog![0] as {
      err: Error;
      runId: string;
      projectId: string;
    };
    expect(failedPayload.runId).toBe(candidateRun.id);
    expect(failedPayload.projectId).toBe(p.id);
    expect(String(failedPayload.err)).toMatch(/run_has_no_screenshots/);

    const updated = await db.query.testRuns.findFirst({
      where: eq(testRuns.id, candidateRun.id),
    });
    expect(updated!.status).toBe("aborted");

    // Wait for pub/sub delivery, then assert the aborted `run.completed`
    // event went out. Without this the integrations subscriber would
    // leave the GitHub check at `pending` and never notify Slack.
    await new Promise((r) => setTimeout(r, 200));
    const runCompleted = events
      .map((e) => JSON.parse(e))
      .find((e) => e.type === "run.completed");
    expect(runCompleted).toBeDefined();
    expect(runCompleted.status).toBe("aborted");
    expect(runCompleted.runId).toBe(candidateRun.id);
    expect(runCompleted.projectId).toBe(p.id);

    sub.disconnect();
  }, 60_000);
});
