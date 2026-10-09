import { randomUUID } from "node:crypto";

import {
  asc,
  baselines,
  builds,
  checkpointDecisions,
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
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createDiffMetrics, type DiffMetrics } from "../src/diff-metrics.js";
import { handleDiffJob } from "../src/handler.js";

/**
 * Spec §3 (review flow, slice 1): every checkpoint of a run is diffed against
 * ITS OWN variation's baseline, paired by (baseline run, variation), and gets
 * its own `screenshots.verdict`. The run status is the rollup of those
 * verdicts and any active decisions (`recomputeRunStatus`).
 *
 * The regression this guards: the worker used to resolve ONE baseline, from
 * the first screenshot's variation, and pair candidates with that baseline
 * run's screenshots by viewport only, so several checkpoints at one viewport
 * (home / cart / checkout at 400x400) were all diffed against one image.
 */

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

// Same tile-aligned helper as handler.layout.test.ts: a 400x400 white PNG with
// a 144px (3x3 tiles of 48px) square at (pos, pos), so a change produces a real
// L1 cluster and therefore real `diff_regions` rows.
const IMG = 400;
const SQ = 144;
const VP = "400x400";

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

async function counterValue(reg: Registry, name: string): Promise<number> {
  const json = await reg.getMetricsAsJSON();
  const metric = json.find((m) => m.name === name);
  const series = (metric?.values ?? []) as Array<{ value: number }>;
  return series.reduce((sum, s) => sum + s.value, 0);
}

interface CheckpointSpec {
  name: string;
  /** Baseline image; `null` = the checkpoint has never been baselined. */
  baseline: Buffer | null;
  candidate: Buffer;
  /** Store the candidate under the baseline's object key (ADR-032 hash match). */
  sameKey?: boolean;
  /** Ignore regions stored on this checkpoint's variation. */
  ignoreRegions?: unknown[];
}

interface Scenario {
  projectId: string;
  buildId: string;
  candidateRunId: string;
  /** Candidate screenshot id by checkpoint name. */
  shotId: Record<string, string>;
  variationId: Record<string, string>;
  /** Baseline screenshot id by checkpoint name (baselined checkpoints only). */
  baselineShotId: Record<string, string>;
}

