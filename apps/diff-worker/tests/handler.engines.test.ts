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

/**
 * Image-first (ADR-047): matchLevel:"Layout" no longer routes to a DOM-only
 * diff. It maps to the same image diff as every other matchLevel. This test
 * locks in that collapse: a Layout checkpoint with both DOMs present must run
 * the image tier (ranTiers:["l1"]) and must not produce any source:"l2"
 * diff_regions rows.
 */
const descLayout = skip ? describe.skip : describe;
descLayout(
  "handleDiffJob matchLevel:Layout — image-first lock-in (ADR-047)",
  () => {
    let db: DB;
    let closeDb: () => Promise<void>;
    let storage: Storage;
    let redis: Redis;
    const cleanupProjectIds: string[] = [];

    let buildId: string;
    let variationId: string;
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
          email: `dw-layout-${uniq}@x.test`,
          hashedPassword: "x",
          firstName: "dw",
          lastName: "layout",
          role: "admin",
        })
        .returning();

      const [seedProject] = await db
        .insert(projects)
        .values({
          name: `dw-layout-seed-${uniq}`,
          mainBranchName: "main",
          diffThreshold: 0.001,
        })
        .returning();
      cleanupProjectIds.push(seedProject.id);

      const [b] = await db
        .insert(builds)
        .values({ projectId: seedProject.id, userId: u.id, isRunning: true })
        .returning();
      buildId = b.id;

      const [v] = await db
        .insert(testVariations)
        .values({
          name: "v-layout",
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
          name: "baseline-layout",
          projectId: seedProject.id,
          testVariationId: v.id,
          buildId: b.id,
          branchName: "main",
          status: "passed",
        })
        .returning();

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

      await db
        .delete(screenshots)
        .where(
          inArray(screenshots.imageKey, [baselineImageKey, candidateImageKey]),
        );

      await db.insert(screenshots).values({
        runId: baselineRun.id,
        projectId: seedProject.id,
        testVariationId: v.id,
        name: "checkpoint-layout",
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
          for (const id of cleanupProjectIds) {
            await db.delete(projects).where(eq(projects.id, id));
          }
        }
      } catch {
        /* best-effort */
      }
      if (redis) redis.disconnect();
      if (closeDb) await closeDb();
    });

    it("Layout checkpoint runs image diff (ranTiers=['l1']) and produces no source:l2 regions", async () => {
      const uniq = `${Date.now()}-layout`;

      const [p] = await db
        .insert(projects)
        .values({
          name: `dw-layout-${uniq}`,
          mainBranchName: "main",
          diffThreshold: 0.001,
        })
        .returning();
      cleanupProjectIds.push(p.id);

      const [candidateRun] = await db
        .insert(testRuns)
        .values({
          name: `candidate-layout-${uniq}`,
          projectId: p.id,
          testVariationId: variationId,
          buildId,
          branchName: "feature/layout",
          status: "running",
        })
        .returning();

      await db
        .delete(screenshots)
        .where(eq(screenshots.imageKey, candidateImageKey));

      // matchLevel:"Layout" on the candidate screenshot — image-first (ADR-047)
      // must route this through runDiff (image compare), not runL2 (DOM-only).
      await db.insert(screenshots).values({
        runId: candidateRun.id,
        projectId: p.id,
        testVariationId: variationId,
        name: "checkpoint-layout",
        imageKey: candidateImageKey,
        domKey: candidateDomKey,
        viewport: "1280x720",
        browser: "chromium",
        matchLevel: "Layout",
      });

      const events: string[] = [];
      const sub = new Redis(process.env.REDIS_URL!);
      await sub.subscribe(`run:${candidateRun.id}:events`);
      sub.on("message", (_ch, msg) => events.push(msg));
      await new Promise((r) => setTimeout(r, 100));

      const job: DiffJob = {
        runId: candidateRun.id,
        projectId: p.id,
      };
      await handleDiffJob(job, mockLogger, { db, storage, redis });

      // Image diff must have fired — pixel mismatch detected even at Layout level.
      const updatedRun = await db.query.testRuns.findFirst({
        where: eq(testRuns.id, candidateRun.id),
      });
      expect(updatedRun).toBeDefined();
      expect(updatedRun!.status).toBe("unresolved");
      expect(updatedRun!.diffPercent ?? 0).toBeGreaterThan(0);

      // No source:"l2" diff_regions — DOM-only path is gone (ADR-047).
      const l2Rows = await db.query.diffRegions.findMany({
        where: eq(diffRegions.runId, candidateRun.id),
      });
      const l2Sources = l2Rows.filter((r) => r.source === "l2");
      expect(l2Sources.length).toBe(0);

      // ranTiers in the diff.completed event must be ["l1"], not ["l2"].
      await new Promise((r) => setTimeout(r, 200));
      const completed = events
        .map((e) => JSON.parse(e))
        .find((e) => e.type === "diff.completed");
      expect(completed).toBeDefined();
      expect(completed.ranTiers).toEqual(["l1"]);

      sub.disconnect();
    }, 60_000);
  },
);
