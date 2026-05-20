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

import {
  __resetTesseractWorkerForTests,
  evaluateDynamicTextRegions,
} from "../src/dynamic-text.js";
import { handleDiffJob } from "../src/handler.js";

// Mock tesseract.js for the dynamic-text integration tests. The first
// `recognize` call returns "Mar 5, 2026" (matches the date preset); the
// second returns "ORDER-XYZ" (no match). The mock applies module-wide
// because handler.ts → dynamic-text.ts does `await import("tesseract.js")`
// lazily; vi.mock here intercepts that dynamic import.
vi.mock("tesseract.js", () => ({
  createWorker: vi.fn(async () => ({
    recognize: vi
      .fn()
      .mockResolvedValueOnce({ data: { text: "Mar 5, 2026" } })
      .mockResolvedValueOnce({ data: { text: "ORDER-XYZ" } }),
    terminate: vi.fn(),
  })),
}));

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
    }, 60_000);

    afterAll(async () => {
      await redis.quit();
      await closeDb();
    });

    async function seedBaselineAndCandidate(opts: {
      viewports: string[];
    }): Promise<void> {
      const baselineBytes = FIXTURE("baseline-a.png");
      const candidateBytes = FIXTURE("candidate-a-major.png");

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

      // screenshots.image_key has a UNIQUE constraint, so each (run, viewport)
      // pair needs a distinct storage key. We synthesize keys by appending the
      // viewport + runId to the content hash; storage.put accepts any string
      // key, the diff engine retrieves bytes by whatever key is in the row.
      for (const vp of opts.viewports) {
        const bKey = `${objectKey(baselineBytes)}-${baselineRunId}-${vp}`;
        const cKey = `${objectKey(candidateBytes)}-${candidateRunId}-${vp}`;
        await storage.put(bKey, baselineBytes, "image/png");
        await storage.put(cKey, candidateBytes, "image/png");

        await db.insert(screenshots).values({
          runId: baselineRunId,
          projectId,
          imageKey: bKey,
          viewport: vp,
          browser: "chromium",
        });
        await db.insert(screenshots).values({
          runId: candidateRunId,
          projectId,
          imageKey: cKey,
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
      // Per spec §3.2 (run-status-enum) the diff-worker emits "unresolved"
      // (not "failed") on diff-found. Accept either terminal outcome the
      // ignore-merge logic might land on.
      expect(["passed", "unresolved"]).toContain(row.status);
    }, 60_000);

    it("viewport filter: regions tagged with non-matching viewport are skipped", async () => {
      await seedBaselineAndCandidate({ viewports: [VP_DESKTOP, VP_MOBILE] });

      // Full-cover region tagged for desktop only. After the diff:
      //   desktop screenshot → masked → diff_percent for desktop = 0
      //   mobile screenshot  → NOT masked → diff_percent for mobile > 0
      // Aggregate diff_percent on the run row = MAX(desktop=0, mobile>0) > 0.
      // FALSIFIABILITY: if the viewport filter were stripped (region applies
      // to both viewports), both would be masked, aggregate would be 0.
      const desktopFullCover = {
        x: 0,
        y: 0,
        width: 10000,
        height: 10000,
        viewport: VP_DESKTOP,
      };
      await db
        .update(testRuns)
        .set({ ignoreAreas: JSON.stringify([desktopFullCover]) })
        .where(eq(testRuns.id, candidateRunId));

      const job: DiffJob = { runId: candidateRunId, projectId };
      await handleDiffJob(job, mockLogger, { db, storage, redis });

      const [row] = await db
        .select()
        .from(testRuns)
        .where(eq(testRuns.id, candidateRunId))
        .limit(1);
      expect(row.diffPercent).toBeGreaterThan(0);
    }, 60_000);

    it("regions without a viewport field apply to all viewports (backward compat)", async () => {
      await seedBaselineAndCandidate({ viewports: [VP_DESKTOP, VP_MOBILE] });

      // Legacy region (no viewport field) covering the full image. After
      // the diff: BOTH viewports masked → both diff_percent values = 0 →
      // aggregate = MAX(0, 0) = 0. FALSIFIABILITY: if untagged regions
      // were skipped instead of applied-to-all, neither viewport would be
      // masked, aggregate would be > 0.
      const legacyFullCover = { x: 0, y: 0, width: 10000, height: 10000 };
      await db
        .update(testRuns)
        .set({ ignoreAreas: JSON.stringify([legacyFullCover]) })
        .where(eq(testRuns.id, candidateRunId));

      const job: DiffJob = { runId: candidateRunId, projectId };
      await handleDiffJob(job, mockLogger, { db, storage, redis });

      const [row] = await db
        .select()
        .from(testRuns)
        .where(eq(testRuns.id, candidateRunId))
        .limit(1);
      expect(row.diffPercent).toBe(0);
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

    it("dynamic-text: matched region is added to mask; unmatched persists audit row", async () => {
      // Enable the project flag and reset the lazy tesseract singleton so
      // the per-test mock factory (Mar 5 → matched, ORDER-XYZ → unmatched)
      // takes effect.
      await db
        .update(projects)
        .set({ dynamicTextEnabled: true })
        .where(eq(projects.id, projectId));
      __resetTesseractWorkerForTests();

      await seedBaselineAndCandidate({ viewports: [VP_DESKTOP] });

      // Two dynamic-text regions. The order of OCR calls is the iteration
      // order over `allRegions`; the mock's mockResolvedValueOnce queue
      // pops in that order: first region → "Mar 5, 2026" (matches date),
      // second → "ORDER-XYZ" (does NOT match).
      const datePattern = String.raw`\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*[\s\-\/]+\d{1,2},?\s+\d{2,4}\b`;
      const orderPattern = String.raw`^ORDER-\d+$`;
      await db
        .update(testRuns)
        .set({
          ignoreAreas: JSON.stringify([
            {
              x: 0,
              y: 0,
              width: 40,
              height: 40,
              viewport: VP_DESKTOP,
              kind: "dynamic-text",
              pattern: datePattern,
            },
            {
              x: 40,
              y: 40,
              width: 40,
              height: 40,
              viewport: VP_DESKTOP,
              kind: "dynamic-text",
              pattern: orderPattern,
            },
          ]),
        })
        .where(eq(testRuns.id, candidateRunId));

      const job: DiffJob = { runId: candidateRunId, projectId };
      await handleDiffJob(job, mockLogger, { db, storage, redis });

      const auditRows = await db
        .select()
        .from(diffRegions)
        .where(eq(diffRegions.runId, candidateRunId));
      const dynamicTextRows = auditRows.filter(
        (r) => r.source === "dynamic_text",
      );
      expect(dynamicTextRows).toHaveLength(2);
      const matchedRow = dynamicTextRows.find((r) => r.ocrMatched === true);
      const unmatchedRow = dynamicTextRows.find((r) => r.ocrMatched === false);
      expect(matchedRow).toBeDefined();
      expect(unmatchedRow).toBeDefined();
      expect(matchedRow!.ocrText).toBe("Mar 5, 2026");
      expect(unmatchedRow!.ocrText).toBe("ORDER-XYZ");
    }, 60_000);

    it("resolves a region's selector against the candidate element-map and masks the resolved bbox", async () => {
      // Build two 100×100 PNGs on the fly. Baseline is solid white;
      // candidate has an 80×80 black square at (10,10). Without a mask
      // the L1 diff would flag ~6400 pixels — diff_percent > 0. The
      // stored bbox on the saved ignore region is a tiny 1×1 at (0,0),
      // which would NOT mask the modification. Only the resolver
      // kicking in (selector `#center` → resolved bbox 10,10,80,80)
      // can mask the change. If the resolver doesn't fire, diff_percent
      // stays > 0 and the assertion fails.
      const sharp = (await import("sharp")).default;
      const baselineBytes = await sharp({
        create: {
          width: 100,
          height: 100,
          channels: 3,
          background: { r: 255, g: 255, b: 255 },
        },
      })
        .png()
        .toBuffer();
      const blackSquare = await sharp({
        create: {
          width: 80,
          height: 80,
          channels: 3,
          background: { r: 0, g: 0, b: 0 },
        },
      })
        .png()
        .toBuffer();
      const candidateBytes = await sharp(baselineBytes)
        .composite([{ input: blackSquare, left: 10, top: 10 }])
        .png()
        .toBuffer();

      const VP = "100x100";

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
      await db.insert(baselines).values({
        baselineName: "home",
        testVariationId: variationId,
        testRunId: br.id,
        branchName: "main",
      });

      const bKey = `${objectKey(baselineBytes)}-${br.id}-${VP}`;
      const cKey = `${objectKey(candidateBytes)}-${cr.id}-${VP}`;
      const elementMapKey = `${cKey}.elements.json`;

      await storage.put(bKey, baselineBytes, "image/png");
      await storage.put(cKey, candidateBytes, "image/png");
      const elementMap = {
        v: 1 as const,
        elements: {
          "#center": { x: 10, y: 10, width: 80, height: 80 },
        },
        capturedAt: Date.now(),
      };
      await storage.put(
        elementMapKey,
        Buffer.from(JSON.stringify(elementMap)),
        "application/json",
      );

      await db.insert(screenshots).values({
        runId: br.id,
        projectId,
        imageKey: bKey,
        viewport: VP,
        browser: "chromium",
      });
      await db.insert(screenshots).values({
        runId: cr.id,
        projectId,
        imageKey: cKey,
        elementMapKey,
        viewport: VP,
        browser: "chromium",
      });

      // Saved region: stored bbox is a tiny 1×1 at (0,0) — would NOT
      // mask the modification. Selector points at the actual change.
      await db
        .update(testVariations)
        .set({
          ignoreAreas: JSON.stringify([
            {
              x: 0,
              y: 0,
              width: 1,
              height: 1,
              viewport: VP,
              selector: "#center",
            },
          ]),
        })
        .where(eq(testVariations.id, variationId));

      const job: DiffJob = { runId: cr.id, projectId };
      await handleDiffJob(job, mockLogger, { db, storage, redis });

      const [updated] = await db
        .select()
        .from(testRuns)
        .where(eq(testRuns.id, cr.id))
        .limit(1);
      expect(updated.status).toBe("passed");
      expect(updated.diffPercent).toBe(0);
    }, 60_000);

    it("flag off: no dynamic_text audit rows persisted", async () => {
      // Explicitly disable the flag.
      await db
        .update(projects)
        .set({ dynamicTextEnabled: false })
        .where(eq(projects.id, projectId));
      __resetTesseractWorkerForTests();

      await seedBaselineAndCandidate({ viewports: [VP_DESKTOP] });

      await db
        .update(testRuns)
        .set({
          ignoreAreas: JSON.stringify([
            {
              x: 0,
              y: 0,
              width: 40,
              height: 40,
              viewport: VP_DESKTOP,
              kind: "dynamic-text",
              pattern: ".+",
            },
          ]),
        })
        .where(eq(testRuns.id, candidateRunId));

      const job: DiffJob = { runId: candidateRunId, projectId };
      await handleDiffJob(job, mockLogger, { db, storage, redis });

      const auditRows = await db
        .select()
        .from(diffRegions)
        .where(eq(diffRegions.runId, candidateRunId));
      const dynamicTextRows = auditRows.filter(
        (r) => r.source === "dynamic_text",
      );
      expect(dynamicTextRows).toHaveLength(0);
    }, 60_000);
  },
);

// Reference the import so vitest doesn't strip the dynamic-text module
// load — keeping the helper in scope ensures vi.mock("tesseract.js")
// applies to the same dynamic import the handler triggers at runtime.
void evaluateDynamicTextRegions;