desc("handleDiffJob — one baseline per checkpoint (integration)", () => {
  let db: DB;
  let closeDb: () => Promise<void>;
  let storage: Storage;
  let redis: Redis;
  let userId: string;
  const projectIds: string[] = [];

  beforeAll(async () => {
    const created = createDb();
    db = created.db;
    closeDb = created.close;
    storage = createStorage();
    redis = new Redis(process.env.REDIS_URL!);

    const [u] = await db
      .insert(users)
      .values({
        email: `dw-mc-${Date.now()}@x.test`,
        hashedPassword: "x",
        firstName: "dw",
        lastName: "multi-checkpoint",
        role: "admin",
      })
      .returning();
    userId = u!.id;
  }, 60_000);

  afterAll(async () => {
    for (const id of projectIds) {
      try {
        await db.delete(projects).where(eq(projects.id, id));
      } catch {
        /* best-effort cleanup */
      }
    }
    await redis.quit();
    await closeDb();
  });

  /**
   * One project per scenario. Each checkpoint gets its own variation; each
   * baselined checkpoint gets its own baseline run (or one shared run when
   * `sharedBaselineRun`) holding a screenshot of that variation, plus a
   * `baselines` row. The candidate run holds one screenshot per checkpoint,
   * all at the same viewport, in `checkpoints` order.
   */
  async function seed(opts: {
    checkpoints: CheckpointSpec[];
    autoApproveFeature?: boolean;
    sharedBaselineRun?: boolean;
  }): Promise<Scenario> {
    const uniq = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
    const [p] = await db
      .insert(projects)
      .values({
        name: `dw-mc-${uniq}`,
        mainBranchName: "main",
        diffThreshold: 0.001,
        autoApproveFeature: opts.autoApproveFeature ?? false,
      })
      .returning();
    const projectId = p!.id;
    projectIds.push(projectId);
    const [b] = await db
      .insert(builds)
      .values({ projectId, userId, isRunning: false })
      .returning();
    const buildId = b!.id;

    const variationId: Record<string, string> = {};
    for (const cp of opts.checkpoints) {
      const [v] = await db
        .insert(testVariations)
        .values({
          name: cp.name,
          projectId,
          branchName: "main",
          browser: "chromium",
          viewport: VP,
          ignoreRegions: cp.ignoreRegions ?? null,
        })
        .returning();
      variationId[cp.name] = v!.id;
    }

    const baselineKey: Record<string, string> = {};
    const baselineShotId: Record<string, string> = {};
    let sharedRunId: string | null = null;
    for (const cp of opts.checkpoints) {
      if (!cp.baseline) continue;
      let runId = sharedRunId;
      if (runId === null) {
        const [br] = await db
          .insert(testRuns)
          .values({
            name: opts.sharedBaselineRun ? "baseline" : `baseline-${cp.name}`,
            projectId,
            buildId,
            branchName: "main",
            status: "passed",
          })
          .returning();
        runId = br!.id;
        if (opts.sharedBaselineRun) sharedRunId = runId;
      }
      const key = `${objectKey(cp.baseline)}-${uniq}-${cp.name}-bl`;
      await storage.put(key, cp.baseline, "image/png");
      baselineKey[cp.name] = key;
      const [bs] = await db
        .insert(screenshots)
        .values({
          runId,
          projectId,
          testVariationId: variationId[cp.name]!,
          name: cp.name,
          imageKey: key,
          viewport: VP,
          browser: "chromium",
        })
        .returning();
      baselineShotId[cp.name] = bs!.id;
      await db.insert(baselines).values({
        baselineName: key,
        testVariationId: variationId[cp.name]!,
        testRunId: runId,
        branchName: "main",
        userId,
      });
    }

    const [cr] = await db
      .insert(testRuns)
      .values({
        name: "candidate",
        projectId,
        buildId,
        branchName: "main",
        status: "running",
      })
      .returning();
    const candidateRunId = cr!.id;

    const shotId: Record<string, string> = {};
    for (const cp of opts.checkpoints) {
      let key = `${objectKey(cp.candidate)}-${uniq}-${cp.name}-cd`;
      if (cp.sameKey) {
        key = baselineKey[cp.name]!;
      } else {
        await storage.put(key, cp.candidate, "image/png");
      }
      const [cs] = await db
        .insert(screenshots)
        .values({
          runId: candidateRunId,
          projectId,
          testVariationId: variationId[cp.name]!,
          name: cp.name,
          imageKey: key,
          viewport: VP,
          browser: "chromium",
        })
        .returning();
      shotId[cp.name] = cs!.id;
    }

    return {
      projectId,
      buildId,
      candidateRunId,
      shotId,
      variationId,
      baselineShotId,
    };
  }

  async function diff(s: Scenario, metrics?: DiffMetrics): Promise<void> {
    await handleDiffJob(
      { runId: s.candidateRunId, projectId: s.projectId } as DiffJob,
      mockLogger,
      { db, storage, redis, ...(metrics ? { metrics } : {}) },
    );
  }

  async function verdicts(
    s: Scenario,
    names: string[],
  ): Promise<Array<string | null>> {
    const rows = await db
      .select({ id: screenshots.id, verdict: screenshots.verdict })
      .from(screenshots)
      .where(eq(screenshots.runId, s.candidateRunId));
    const byId = new Map(rows.map((r) => [r.id, r.verdict]));
    return names.map((n) => byId.get(s.shotId[n]!) ?? null);
  }

  async function runRow(s: Scenario) {
    const [row] = await db
      .select()
      .from(testRuns)
      .where(eq(testRuns.id, s.candidateRunId))
      .limit(1);
    return row!;
  }

  const red0 = () => square("red", 0);
  const blue0 = () => square("blue", 0);
  const red144 = () => square("red", 144);

  /** home changed (red@0 → blue@0); cart and checkout unchanged. */
  async function threeCheckpoints(): Promise<CheckpointSpec[]> {
    return [
      { name: "home", baseline: await red0(), candidate: await blue0() },
      { name: "cart", baseline: await blue0(), candidate: await blue0() },
      {
        name: "checkout",
        baseline: await red144(),
        candidate: await red144(),
      },
    ];
  }

  it("diffs each checkpoint against its own baseline", async () => {
    const s = await seed({ checkpoints: await threeCheckpoints() });

    await diff(s);

    expect(await verdicts(s, ["home", "cart", "checkout"])).toEqual([
      "unresolved",
      "passed",
      "passed",
    ]);
    const regions = await db
      .select({ screenshotId: diffRegions.screenshotId })
      .from(diffRegions)
      .where(eq(diffRegions.runId, s.candidateRunId));
    expect(regions.length).toBeGreaterThan(0);
    expect(new Set(regions.map((r) => r.screenshotId))).toEqual(
      new Set([s.shotId.home]),
    );
    const run = await runRow(s);
    expect(run.status).toBe("unresolved");
    expect(run.baselineSource).toBe("this_branch");
  }, 60_000);

  it("pairs by variation inside a baseline run that holds every checkpoint", async () => {
    // The realistic shape: the previous run was approved as a whole, so all
    // three baselines point at ONE run holding three same-viewport
    // screenshots. Pairing by run (or viewport) alone picks the wrong image.
    const s = await seed({
      checkpoints: await threeCheckpoints(),
      sharedBaselineRun: true,
    });

    await diff(s);

    expect(await verdicts(s, ["home", "cart", "checkout"])).toEqual([
      "unresolved",
      "passed",
      "passed",
    ]);
    expect((await runRow(s)).status).toBe("unresolved");
  }, 60_000);

  it("new checkpoint in a baselined run gets verdict new", async () => {
    const s = await seed({
      checkpoints: [
        ...(await threeCheckpoints()),
        { name: "search", baseline: null, candidate: await red0() },
      ],
    });

    await diff(s);

    expect(await verdicts(s, ["home", "cart", "checkout", "search"])).toEqual([
      "unresolved",
      "passed",
      "passed",
      "new",
    ]);
    expect((await runRow(s)).status).toBe("unresolved");
  }, 60_000);

  it("new checkpoint with every other checkpoint passing makes the run new", async () => {
    const s = await seed({
      checkpoints: [
        { name: "home", baseline: await red0(), candidate: await red0() },
        { name: "search", baseline: null, candidate: await blue0() },
      ],
    });

    await diff(s);

    expect(await verdicts(s, ["home", "search"])).toEqual(["passed", "new"]);
    const run = await runRow(s);
    expect(run.status).toBe("new");
    // No baselines row was auto-seeded (autoApproveFeature off), so the run
    // owns no baseline and is not "promoted".
    expect(run.merge).toBe(false);
  }, 60_000);

  it("per-checkpoint hash auto-approve records a baseline for that variation only", async () => {
    const s = await seed({
      autoApproveFeature: true,
      checkpoints: [
        { name: "home", baseline: await red0(), candidate: await blue0() },
        {
          name: "cart",
          baseline: await blue0(),
          candidate: await blue0(),
          sameKey: true,
        },
        // Identical pixels but a different object key: not a hash match, so
        // it is diffed (0%) and passes without becoming a baseline.
        {
          name: "checkout",
          baseline: await red144(),
          candidate: await red144(),
        },
      ],
    });

    await diff(s);

    expect(await verdicts(s, ["home", "cart", "checkout"])).toEqual([
      "unresolved",
      "passed",
      "passed",
    ]);
    const seeded = await db
      .select()
      .from(baselines)
      .where(eq(baselines.testRunId, s.candidateRunId));
    expect(seeded).toHaveLength(1);
    expect(seeded[0]!.testVariationId).toBe(s.variationId.cart);
    expect(seeded[0]!.userId).toBeNull();
    const run = await runRow(s);
    expect(run.status).toBe("unresolved");
    expect(run.merge).toBe(true);
  }, 60_000);

  it("records auto-approved baselines in ascending variation-id order, whatever the capture order", async () => {
    // recordBaseline updates a test_variations row per call, inside one
    // transaction. Two jobs whose runs share variations deadlock if they take
    // those row locks in different orders, so the order is fixed by variation
    // id, not by capture order. Each call stamps clock_timestamp(), so
    // baselines.created_at shows the order the writes happened in.
    const names = ["a", "b", "c", "d"];
    const checkpoints: CheckpointSpec[] = [];
    for (const name of names) {
      const img = name < "c" ? await red0() : await blue0();
      checkpoints.push({
        name,
        baseline: img,
        candidate: img,
        sameKey: true,
      });
    }
    const s = await seed({ autoApproveFeature: true, checkpoints });

    // Capture order = DESCENDING variation id (the worst case for a handler
    // that writes in capture order). The handler reads screenshots by
    // (created_at, id), so spread created_at to make that order explicit.
    const byVariationDesc = names
      .map((n) => ({ shot: s.shotId[n]!, variation: s.variationId[n]! }))
      .sort((x, y) => (x.variation < y.variation ? 1 : -1));
    const t0 = Date.now();
    for (const [i, c] of byVariationDesc.entries()) {
      await db
        .update(screenshots)
        .set({ createdAt: new Date(t0 + i * 1000) })
        .where(eq(screenshots.id, c.shot));
    }

    await diff(s);

    const written = await db
      .select({
        variation: baselines.testVariationId,
        createdAt: baselines.createdAt,
      })
      .from(baselines)
      .where(eq(baselines.testRunId, s.candidateRunId))
      .orderBy(asc(baselines.createdAt));
    const expected = names.map((n) => s.variationId[n]!).sort();
    expect(written.map((w) => w.variation)).toEqual(expected);
  }, 60_000);

  it("per-checkpoint past-baseline auto-approve pairs each past baseline by variation", async () => {
    // cart's current baseline is red@0. An OLDER baseline run holds cart at
    // red@144 next to another checkpoint (home, inserted first). The candidate
    // cart is red@144 again, so it matches cart's past baseline, but only when
    // that run's screenshot is paired by cart's variation, not by run alone.
    const s = await seed({
      autoApproveFeature: true,
      checkpoints: [
        { name: "home", baseline: await red0(), candidate: await red0() },
        { name: "cart", baseline: await red0(), candidate: await red144() },
      ],
    });
    const [oldRun] = await db
      .insert(testRuns)
      .values({
        name: "baseline-old",
        projectId: s.projectId,
        buildId: s.buildId,
        branchName: "main",
        status: "passed",
      })
      .returning();
    const olderShots: Array<[string, Buffer]> = [
      ["home", await blue0()],
      ["cart", await red144()],
    ];
    for (const [name, img] of olderShots) {
      const key = `${objectKey(img)}-${oldRun!.id}-${name}-old`;
      await storage.put(key, img, "image/png");
      await db.insert(screenshots).values({
        runId: oldRun!.id,
        projectId: s.projectId,
        testVariationId: s.variationId[name]!,
        name,
        imageKey: key,
        viewport: VP,
        browser: "chromium",
      });
    }
    await db.insert(baselines).values({
      baselineName: "cart-old",
      testVariationId: s.variationId.cart!,
      testRunId: oldRun!.id,
      branchName: "main",
      userId,
      createdAt: new Date(Date.now() - 60 * 60_000),
    });

    await diff(s);

    expect(await verdicts(s, ["home", "cart"])).toEqual(["passed", "passed"]);
    const seeded = await db
      .select()
      .from(baselines)
      .where(eq(baselines.testRunId, s.candidateRunId));
    expect(seeded).toHaveLength(1);
    expect(seeded[0]!.testVariationId).toBe(s.variationId.cart);
    expect(seeded[0]!.userId).toBeNull();
    expect((await runRow(s)).status).toBe("passed");
  }, 60_000);

  it("applies each checkpoint's own variation ignore regions", async () => {
    // home and cart change in the same place (the square at 0,0). The region
    // lives on home's variation only, so it masks home's change and not cart's.
    const s = await seed({
      checkpoints: [
        {
          name: "home",
          baseline: await red0(),
          candidate: await blue0(),
          ignoreRegions: [{ x: 0, y: 0, width: 200, height: 200 }],
        },
        { name: "cart", baseline: await blue0(), candidate: await red0() },
      ],
    });

    await diff(s);

    expect(await verdicts(s, ["home", "cart"])).toEqual([
      "passed",
      "unresolved",
    ]);
    expect((await runRow(s)).status).toBe("unresolved");
  }, 60_000);

  it("a missing baseline pair degrades the checkpoint to new and counts it", async () => {
    const s = await seed({ checkpoints: await threeCheckpoints() });
    await db
      .delete(screenshots)
      .where(eq(screenshots.id, s.baselineShotId.cart!));
    const reg = new Registry();
    const metrics = createDiffMetrics(reg);
    vi.mocked(mockLogger.warn).mockClear();

    await diff(s, metrics);

    expect(await verdicts(s, ["home", "cart", "checkout"])).toEqual([
      "unresolved",
      "new",
      "passed",
    ]);
    expect(
      await counterValue(reg, "furan_diff_baseline_pair_missing_total"),
    ).toBe(1);
    const warn = vi
      .mocked(mockLogger.warn)
      .mock.calls.find((c) => c[1] === "diff_baseline_pair_missing");
    expect(warn?.[0]).toMatchObject({
      project_id: s.projectId,
      run_id: s.candidateRunId,
      screenshot_id: s.shotId.cart,
      variation_id: s.variationId.cart,
    });
  }, 60_000);

  /**
   * A candidate on a FEATURE branch with its own variation (same name /
   * browser / viewport / os / device as main's, `branchName` = the feature
   * branch). Only the MAIN sibling variation has a baseline, so resolution goes
   * through the default-branch tier and `baselineVariationId` (the sibling) is
   * not the candidate's `testVariationId`.
   */
  async function seedFeatureBranchCandidate(
    baseline: Buffer,
    candidate: Buffer,
  ): Promise<Scenario & { mainVariationId: string }> {
    const uniq = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
    const [p] = await db
      .insert(projects)
      .values({
        name: `dw-mc-sib-${uniq}`,
        mainBranchName: "main",
        diffThreshold: 0.001,
      })
      .returning();
    const projectId = p!.id;
    projectIds.push(projectId);
    const [b] = await db
      .insert(builds)
      .values({ projectId, userId, isRunning: false })
      .returning();
    const buildId = b!.id;

    const variationFor = async (branchName: string): Promise<string> => {
      const [v] = await db
        .insert(testVariations)
        .values({
          name: "home",
          projectId,
          branchName,
          browser: "chromium",
          viewport: VP,
        })
        .returning();
      return v!.id;
    };
    const mainVariationId = await variationFor("main");
    const featureVariationId = await variationFor("feature/sibling");
    expect(featureVariationId).not.toBe(mainVariationId);

    // main: an approved run holding the baseline image, plus its baselines row.
    const [br] = await db
      .insert(testRuns)
      .values({
        name: "baseline",
        projectId,
        buildId,
        branchName: "main",
        status: "passed",
      })
      .returning();
    const baselineKey = `${objectKey(baseline)}-${uniq}-bl`;
    await storage.put(baselineKey, baseline, "image/png");
    const [bs] = await db
      .insert(screenshots)
      .values({
        runId: br!.id,
        projectId,
        testVariationId: mainVariationId,
        name: "home",
        imageKey: baselineKey,
        viewport: VP,
        browser: "chromium",
      })
      .returning();
    await db.insert(baselines).values({
      baselineName: baselineKey,
      testVariationId: mainVariationId,
      testRunId: br!.id,
      branchName: "main",
      userId,
    });

    // feature: the candidate run, one screenshot of the FEATURE variation.
    const [cr] = await db
      .insert(testRuns)
      .values({
        name: "candidate",
        projectId,
        buildId,
        branchName: "feature/sibling",
        status: "running",
      })
      .returning();
    const candidateKey = `${objectKey(candidate)}-${uniq}-cd`;
    await storage.put(candidateKey, candidate, "image/png");
    const [cs] = await db
      .insert(screenshots)
      .values({
        runId: cr!.id,
        projectId,
        testVariationId: featureVariationId,
        name: "home",
        imageKey: candidateKey,
        viewport: VP,
        browser: "chromium",
      })
      .returning();

    return {
      projectId,
      buildId,
      candidateRunId: cr!.id,
      shotId: { home: cs!.id },
      variationId: { home: featureVariationId },
      baselineShotId: { home: bs!.id },
      mainVariationId,
    };
  }

  it("a feature-branch checkpoint is diffed against its main sibling's image (changed)", async () => {
    // Pairing on the candidate's own variation would find nothing in main's
    // baseline run (the screenshot lives under the sibling), degrade to `new`
    // and count a missing pair. Pairing on `baselineVariationId` diffs it.
    const s = await seedFeatureBranchCandidate(await red0(), await blue0());
    const reg = new Registry();

    await diff(s, createDiffMetrics(reg));

    expect(await verdicts(s, ["home"])).toEqual(["unresolved"]);
    const run = await runRow(s);
    expect(run.status).toBe("unresolved");
    expect(run.baselineSource).toBe("default_branch");
    expect(run.diffPercent).toBeGreaterThan(0);
    expect(
      await counterValue(reg, "furan_diff_baseline_pair_missing_total"),
    ).toBe(0);
  }, 60_000);

  it("a feature-branch checkpoint is diffed against its main sibling's image (identical)", async () => {
    const s = await seedFeatureBranchCandidate(await red0(), await red0());
    const reg = new Registry();

    await diff(s, createDiffMetrics(reg));

    expect(await verdicts(s, ["home"])).toEqual(["passed"]);
    const run = await runRow(s);
    expect(run.status).toBe("passed");
    expect(run.baselineSource).toBe("default_branch");
    expect(run.diffPercent).toBe(0);
    expect(
      await counterValue(reg, "furan_diff_baseline_pair_missing_total"),
    ).toBe(0);
  }, 60_000);

  it("an active decision survives a re-diff", async () => {
    const s = await seed({ checkpoints: await threeCheckpoints() });
    await diff(s);
    expect((await runRow(s)).status).toBe("unresolved");

    await db.insert(checkpointDecisions).values({
      projectId: s.projectId,
      runId: s.candidateRunId,
      screenshotId: s.shotId.home!,
      actionId: randomUUID(),
      decision: "approved",
      actorId: userId,
      source: "viewer",
    });

    // A re-diff (ignore-region edit, threshold change, late upload) rewrites
    // verdicts only; the run status is derived, so the approval holds.
    await diff(s);

    expect((await runRow(s)).status).toBe("passed");
    expect(await verdicts(s, ["home"])).toEqual(["unresolved"]);
  }, 60_000);
});
