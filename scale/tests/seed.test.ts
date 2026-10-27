import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { pendingStepCondition } from "@furan/api/scale";
import {
  and,
  baselines,
  builds,
  count,
  createDb,
  eq,
  inArray,
  isNotNull,
  screenshots,
  sql,
  testRuns,
  testVariations,
  users,
  type DB,
} from "@furan/db";
import { createHddStorage } from "@furan/storage";
import bcrypt from "bcryptjs";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { generatePng } from "../src/seed/images.js";
import { markSeedUsed, seed, type Seeded } from "../src/seed/index.js";
import { MIN_FREE_GIB, createScratch } from "../src/seed/scratch.js";
import {
  PIPELINE_SETS,
  SEED_NAMES,
  expectedRows,
  pipelineStep,
  shapes,
} from "../src/seed/shape.js";
import { SeedDriftError, verifyStatuses } from "../src/seed/verify.js";

/**
 * Seeds the smoke shape into `furan_scale` on the test Postgres named by
 * SCALE_DATABASE_URL, with HDD storage in a temp dir. Skipped without it.
 */
const adminUrl = process.env.SCALE_DATABASE_URL;

async function countIn(
  db: DB,
  table: "builds" | "test_runs" | "screenshots",
  projectId: string,
): Promise<number> {
  const [row] = await db.execute<{ n: number }>(
    sql`select count(*)::int as n from ${sql.identifier(table)} where project_id = ${projectId}`,
  );
  return row!.n;
}

