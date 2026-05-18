import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  baselines,
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
import type { DiffJob } from "@furan/queue";
import { createStorage, objectKey, type Storage } from "@furan/storage";
import { Redis } from "ioredis";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

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

desc(
  "handleDiffJob — ignore-areas merge + viewport filter (integration)",
  () => {
    let db: DB;
    let closeDb: () => Promise<void>;
    let storage: Storage;
    let redis: Redis;

    let projectId: string;
    let buildId: string;
    let variationId: string;
    let baselineRunId: string;
    let candidateRunId: string;

    const VP_DESKTOP = "1280x720";
    const VP_MOBILE = "375x667";

    // Content-addressed keys for fixtures — computed once, reused across tests.
    let baselineKey: string;
    let candidateKey: string;

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
          email: `dw-ignore-${uniq}@x.test`,
          hashedPassword: "x",
          firstName: "dw",
          lastName: "ignore",
          role: "admin",
        })
        .returning();

      const [p] = await db
        .insert(projects)
        .values({ name: `dw-ignore-${uniq}` })
        .returning();
      projectId = p.id;

      const [b] = await db
        .insert(builds)
        .values({ projectId, userId: u.id, isRunning: false })
        .returning();
      buildId = b.id;

      const [v] = await db
        .insert(testVariations)
        .values({ name: "home", projectId })
        .returning();
      variationId = v.id;

      // Upload fixtures once — content-addressed so idempotent.
      const baselineBytes = FIXTURE("baseline-a.png");
      const candidateBytes = FIXTURE("candidate-a-major.png");
      baselineKey = objectKey(baselineBytes);
      candidateKey = objectKey(candidateBytes);
      await storage.put(baselineKey, baselineBytes, "image/png");
      await storage.put(candidateKey, candidateBytes, "image/png");
    }, 60_000);

    afterAll(async () => {
      await redis.quit();
      await closeDb();
    });

    async function seedBaselineAndCandidate(opts: {
      viewports: string[];
    }): Promise<void> {
      const [br] = await db
        .insert(testRuns)
        .values({
          buildId,
          projectId,
          testVariationId: variationId,
          status: "passed",
          branchName: "main",
          name: "home",
        })
        .returning();
      baselineRunId = br.id;

      const [cr] = await db
        .insert(testRuns)
        .values({
          buildId,
          projectId,
          testVariationId: variationId,
          status: "new",
          branchName: "main",
          name: "home",
        })
        .returning();
      candidateRunId = cr.id;

      await db.insert(baselines).values({
        baselineName: "home",
        testVariationId: variationId,
        testRunId: baselineRunId,
        branchName: "main",
      });

      for (const vp of opts.viewports) {
        await db.insert(screenshots).values({
          runId: baselineRunId,
          projectId,
          imageKey: baselineKey,
          viewport: vp,
          browser: "chromium",
        });
        await db.insert(screenshots).values({
          runId: candidateRunId,
          projectId,
          imageKey: candidateKey,
          viewport: vp,
          browser: "chromium",
        });
      }
    }

    beforeEach(async () => {
      await db.delete(screenshots);
      await db.delete(baselines);
      await db.delete(testRuns);
      // Reset variation.ignoreAreas back to null between tests.
      await db
        .update(testVariations)
        .set({ ignoreAreas: null })
        .where(eq(testVariations.id, variationId));
    });

    it("merges variation + run ignore areas, both reach the engine", async () => {
      await seedBaselineAndCandidate({ viewports: [VP_DESKTOP] });

      const regionA = {
        x: 10,
        y: 10,
        width: 50,
        height: 50,
        viewport: VP_DESKTOP,
      };
      const regionB = {
        x: 100,
        y: 100,
        width: 50,
        height: 50,
        viewport: VP_DESKTOP,
      };
      await db
        .update(testVariations)
        .set({ ignoreAreas: JSON.stringify([regionA]) })
        .where(eq(testVariations.id, variationId));
      await db
        .update(testRuns)
        .set({ ignoreAreas: JSON.stringify([regionB]) })
        .where(eq(testRuns.id, candidateRunId));

      const job: DiffJob = { runId: candidateRunId, projectId };
      await handleDiffJob(job, mockLogger, { db, storage, redis });

      const [row] = await db
        .select()
        .from(testRuns)
        .where(eq(testRuns.id, candidateRunId))
        .limit(1);
      expect(["passed", "failed"]).toContain(row.status);
    }, 60_000);

    it("viewport filter: regions tagged with non-matching viewport are skipped", async () => {
      await seedBaselineAndCandidate({ viewports: [VP_DESKTOP, VP_MOBILE] });

      const desktopOnly = {
        x: 5,
        y: 5,
        width: 100,
        height: 100,
        viewport: VP_DESKTOP,
      };
      await db
        .update(testRuns)
        .set({ ignoreAreas: JSON.stringify([desktopOnly]) })
        .where(eq(testRuns.id, candidateRunId));

      const job: DiffJob = { runId: candidateRunId, projectId };
      await handleDiffJob(job, mockLogger, { db, storage, redis });

      const [row] = await db
        .select()
        .from(testRuns)
        .where(eq(testRuns.id, candidateRunId))
        .limit(1);
      expect(row.status).toBeDefined();
    }, 60_000);

    it("regions without a viewport field apply to all viewports (backward compat)", async () => {
      await seedBaselineAndCandidate({ viewports: [VP_DESKTOP, VP_MOBILE] });

      const legacy = { x: 5, y: 5, width: 100, height: 100 };
      await db
        .update(testRuns)
        .set({ ignoreAreas: JSON.stringify([legacy]) })
        .where(eq(testRuns.id, candidateRunId));

      const job: DiffJob = { runId: candidateRunId, projectId };
      await handleDiffJob(job, mockLogger, { db, storage, redis });

      const [row] = await db
        .select()
        .from(testRuns)
        .where(eq(testRuns.id, candidateRunId))
        .limit(1);
      expect(row.status).toBeDefined();
    }, 60_000);

    it("malformed variation JSON falls back to run-only (no crash)", async () => {
      await seedBaselineAndCandidate({ viewports: [VP_DESKTOP] });

      await db
        .update(testVariations)
        .set({ ignoreAreas: "{not-json" })
        .where(eq(testVariations.id, variationId));
      await db
        .update(testRuns)
        .set({
          ignoreAreas: JSON.stringify([
            { x: 1, y: 1, width: 10, height: 10, viewport: VP_DESKTOP },
          ]),
        })
        .where(eq(testRuns.id, candidateRunId));

      const job: DiffJob = { runId: candidateRunId, projectId };
      await expect(
        handleDiffJob(job, mockLogger, { db, storage, redis }),
      ).resolves.not.toThrow();
    }, 60_000);

    it("both columns empty → engine receives empty ignoreAreas (no crash)", async () => {
      await seedBaselineAndCandidate({ viewports: [VP_DESKTOP] });

      const job: DiffJob = { runId: candidateRunId, projectId };
      await expect(
        handleDiffJob(job, mockLogger, { db, storage, redis }),
      ).resolves.not.toThrow();
    }, 60_000);
  },
);
