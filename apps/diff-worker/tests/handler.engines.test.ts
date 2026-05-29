import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  baselines,
  builds,
  createDb,
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
 * Per-engine integration coverage for the diff-worker handler.
 *
 * Goal: prove that `project.imageComparison` is read from the DB,
 * threaded through `ProjectDiffConfig` into `runDiff`, and that all
 * three engines complete a real diff job end-to-end. Per-engine pixel
 * semantics are unit-tested in `packages/diff-engine`; this file
 * targets the wiring.
 *
 * The candidate fixture is materially different from the baseline, so
 * every engine must produce a non-zero `diffPercent` and a non-empty
 * diff overlay. Identical-input parity is unit-tested separately.
 *
 * Setup is shared across the three engines (one user, one build, one
 * variation, one baseline run + screenshot + baselines pointer row).
 * Each engine gets its own project + candidate run + candidate
 * screenshot. The candidate screenshot's `image_key` is the same
 * content-addressed hash across all three engines (same fixture), so
 * each iteration deletes the prior iteration's screenshot row before
 * inserting its own — global UNIQUE on `screenshots.image_key`.
 */
desc("handleDiffJob — per-engine wiring (integration)", () => {
  let db: DB;
  let closeDb: () => Promise<void>;
  let storage: Storage;
  let redis: Redis;

  let buildId: string;
  let variationId: string;
  const candidateProjectIds: string[] = [];

  // Same content-addressed keys for every iteration — derived from fixture bytes.
  let baselineImageKey: string;
  let candidateImageKey: string;
  let baselineDomKey: string;
  let candidateDomKey: string;

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
        email: `dw-engines-${uniq}@x.test`,
        hashedPassword: "x",
        firstName: "dw",
        lastName: "engines",
        role: "admin",
      })
      .returning();

    // Use a temporary placeholder project just to anchor build + variation +
    // baseline-run rows. The baseline-run is shared across all engine
    // scenarios; per-engine candidate runs live under their own projects.
    const [seedProject] = await db
      .insert(projects)
      .values({
        name: `dw-engines-seed-${uniq}`,
        mainBranchName: "main",
        diffThreshold: 0.001,
        l2Enabled: true,
      })
      .returning();
    candidateProjectIds.push(seedProject.id);

    const [b] = await db
      .insert(builds)
      .values({ projectId: seedProject.id, userId: u.id, isRunning: true })
      .returning();
    buildId = b.id;

    const [v] = await db
      .insert(testVariations)
      .values({
        name: "v",
        projectId: seedProject.id,
        branchName: "main",
        browser: "chromium",
        viewport: "1280x720",
      })
      .returning();
    variationId = v.id;

    const [baselineRun] = await db
      .insert(testRuns)
      .values({
        name: "baseline-engines",
        projectId: seedProject.id,
        testVariationId: v.id,
        buildId: b.id,
        branchName: "main",
        status: "passed",
      })
      .returning();

    // Upload fixtures (content-addressed; idempotent put).
    const baselineBytes = FIXTURE("baseline-a.png");
    const candidateBytes = FIXTURE("candidate-a-major.png");
    const baselineDomBytes = FIXTURE("dom-baseline.html");
    const candidateDomBytes = FIXTURE("dom-text-change.html");
    baselineImageKey = objectKey(baselineBytes);
    candidateImageKey = objectKey(candidateBytes);
    baselineDomKey = objectKey(baselineDomBytes);
    candidateDomKey = objectKey(candidateDomBytes);
    await storage.put(baselineImageKey, baselineBytes, "image/png");
    await storage.put(candidateImageKey, candidateBytes, "image/png");
    await storage.put(baselineDomKey, baselineDomBytes, "text/html");
    await storage.put(candidateDomKey, candidateDomBytes, "text/html");

    // Pre-clean any orphan rows for the fixture image keys from a prior
    // failed run (image_key has a global UNIQUE constraint).
    await db
      .delete(screenshots)
      .where(
        inArray(screenshots.imageKey, [baselineImageKey, candidateImageKey]),
      );

    // Insert the shared baseline screenshot + baselines pointer.
    await db.insert(screenshots).values({
      runId: baselineRun.id,
      projectId: seedProject.id,
      testVariationId: v.id,
      name: "checkpoint-1",
      imageKey: baselineImageKey,
      domKey: baselineDomKey,
      viewport: "1280x720",
      browser: "chromium",
    });
    await db.insert(baselines).values({
      testVariationId: v.id,
      testRunId: baselineRun.id,
      branchName: "main",
      userId: u.id,
    });
  }, 60_000);

  afterAll(async () => {
    try {
      if (db) {
        // Cascade-delete every project we created (seed + per-engine).
        for (const id of candidateProjectIds) {
          await db.delete(projects).where(eq(projects.id, id));
        }
      }
    } catch {
      /* best-effort */
    }
    if (redis) redis.disconnect();
    if (closeDb) await closeDb();
  });

  // Verify the handler honors project.imageComparison across all three
  // engines. The candidate-a-major fixture is materially different from
  // baseline-a, so every engine must report diffPercent > 0.
  const engines = ["odiff", "pixelmatch", "looks_same"] as const;

  it.each(engines)(
    "diffs candidate against baseline using engine=%s",
    async (engine) => {
      const uniq = `${Date.now()}-${engine}`;

      // Per-engine project carrying the imageComparison setting under test.
      const [p] = await db
        .insert(projects)
        .values({
          name: `dw-engines-${uniq}`,
          mainBranchName: "main",
          diffThreshold: 0.001,
          l2Enabled: true,
          imageComparison: engine,
        })
        .returning();
      candidateProjectIds.push(p.id);

      const [candidateRun] = await db
        .insert(testRuns)
        .values({
          name: `candidate-${engine}`,
          projectId: p.id,
          testVariationId: variationId,
          buildId,
          branchName: "feature/x",
          status: "running",
        })
        .returning();

      // Remove the previous iteration's candidate screenshot so its
      // global-UNIQUE image_key is available for this iteration.
      await db
        .delete(screenshots)
        .where(eq(screenshots.imageKey, candidateImageKey));

      await db.insert(screenshots).values({
        runId: candidateRun.id,
        projectId: p.id,
        testVariationId: variationId,
        name: "checkpoint-1",
        imageKey: candidateImageKey,
        domKey: candidateDomKey,
        viewport: "1280x720",
        browser: "chromium",
      });

      // The handler also needs the baseline-screenshot row to exist for
      // the resolveBaseline lookup. The shared baseline-screenshot is on
      // the seed project's baseline run — but baselines.test_run_id points
      // there, and resolveBaseline uses the variation + branch lookup, not
      // the project id of the baseline. Confirm by running the handler.

      const job: DiffJob = {
        runId: candidateRun.id,
        projectId: p.id,
      };

      await handleDiffJob(job, mockLogger, { db, storage, redis });

      const updatedRun = await db.query.testRuns.findFirst({
        where: eq(testRuns.id, candidateRun.id),
      });
      expect(updatedRun).toBeDefined();
      expect(updatedRun!.status).toBe("unresolved");
      expect(updatedRun!.diffPercent ?? 0).toBeGreaterThan(0);
      expect(updatedRun!.pixelMisMatchCount ?? 0).toBeGreaterThan(0);
      expect(updatedRun!.diffName).toMatch(/^[0-9a-f]{64}$/);

      const overlay = await storage.get(updatedRun!.diffName!);
      expect(overlay.byteLength).toBeGreaterThan(0);
    },
    60_000,
  );

  it("falls back to engine defaults when imageComparisonConfig is malformed", async () => {
    const uniq = `${Date.now()}-malformed`;
    const [p] = await db
      .insert(projects)
      .values({
        name: `dw-engines-${uniq}`,
        mainBranchName: "main",
        diffThreshold: 0.001,
        l2Enabled: true,
        imageComparison: "pixelmatch",
        // Not valid JSON — parseEngineConfig should warn-log + fall back
        // to DEFAULT_ENGINE_CONFIG.
        imageComparisonConfig: "{not valid json",
      })
      .returning();
    candidateProjectIds.push(p.id);

    const [candidateRun] = await db
      .insert(testRuns)
      .values({
        name: "candidate-malformed",
        projectId: p.id,
        testVariationId: variationId,
        buildId,
        branchName: "feature/malformed",
        status: "running",
      })
      .returning();

    await db
      .delete(screenshots)
      .where(eq(screenshots.imageKey, candidateImageKey));

    await db.insert(screenshots).values({
      runId: candidateRun.id,
      projectId: p.id,
      testVariationId: variationId,
      name: "checkpoint-1",
      imageKey: candidateImageKey,
      domKey: candidateDomKey,
      viewport: "1280x720",
      browser: "chromium",
    });

    const job: DiffJob = {
      runId: candidateRun.id,
      projectId: p.id,
    };

    await handleDiffJob(job, mockLogger, { db, storage, redis });

    const updatedRun = await db.query.testRuns.findFirst({
      where: eq(testRuns.id, candidateRun.id),
    });
    expect(updatedRun).toBeDefined();
    expect(updatedRun!.status).toBe("unresolved");
    expect(updatedRun!.diffPercent ?? 0).toBeGreaterThan(0);
  }, 60_000);
});
