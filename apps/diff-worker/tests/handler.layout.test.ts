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
import { Registry } from "prom-client";
import sharp from "sharp";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { createDiffMetrics, type DiffMetrics } from "../src/diff-metrics.js";
import { handleDiffJob } from "../src/handler.js";

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

// Tile-aligned (48px) so the L1 cluster extractor produces predictable
// bboxes: a 144×144 (3×3 tiles) square at a multiple-of-48 origin yields a
// cluster ≈ the square's bounds.
const IMG = 400;
const SQ = 144;
type Bbox = { x: number; y: number; width: number; height: number };

async function square(color: "red" | "blue", pos: number): Promise<Buffer> {
  const fg =
    color === "red"
      ? { r: 220, g: 30, b: 30, alpha: 1 }
      : { r: 30, g: 30, b: 220, alpha: 1 };
  return sharp({
    create: {
      width: IMG,
      height: IMG,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    },
  })
    .composite([
      {
        input: {
          create: { width: SQ, height: SQ, channels: 4, background: fg },
        },
        left: pos,
        top: pos,
      },
    ])
    .png()
    .toBuffer();
}

// div.box A contains the square at origin 96 (96..240). div.box B contains
// the square at origin 240 (240..384) — a *moved* element vs A.
const BOX_A: Bbox = { x: 80, y: 80, width: 180, height: 180 };
const BOX_B: Bbox = { x: 224, y: 224, width: 176, height: 176 };

const elementMapBytes = (elements: Record<string, Bbox>): Buffer =>
  Buffer.from(JSON.stringify({ v: 1, elements, capturedAt: 0 }));

async function layoutCount(reg: Registry, outcome: string): Promise<number> {
  const json = await reg.getMetricsAsJSON();
  const c = json.find((m) => m.name === "furan_layout_resolution_total");
  const series = (c?.values ?? []) as Array<{
    labels: { outcome?: string };
    value: number;
  }>;
  return series.find((s) => s.labels.outcome === outcome)?.value ?? 0;
}

desc("handleDiffJob — Layout match level (ADR-053, integration)", () => {
  let db: DB;
  let closeDb: () => Promise<void>;
  let storage: Storage;
  let redis: Redis;

  let projectId: string;
  let buildId: string;
  let variationId: string;
  let baselineRunId: string;
  let candidateRunId: string;

  const VP = "400x400";

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
    const [p] = await db
      .insert(projects)
      .values({ name: `dw-layout-${uniq}` })
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

  beforeEach(async () => {
    await db.delete(screenshots);
    await db.delete(baselines);
    await db.delete(testRuns);
  });

  async function seed(opts: {
    matchLevel: string;
    baselineImg: Buffer;
    candidateImg: Buffer;
    baselineMap: Record<string, Bbox> | null;
    candidateMap: Record<string, Bbox> | null;
  }): Promise<void> {
    const bImgKey = `${objectKey(opts.baselineImg)}-bl`;
    const cImgKey = `${objectKey(opts.candidateImg)}-cd`;
    await storage.put(bImgKey, opts.baselineImg, "image/png");
    await storage.put(cImgKey, opts.candidateImg, "image/png");

    let bMapKey: string | null = null;
    let cMapKey: string | null = null;
    if (opts.baselineMap) {
      const bytes = elementMapBytes(opts.baselineMap);
      bMapKey = `${objectKey(bytes)}-blmap`;
      await storage.put(bMapKey, bytes, "application/json");
    }
    if (opts.candidateMap) {
      const bytes = elementMapBytes(opts.candidateMap);
      cMapKey = `${objectKey(bytes)}-cdmap`;
      await storage.put(cMapKey, bytes, "application/json");
    }

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

    await db.insert(screenshots).values({
      runId: baselineRunId,
      projectId,
      testVariationId: variationId,
      name: "home",
      imageKey: bImgKey,
      viewport: VP,
      browser: "chromium",
      matchLevel: opts.matchLevel,
      elementMapKey: bMapKey,
    });
    await db.insert(screenshots).values({
      runId: candidateRunId,
      projectId,
      testVariationId: variationId,
      name: "home",
      imageKey: cImgKey,
      viewport: VP,
      browser: "chromium",
      matchLevel: opts.matchLevel,
      elementMapKey: cMapKey,
    });
  }

  const runRow = async () =>
    (
      await db
        .select()
        .from(testRuns)
        .where(eq(testRuns.id, candidateRunId))
        .limit(1)
    )[0];
  const regionsFor = async () =>
    db.select().from(diffRegions).where(eq(diffRegions.runId, candidateRunId));

  it("recolor inside a geometrically-stable element is suppressed → passed", async () => {
    await seed({
      matchLevel: "Layout",
      baselineImg: await square("red", 96),
      candidateImg: await square("blue", 96),
      baselineMap: { "div.box": BOX_A },
      candidateMap: { "div.box": BOX_A },
    });
    const reg = new Registry();
    const metrics: DiffMetrics = createDiffMetrics(reg);

    await handleDiffJob(
      { runId: candidateRunId, projectId } as DiffJob,
      mockLogger,
      {
        db,
        storage,
        redis,
        metrics,
      },
    );

    expect((await runRow()).status).toBe("passed");
    const regions = await regionsFor();
    expect(regions.some((r) => r.source === "layout_suppressed")).toBe(true);
    expect(regions.some((r) => r.source === "layout_kept")).toBe(false);
    expect(await layoutCount(reg, "stable_element")).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it("a moved element is kept → unresolved", async () => {
    await seed({
      matchLevel: "Layout",
      baselineImg: await square("red", 96),
      candidateImg: await square("red", 240),
      baselineMap: { "div.box": BOX_A },
      candidateMap: { "div.box": BOX_B },
    });

    await handleDiffJob(
      { runId: candidateRunId, projectId } as DiffJob,
      mockLogger,
      {
        db,
        storage,
        redis,
      },
    );

    expect((await runRow()).status).toBe("unresolved");
    const regions = await regionsFor();
    expect(regions.some((r) => r.source === "layout_kept")).toBe(true);
  }, 60_000);

  it("a missing element map degrades the checkpoint to Strict (recolor fails)", async () => {
    await seed({
      matchLevel: "Layout",
      baselineImg: await square("red", 96),
      candidateImg: await square("blue", 96),
      baselineMap: null,
      candidateMap: null,
    });

    await handleDiffJob(
      { runId: candidateRunId, projectId } as DiffJob,
      mockLogger,
      {
        db,
        storage,
        redis,
      },
    );

    expect((await runRow()).status).toBe("unresolved");
    const regions = await regionsFor();
    // Degrade leaves l1_pixel regions (no re-tag) but prefixes the description.
    expect(regions.some((r) => r.source === "layout_suppressed")).toBe(false);
    expect(
      regions.some((r) => r.description.startsWith("[Layout→Strict")),
    ).toBe(true);
  }, 60_000);

  it("Strict checkpoint: recolor fails and writes no layout_* rows", async () => {
    await seed({
      matchLevel: "Strict",
      baselineImg: await square("red", 96),
      candidateImg: await square("blue", 96),
      baselineMap: { "div.box": BOX_A },
      candidateMap: { "div.box": BOX_A },
    });

    await handleDiffJob(
      { runId: candidateRunId, projectId } as DiffJob,
      mockLogger,
      {
        db,
        storage,
        redis,
      },
    );

    expect((await runRow()).status).toBe("unresolved");
    const regions = await regionsFor();
    expect(
      regions.some(
        (r) => r.source === "layout_suppressed" || r.source === "layout_kept",
      ),
    ).toBe(false);
  }, 60_000);
});
