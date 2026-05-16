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
