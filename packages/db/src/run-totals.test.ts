import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  builds,
  createDb,
  diffRegions,
  eq,
  projects,
  recomputeRunTotals,
  screenshots,
  testRuns,
  testVariations,
  type DB,
} from "./index.js";

/**
 * `recomputeRunTotals` rebuilds the run-level aggregates on `test_runs` from
 * the per-step columns (spec 2026-10-23 §5). Each case seeds a run's steps
 * straight into the rows it reads, so the rules are pinned independently of
 * the diff-worker that writes them.
 *
 * Skipped when `DATABASE_URL` is unset, like the other integration tests here.
 */
const RUN_INTEGRATION = !!process.env.DATABASE_URL;

type Verdict = "new" | "passed" | "unresolved" | null;
type Source = "this_branch" | "parent_pr" | "default_branch";

interface StepSeed {
  verdict?: Verdict;
  diffPercent?: number | null;
  pixels?: number | null;
  key?: string | null;
  source?: Source | null;
  vlm?: string | null;
  ruleResolved?: boolean;
  signature?: string | null;
  /** Capture order: the step's `created_at` is `base + at` seconds. Defaults
   *  to its position in the array. */
  at?: number;
  regions?: Array<{ severity: string; source: string }>;
}

describe.runIf(RUN_INTEGRATION)("recomputeRunTotals", () => {
  let db: DB;
  let close: () => Promise<void>;

  const tag = randomUUID();
  let projectId: string;
  let buildId: string;
  let variationId: string;

  beforeAll(async () => {
    const created = createDb();
    db = created.db;
    close = created.close;

    const [p] = await db
      .insert(projects)
      .values({ name: `run-totals-${tag}` })
      .returning();
    projectId = p!.id;
    const [b] = await db
      .insert(builds)
      .values({ projectId, isRunning: false })
      .returning();
    buildId = b!.id;
    const [v] = await db
      .insert(testVariations)
      .values({ name: `run-totals-${tag}`, projectId })
      .returning();
    variationId = v!.id;
  });

  afterAll(async () => {
    if (projectId) await db.delete(projects).where(eq(projects.id, projectId));
    await close();
  });

  /** Seeds a run holding `steps`, inserted in REVERSE array order so that the
   *  capture order (`created_at`) is the only thing that can explain a result. */
  async function seedRun(
    steps: StepSeed[],
    stored: Partial<typeof testRuns.$inferInsert> = {},
  ): Promise<string> {
    const [r] = await db
      .insert(testRuns)
      .values({
        buildId,
        projectId,
        name: `run-${randomUUID()}`,
        status: "running",
        ...stored,
      })
      .returning();
    const runId = r!.id;
    const indexed = steps.map((s, i) => ({ s, i }));
    for (const { s, i } of indexed.reverse()) {
      const [row] = await db
        .insert(screenshots)
        .values({
          runId,
          projectId,
          testVariationId: variationId,
          name: `step-${i}`,
          viewport: "1280x720",
          browser: "chromium",
          imageKey: randomUUID(),
          verdict: s.verdict === undefined ? "passed" : s.verdict,
          diffPercent: s.diffPercent ?? null,
          pixelMismatchCount: s.pixels ?? null,
          diffImageKey: s.key ?? null,
          baselineSource: s.source ?? null,
          vlmDescription: s.vlm ?? null,
          ruleResolved: s.ruleResolved ?? false,
          diffSignature: s.signature ?? null,
          createdAt: new Date(Date.UTC(2026, 9, 23, 12, 0, s.at ?? i)),
        })
        .returning();
      for (const region of s.regions ?? []) {
        await db.insert(diffRegions).values({
          runId,
          projectId,
          screenshotId: row!.id,
          severity: region.severity,
          category: "layout",
          bbox: { x: 0, y: 0, width: 10, height: 10 },
          description: "region",
          source: region.source,
        });
      }
    }
    return runId;
  }

  async function totals(runId: string) {
    const [row] = await db
      .select({
        diffPercent: testRuns.diffPercent,
        pixels: testRuns.pixelMisMatchCount,
        diffName: testRuns.diffName,
        baselineSource: testRuns.baselineSource,
        vlm: testRuns.vlmDescription,
        resolutionSource: testRuns.resolutionSource,
        primarySignature: testRuns.primarySignature,
      })
      .from(testRuns)
      .where(eq(testRuns.id, runId));
    return row!;
  }

  async function recompute(runId: string): Promise<void> {
    await db.transaction((tx) => recomputeRunTotals(tx, runId));
  }

  it("max diff and its image, sum of pixels, ignoring new steps", async () => {
    const runId = await seedRun([
      { diffPercent: 0.2, pixels: 20, key: "k-0.2" },
      { diffPercent: 1.5, pixels: 150, key: "k-1.5" },
      // A new step has no baseline pair: no diff numbers, whatever it stores.
      { verdict: "new", diffPercent: null, pixels: null },
    ]);
    await recompute(runId);

    const t = await totals(runId);
    expect(t.diffPercent).toBe(1.5);
    expect(t.diffName).toBe("k-1.5");
    expect(t.pixels).toBe(170);
  });

  it("a new step's stored numbers never count", async () => {
    const runId = await seedRun([
      { diffPercent: 0.5, pixels: 5, key: "k-0.5" },
      { verdict: "new", diffPercent: 9, pixels: 900, key: "k-new" },
    ]);
    await recompute(runId);

    const t = await totals(runId);
    expect(t.diffPercent).toBe(0.5);
    expect(t.pixels).toBe(5);
    expect(t.diffName).toBe("k-0.5");
  });

  it("an undiffed step (NULL verdict) never counts", async () => {
    const runId = await seedRun([
      { diffPercent: 0.5, pixels: 5, key: "k-0.5" },
      { verdict: null, diffPercent: 7, pixels: 700, key: "k-stale" },
    ]);
    await recompute(runId);

    const t = await totals(runId);
    expect(t.diffPercent).toBe(0.5);
    expect(t.pixels).toBe(5);
  });

  it("a step diffed at 0% counts as compared", async () => {
    const runId = await seedRun([
      { diffPercent: 0, pixels: 0 },
      { verdict: "new" },
    ]);
    await recompute(runId);

    const t = await totals(runId);
    expect(t.diffPercent).toBe(0);
    expect(t.pixels).toBe(0);
  });

  it("ties go to capture order", async () => {
    const runId = await seedRun([
      // Array position is not capture order: `at` decides it.
      { diffPercent: 2, pixels: 1, key: "k-later", at: 30 },
      { diffPercent: 2, pixels: 1, key: "k-first", at: 10 },
      { diffPercent: 2, pixels: 1, key: "k-middle", at: 20 },
    ]);
    await recompute(runId);

    expect((await totals(runId)).diffName).toBe("k-first");
  });

  it("baseline_source comes from the max-diff step with a source", async () => {
    const runId = await seedRun([
      { diffPercent: 1, source: "this_branch" },
      // The worst step of all has no source: it is skipped, not chosen.
      { diffPercent: 9, source: null },
      { diffPercent: 3, source: "parent_pr" },
      { diffPercent: 2, source: "default_branch" },
    ]);
    await recompute(runId);

    expect((await totals(runId)).baselineSource).toBe("parent_pr");
  });

  it("baseline_source ties go to capture order", async () => {
    const runId = await seedRun([
      { diffPercent: 2, source: "this_branch", at: 10 },
      { diffPercent: 2, source: "default_branch", at: 20 },
    ]);
    await recompute(runId);

    expect((await totals(runId)).baselineSource).toBe("this_branch");
  });

  it("vlm_description is the first non-empty in capture order", async () => {
    const runId = await seedRun([
      { vlm: "late", at: 40 },
      { vlm: null, at: 5 },
      { vlm: "", at: 10 },
      { vlm: "first", at: 20 },
      { vlm: "middle", at: 30 },
    ]);
    await recompute(runId);

    expect((await totals(runId)).vlm).toBe("first");
  });

  describe("resolution_source", () => {
    it("is rule iff none unresolved and one rule_resolved", async () => {
      const runId = await seedRun([
        { verdict: "passed", ruleResolved: true },
        { verdict: "passed" },
      ]);
      await recompute(runId);

      expect((await totals(runId)).resolutionSource).toBe("rule");
    });

    it("is NULL while any step is unresolved", async () => {
      const runId = await seedRun(
        [{ verdict: "passed", ruleResolved: true }, { verdict: "unresolved" }],
        { resolutionSource: "rule" },
      );
      await recompute(runId);

      expect((await totals(runId)).resolutionSource).toBeNull();
    });

    it("is NULL when no step was resolved by a rule", async () => {
      const runId = await seedRun([{ verdict: "passed" }], {
        resolutionSource: "rule",
      });
      await recompute(runId);

      expect((await totals(runId)).resolutionSource).toBeNull();
    });
  });

  describe("diff_name", () => {
    it("keeps the stored diff_name when no step has a diff_image_key (legacy)", async () => {
      const runId = await seedRun(
        [{ diffPercent: 3, pixels: 30, key: null }, { diffPercent: 1 }],
        { diffName: "legacy/worst.png" },
      );
      await recompute(runId);

      const t = await totals(runId);
      expect(t.diffName).toBe("legacy/worst.png");
      // Everything else is still recomputed.
      expect(t.diffPercent).toBe(3);
    });

    it("is NULL when the max step has no image but another step does", async () => {
      const runId = await seedRun(
        [
          { diffPercent: 5, key: null },
          { diffPercent: 1, key: "k-other" },
        ],
        { diffName: "stale.png" },
      );
      await recompute(runId);

      expect((await totals(runId)).diffName).toBeNull();
    });

    it("follows the max step to its own image once steps carry keys", async () => {
      const runId = await seedRun([{ diffPercent: 1, key: "k-new" }], {
        diffName: "legacy/worst.png",
      });
      await recompute(runId);

      expect((await totals(runId)).diffName).toBe("k-new");
    });
  });

  it("NULLs when no step was compared", async () => {
    const runId = await seedRun(
      [{ verdict: "new", diffPercent: null, pixels: null }, { verdict: "new" }],
      {
        diffPercent: 4.2,
        pixelMisMatchCount: 99,
        baselineSource: "this_branch",
        vlmDescription: "old",
        primarySignature: "v1:old",
        resolutionSource: "rule",
      },
    );
    await recompute(runId);

    expect(await totals(runId)).toEqual({
      diffPercent: null,
      pixels: null,
      diffName: null,
      baselineSource: null,
      vlm: null,
      resolutionSource: null,
      primarySignature: null,
    });
  });

  it("NULLs a run with no steps at all", async () => {
    const runId = await seedRun([], { diffPercent: 1, pixelMisMatchCount: 1 });
    await recompute(runId);

    const t = await totals(runId);
    expect(t.diffPercent).toBeNull();
    expect(t.pixels).toBeNull();
  });

  describe("primary_signature", () => {
    it("is the signature of the most severe unresolved step", async () => {
      const runId = await seedRun([
        {
          verdict: "unresolved",
          signature: "v1:minor",
          regions: [{ severity: "minor", source: "l1_pixel" }],
        },
        {
          verdict: "unresolved",
          signature: "v1:breaking",
          regions: [
            { severity: "cosmetic", source: "l1_pixel" },
            { severity: "breaking", source: "l1_pixel" },
          ],
        },
      ]);
      await recompute(runId);

      expect((await totals(runId)).primarySignature).toBe("v1:breaking");
    });

    it("ignores audit-only regions when ranking", async () => {
      const runId = await seedRun([
        {
          verdict: "unresolved",
          signature: "v1:audit-only",
          regions: [
            { severity: "breaking", source: "dynamic_text" },
            { severity: "breaking", source: "layout_suppressed" },
          ],
        },
        {
          verdict: "unresolved",
          signature: "v1:real",
          regions: [{ severity: "cosmetic", source: "l1_pixel" }],
        },
      ]);
      await recompute(runId);

      expect((await totals(runId)).primarySignature).toBe("v1:real");
    });

    it("breaks a severity tie by how many steps carry the signature", async () => {
      const runId = await seedRun([
        {
          signature: "v1:rare",
          at: 10,
          regions: [{ severity: "major", source: "l1_pixel" }],
        },
        {
          signature: "v1:common",
          at: 30,
          regions: [{ severity: "major", source: "l1_pixel" }],
        },
        {
          signature: "v1:common",
          at: 20,
          regions: [{ severity: "major", source: "l1_pixel" }],
        },
      ]);
      await recompute(runId);

      expect((await totals(runId)).primarySignature).toBe("v1:common");
    });

    it("breaks a full tie by capture order", async () => {
      const runId = await seedRun([
        {
          signature: "v1:captured-first",
          at: 10,
          regions: [{ severity: "major", source: "l1_pixel" }],
        },
        {
          signature: "v1:captured-second",
          at: 20,
          regions: [{ severity: "major", source: "l1_pixel" }],
        },
      ]);
      await recompute(runId);

      expect((await totals(runId)).primarySignature).toBe("v1:captured-first");
    });

    it("is NULL when no step has a region", async () => {
      const runId = await seedRun([{ signature: "v1:orphan", regions: [] }], {
        primarySignature: "v1:old",
      });
      await recompute(runId);

      expect((await totals(runId)).primarySignature).toBeNull();
    });
  });

  it("matches the old in-memory fold on a mixed run", async () => {
    // new + auto-approved (0%) + two real diffs, one with a rule resolution.
    const runId = await seedRun([
      { verdict: "new" },
      { verdict: "passed", diffPercent: 0, pixels: 0 },
      {
        verdict: "passed",
        diffPercent: 0.4,
        pixels: 40,
        key: "k-a",
        source: "this_branch",
        ruleResolved: true,
        vlm: "button moved",
      },
      {
        verdict: "passed",
        diffPercent: 2.5,
        pixels: 250,
        key: "k-b",
        source: "parent_pr",
        ruleResolved: false,
      },
    ]);
    await recompute(runId);

    expect(await totals(runId)).toEqual({
      diffPercent: 2.5,
      pixels: 290,
      diffName: "k-b",
      baselineSource: "parent_pr",
      vlm: "button moved",
      resolutionSource: "rule",
      primarySignature: null,
    });
  });
});
