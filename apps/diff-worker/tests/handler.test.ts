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
        imageKey: baselineImageKey,
        domKey: baselineDomKey,
        viewport: "1280x720",
        browser: "chromium",
      },
      {
        runId: candidateRun.id,
        projectId: p.id,
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
    expect(updatedRun!.status).toBe("failed");
    expect(updatedRun!.baselineSource).toBe("default_branch");
    expect(updatedRun!.diffPercent).toBeGreaterThan(0);
    expect(updatedRun!.pixelMisMatchCount).toBeGreaterThan(0);
    expect(updatedRun!.diffName).toMatch(/^[0-9a-f]{64}$/);

    // Sanity: the candidate-a-major fixture is a substantial diff (~50% blue overlay).
    expect(updatedRun!.diffPercent!).toBeGreaterThan(10);

    // Verify diff_regions inserted. With DOMs uploaded the L2 tier fires and
    // emits at least one region (the <h1> text changed: "Buy now" -> "Get started").
    const regions = await db.query.diffRegions.findMany({
      where: eq(diffRegions.runId, candidateRunId),
    });
    expect(regions.length).toBeGreaterThan(0);
    expect(regions[0].projectId).toBe(projectId);
    expect(regions[0].source).toBe("l2");

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
    // way the aggregate must be "failed" because the 1280x720 viewport fails.
    expect(updatedRun!.status).toBe("failed");
    expect(updatedRun!.diffPercent!).toBeGreaterThan(10);

    // diff_regions rows MUST carry the viewport column populated for
    // every row inserted by the v0.5 multi-viewport flow.
    const regions = await db.query.diffRegions.findMany({
      where: eq(diffRegions.runId, candidateRunId),
    });
    expect(regions.length).toBeGreaterThan(0);
    for (const r of regions) {
      expect(r.viewport).not.toBeNull();
      // All regions should come from the 1280x720 viewport (the failing one)
      // because the 375x812 viewport pair was identical / passing.
      expect(r.viewport).toBe("1280x720");
    }

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
    expect(runCompleted.status).toBe("failed");

    sub.disconnect();
  }, 60_000);
});