async function baselineCount(db: DB, projectId: string): Promise<number> {
  const [row] = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from baselines b
    join test_variations v on v.id = b.test_variation_id
    where v.project_id = ${projectId}`);
  return row!.n;
}

/** True when the step is pending, as the review queue defines it. */
async function isPending(db: DB, checkpointId: string): Promise<boolean> {
  const rows = await db
    .select({ id: screenshots.id })
    .from(screenshots)
    .innerJoin(testRuns, eq(testRuns.id, screenshots.runId))
    .where(and(eq(screenshots.id, checkpointId), pendingStepCondition()));
  return rows.length === 1;
}

async function pendingInBuild(db: DB, buildId: string): Promise<string[]> {
  const rows = await db
    .select({ id: screenshots.id })
    .from(screenshots)
    .innerJoin(testRuns, eq(testRuns.id, screenshots.runId))
    .where(and(eq(testRuns.buildId, buildId), pendingStepCondition()));
  return rows.map((r) => r.id);
}

/** `pending/failed`, per run. */
type Counters = { pending: number; failed: number };

/**
 * Every run of `projectId` with the counters the app's own definition gives:
 * `pendingStepCondition()` (no facets) grouped per run, and the same plus
 * `diff_failed_at IS NOT NULL` for the failed ones; 0 for a run with none.
 */
async function canonicalCounters(
  db: DB,
  projectId: string,
): Promise<Map<string, Counters>> {
  const grouped = (failedOnly: boolean) =>
    db
      .select({ id: screenshots.runId, n: count() })
      .from(screenshots)
      .innerJoin(testRuns, eq(testRuns.id, screenshots.runId))
      .where(
        and(
          eq(testRuns.projectId, projectId),
          eq(screenshots.projectId, projectId),
          pendingStepCondition(),
          failedOnly ? isNotNull(screenshots.diffFailedAt) : undefined,
        ),
      )
      .groupBy(screenshots.runId);
  const pending = new Map((await grouped(false)).map((r) => [r.id, r.n]));
  const failed = new Map((await grouped(true)).map((r) => [r.id, r.n]));
  const runs = await db
    .select({ id: testRuns.id })
    .from(testRuns)
    .where(eq(testRuns.projectId, projectId));
  return new Map(
    runs.map(({ id }) => [
      id,
      { pending: pending.get(id) ?? 0, failed: failed.get(id) ?? 0 },
    ]),
  );
}

/** Every run of `projectId` with its stored counters. */
async function storedCounters(
  db: DB,
  projectId: string,
): Promise<Map<string, Counters>> {
  const runs = await db
    .select({
      id: testRuns.id,
      pending: testRuns.pendingSteps,
      failed: testRuns.failedSteps,
    })
    .from(testRuns)
    .where(eq(testRuns.projectId, projectId));
  return new Map(
    runs.map((r) => [r.id, { pending: r.pending, failed: r.failed }]),
  );
}

describe.skipIf(!adminUrl)("seed (smoke shape, test Postgres)", () => {
  it("stores every run's pending counters as pendingStepCondition counts them", async () => {
    const scratch = await createScratch(adminUrl as string, {
      minFreeGiB: MIN_FREE_GIB.smoke,
    });
    const { db, close } = createDb({ url: scratch.url });
    const root = await mkdtemp(join(tmpdir(), "furan-scale-counters-"));
    const storage = createHddStorage({ root });
    try {
      const seeded = await seed(db, shapes.smoke, storage, { reuse: false });

      for (const projectId of [seeded.projectId, seeded.resolvedProjectId]) {
        const canonical = await canonicalCounters(db, projectId);
        expect(await storedCounters(db, projectId)).toEqual(canonical);
      }
      // Not vacuous: the main project has pending runs, and most of the
      // worst-case project's are resolved.
      const main = await canonicalCounters(db, seeded.projectId);
      expect([...main.values()].some((c) => c.pending > 0)).toBe(true);
      const worst = await canonicalCounters(db, seeded.resolvedProjectId);
      expect([...worst.values()].some((c) => c.pending > 0)).toBe(true);
      expect([...worst.values()].some((c) => c.pending === 0)).toBe(true);

      // The app's writer agrees on every run (statuses, merge and counters).
      await verifyStatuses(db, seeded.projectId, 10_000);
      await verifyStatuses(db, seeded.resolvedProjectId, 10_000);

      // A stale counter is reported as one, and left as it was.
      const [stale] = [...main.entries()].find(([, c]) => c.pending > 0)!;
      await db
        .update(testRuns)
        .set({ pendingSteps: 0 })
        .where(eq(testRuns.id, stale));
      const drift = await verifyStatuses(db, seeded.projectId, 10_000).then(
        () => null,
        (e: unknown) => e,
      );
      expect(drift).toBeInstanceOf(SeedDriftError);
      expect((drift as SeedDriftError).drift).toEqual([
        expect.objectContaining({ runId: stale, moved: ["counters"] }),
      ]);
      expect((drift as Error).message).toMatch(/counters 0\/\d+ -> \d+\/\d+/);
      const [after] = await db
        .select({ pending: testRuns.pendingSteps })
        .from(testRuns)
        .where(eq(testRuns.id, stale));
      expect(after!.pending).toBe(0);
    } finally {
      await close();
      await scratch.drop();
      await scratch.release();
      await rm(root, { recursive: true, force: true });
    }
  }, 300_000);

  it("seeds the expected rows, consistent statuses and usable spots", async () => {
    const scratch = await createScratch(adminUrl as string, {
      minFreeGiB: MIN_FREE_GIB.smoke,
    });
    const { db, close } = createDb({ url: scratch.url });
    const root = await mkdtemp(join(tmpdir(), "furan-scale-seed-"));
    const storage = createHddStorage({ root });
    try {
      const shape = shapes.smoke;
      const started = performance.now();
      const seeded: Seeded = await seed(db, shape, storage, { reuse: false });
      const seconds = (performance.now() - started) / 1000;
      expect(seconds).toBeLessThan(60);

      // Row counts of the main project match the shape.
      const want = expectedRows(shape);
      expect({
        builds: await countIn(db, "builds", seeded.projectId),
        runs: await countIn(db, "test_runs", seeded.projectId),
        screenshots: await countIn(db, "screenshots", seeded.projectId),
        baselines: await baselineCount(db, seeded.projectId),
      }).toEqual(want);

      // Every changed step has 2-5 pixel regions of a real severity and a
      // diff signature; passed and undiffed steps have neither.
      const perStep = await db.execute<{
        verdict: string | null;
        regions: number;
        signed: boolean;
        severities: string[];
        sources: string[];
      }>(sql`
        select s.verdict::text as verdict, count(d.id)::int as regions,
               s.diff_signature is not null as signed,
               coalesce(array_agg(distinct d.severity) filter (where d.id is not null), '{}') as severities,
               coalesce(array_agg(distinct d.source) filter (where d.id is not null), '{}') as sources
        from screenshots s left join diff_regions d on d.screenshot_id = s.id
        where s.project_id = ${seeded.projectId}
        group by s.id`);
      for (const step of perStep) {
        const changed = step.verdict === "new" || step.verdict === "unresolved";
        expect(step.signed).toBe(changed);
        if (changed) {
          expect(step.regions).toBeGreaterThanOrEqual(2);
          expect(step.regions).toBeLessThanOrEqual(5);
          for (const sev of step.severities) {
            expect(["breaking", "major", "minor", "cosmetic"]).toContain(sev);
          }
          expect(step.sources).toEqual(["pixel"]);
        } else {
          expect(step.regions).toBe(0);
        }
      }
      // Signatures group like changes within a batch.
      const [grouping] = await db.execute<{ steps: number; sigs: number }>(sql`
        select count(*)::int as steps, count(distinct s.diff_signature)::int as sigs
        from screenshots s join test_runs r on r.id = s.run_id
        where r.build_id = ${seeded.newestBuildId} and s.diff_signature is not null`);
      expect(grouping!.sigs).toBeLessThan(grouping!.steps);

      // Diff images (Ruling R10): every `unresolved` step has a diff image in
      // storage, as the worker writes one where the pixel diff found a change;
      // `new`, `passed` and undiffed steps have none. A run holding an
      // unresolved step names one of its steps' diff images in `diff_name`;
      // the others have none.
      const diffs = await db.execute<{
        verdict: string | null;
        key: string | null;
      }>(sql`
        select verdict::text as verdict, diff_image_key as key
        from screenshots where project_id = ${seeded.projectId}`);
      const diffKeys = new Set<string>();
      for (const d of diffs) {
        if (d.verdict === "unresolved") {
          expect(d.key).not.toBeNull();
          diffKeys.add(d.key!);
        } else {
          expect(d.key).toBeNull();
        }
      }
      expect(diffKeys.size).toBeGreaterThan(1);
      for (const key of diffKeys) {
        expect(await storage.head(key)).not.toBeNull();
      }
      const [runDiffs] = await db.execute<{ wrong: number; named: number }>(sql`
        select
          count(*) filter (where
            (r.diff_name is not null) <> exists (
              select 1 from screenshots s
              where s.run_id = r.id and s.verdict = 'unresolved')
            or (r.diff_name is not null and not exists (
              select 1 from screenshots s
              where s.run_id = r.id and s.diff_image_key = r.diff_name)))::int as wrong,
          count(r.diff_name)::int as named
        from test_runs r where r.project_id = ${seeded.projectId}`);
      expect(runDiffs!.wrong).toBe(0);
      expect(runDiffs!.named).toBeGreaterThan(0);

      // Ruling R10a: the unresolved steps the viewer budgets step through
      // (the review batch and the long run) each have a diff image no other
      // step shares; the older history shares the 8-image pool.
      const [recentDiffs] = await db.execute<{
        steps: number;
        keys: number;
        shared: number;
      }>(sql`
        select count(*)::int as steps,
               count(distinct s.diff_image_key)::int as keys,
               count(*) filter (where (
                 select count(*) from screenshots o
                 where o.diff_image_key = s.diff_image_key) > 1)::int as shared
        from screenshots s join test_runs r on r.id = s.run_id
        where r.build_id in (${seeded.newestBuildId}, ${seeded.longRunBuildId})
          and s.verdict = 'unresolved'`);
      expect(recentDiffs!.steps).toBeGreaterThan(0);
      expect(recentDiffs!.keys).toBe(recentDiffs!.steps);
      expect(recentDiffs!.shared).toBe(0);
      const [historyDiffs] = await db.execute<{ keys: number }>(sql`
        select count(distinct s.diff_image_key)::int as keys
        from screenshots s join test_runs r on r.id = s.run_id
        where r.project_id = ${seeded.projectId}
          and r.build_id not in (${seeded.newestBuildId}, ${seeded.longRunBuildId})`);
      expect(historyDiffs!.keys).toBeGreaterThan(0);
      expect(historyDiffs!.keys).toBeLessThanOrEqual(8);

      // The worst-case project has the old script's shape: one batch per
      // nightly and PR batch, the newest one full-size.
      expect(await countIn(db, "builds", seeded.resolvedProjectId)).toBe(
        shape.nightlies + shape.prBatches,
      );

      // Every run's status is what recomputeRunStatus derives.
      await verifyStatuses(db, seeded.projectId, 10_000);
      await verifyStatuses(db, seeded.resolvedProjectId, 10_000);

      // Users: the reviewers and the browser login.
      expect(seeded.reviewers).toHaveLength(shape.reviewers);
      const [reviewer0] = await db
        .select({ email: users.email, hash: users.hashedPassword })
        .from(users)
        .where(eq(users.id, seeded.reviewers[0]!.id));
      expect(reviewer0!.email).toBe(seeded.browserLogin.email);
      expect(
        await bcrypt.compare(seeded.browserLogin.password, reviewer0!.hash),
      ).toBe(true);

      // The newest batch is the newest nightly; the long run has its own
      // recent one-run batch.
      const [newest] = await db
        .select({ id: builds.id })
        .from(builds)
        .where(eq(builds.projectId, seeded.projectId))
        .orderBy(sql`${builds.createdAt} desc`)
        .limit(1);
      expect(newest!.id).toBe(seeded.newestBuildId);
      expect(seeded.longRunBuildId).not.toBe(seeded.newestBuildId);
      const longRuns = await db
        .select({ id: testRuns.id, n: testRuns.checkpointCount })
        .from(testRuns)
        .where(eq(testRuns.buildId, seeded.longRunBuildId));
      expect(longRuns).toEqual([
        { id: seeded.longRunId, n: shape.longRunSteps },
      ]);

      // Review spots.
      const { mid, last, exhausted, worstNewestKept } = seeded.soloSpots;
      expect(mid.buildId).toBe(seeded.newestBuildId);
      expect(last.buildId).toBe(seeded.newestBuildId);
      expect(mid.checkpointId).not.toBe(last.checkpointId);
      for (const spot of [mid, last, exhausted, worstNewestKept]) {
        expect(await isPending(db, spot.checkpointId!)).toBe(true);
      }
      expect(exhausted.buildId).not.toBe(seeded.newestBuildId);
      expect(await pendingInBuild(db, exhausted.buildId)).toEqual([
        exhausted.checkpointId,
      ]);
      const [worstRun] = await db
        .select({ projectId: testRuns.projectId })
        .from(testRuns)
        .where(eq(testRuns.id, worstNewestKept.runId!));
      expect(worstRun!.projectId).toBe(seeded.resolvedProjectId);

      // The probe key belongs to exactly one row across every key column the
      // storage proxy checks, and its object exists.
      const probe = seeded.uniqueKeyProbe;
      const [owners] = await db.execute<{ n: number }>(sql`
        select (
          (select count(*) from screenshots
           where ${probe}::text in (image_key, dom_key, element_map_key, diff_image_key))
          + (select count(*) from test_runs
             where ${probe}::text in (image_name, diff_name)))::int as n`);
      expect(owners!.n).toBe(1);
      expect(await storage.head(seeded.uniqueKeyProbe)).not.toBeNull();
      // It is long-run step 1's image, where the viewer is opened (R4, D5).
      const [stepOne] = await db
        .select({
          runId: screenshots.runId,
          name: screenshots.name,
          key: screenshots.imageKey,
        })
        .from(screenshots)
        .where(eq(screenshots.id, seeded.longRunFirstStepId));
      expect(stepOne).toEqual({
        runId: seeded.longRunId,
        name: SEED_NAMES.longRunStep(1),
        key: seeded.uniqueKeyProbe,
      });

      // Every step's image is in storage.
      const keys = await db
        .selectDistinct({ key: screenshots.imageKey })
        .from(screenshots);
      for (const { key } of keys) {
        expect(await storage.head(key)).not.toBeNull();
      }

      // Pipeline sets: main-branch variations whose baseline image is the
      // set step's `none` image.
      for (const set of PIPELINE_SETS) {
        const { variationIds, branch } = seeded.pipeline[set];
        expect(branch).toBe("main");
        expect(variationIds).toHaveLength(shape.pipelineSets[set]);
        const vars = await db
          .select({
            id: testVariations.id,
            name: testVariations.name,
            branch: testVariations.branchName,
            baselineName: testVariations.baselineName,
          })
          .from(testVariations)
          .where(inArray(testVariations.id, variationIds));
        const byId = new Map(vars.map((v) => [v.id, v]));
        variationIds.forEach((id, i) => {
          expect(byId.get(id)?.name).toBe(pipelineStep(set, i).name);
          expect(byId.get(id)?.branch).toBe("main");
        });
        const first = byId.get(variationIds[0]!)!;
        const [bl] = await db
          .select({ name: baselines.baselineName })
          .from(baselines)
          .where(eq(baselines.testVariationId, first.id));
        expect(bl!.name).toBe(first.baselineName);
        const step = pipelineStep(set, 0);
        const stored = Buffer.from(await storage.get(first.baselineName!));
        const expected = await generatePng(step.kind, step.seed, "none");
        const [a, b] = await Promise.all(
          [stored, expected].map((p) => sharp(p).raw().toBuffer()),
        );
        expect(a!.equals(b!)).toBe(true);
      }

      // Reuse: same shape version, so nothing is reseeded; a fresh browser
      // password is set.
      const again = await seed(db, shape, storage, { reuse: true });
      expect(again.projectId).toBe(seeded.projectId);
      expect(again.newestBuildId).toBe(seeded.newestBuildId);
      // Compared as a boolean: a failing matcher would print both passwords.
      expect(again.browserLogin.password === seeded.browserLogin.password).toBe(
        false,
      );
      const [reviewer0After] = await db
        .select({ hash: users.hashedPassword })
        .from(users)
        .where(eq(users.id, again.reviewers[0]!.id));
      expect(
        await bcrypt.compare(again.browserLogin.password, reviewer0After!.hash),
      ).toBe(true);

      // A status the rollup would change is reported, and left as it was.
      const [victim] = await db
        .select({ id: testRuns.id, status: testRuns.status })
        .from(testRuns)
        .where(
          and(
            eq(testRuns.projectId, seeded.projectId),
            eq(testRuns.status, "passed"),
          ),
        )
        .limit(1);
      await db
        .update(testRuns)
        .set({ status: "unresolved" })
        .where(eq(testRuns.id, victim!.id));
      await expect(
        verifyStatuses(db, seeded.projectId, 10_000),
      ).rejects.toBeInstanceOf(SeedDriftError);
      const [after] = await db
        .select({ status: testRuns.status })
        .from(testRuns)
        .where(eq(testRuns.id, victim!.id));
      expect(after!.status).toBe("unresolved");

      // A stale shape version is reseeded even with reuse.
      await db.execute(sql`update scale_meta set shape_version = 0`);
      const reseeded = await seed(db, shape, storage, { reuse: true });
      expect(reseeded.projectId).not.toBe(seeded.projectId);
      expect(await countIn(db, "builds", reseeded.projectId)).toBe(want.builds);
      expect(await countIn(db, "builds", seeded.projectId)).toBe(0);

      // A seed a suite has used up (the server suite's approvals) is reseeded
      // even with reuse.
      await markSeedUsed(db);
      const afterUse = await seed(db, shape, storage, { reuse: true });
      expect(afterUse.projectId).not.toBe(reseeded.projectId);
    } finally {
      await close();
      await scratch.drop();
      await scratch.release();
      await rm(root, { recursive: true, force: true });
    }
  }, 300_000);
});
