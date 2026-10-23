import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  bumpStepGenerations,
  builds,
  createDb,
  diffRegions,
  eq,
  inArray,
  markStepDiffFailed,
  projects,
  screenshots,
  sql,
  testRuns,
  testVariations,
  type DB,
} from "./index.js";

/**
 * The shared per-step diff helpers (spec 2026-10-23 §2, §3, §6): the version
 * bump that queues a step for a diff, and the final-failure path that fails
 * ONE step without aborting its run.
 *
 * Skipped when `DATABASE_URL` is unset, like the other integration tests here.
 */
const RUN_INTEGRATION = !!process.env.DATABASE_URL;

describe.runIf(RUN_INTEGRATION)("per-step diff helpers", () => {
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
      .values({ name: `step-diff-${tag}` })
      .returning();
    projectId = p!.id;
    const [b] = await db
      .insert(builds)
      .values({ projectId, isRunning: false })
      .returning();
    buildId = b!.id;
    const [v] = await db
      .insert(testVariations)
      .values({ name: `step-diff-${tag}`, projectId })
      .returning();
    variationId = v!.id;
  });

  afterAll(async () => {
    // projects cascade to builds / runs / screenshots / regions.
    if (projectId) await db.delete(projects).where(eq(projects.id, projectId));
    await close();
  });

  /** A run with `n` steps (screenshots), each with the given verdict. */
  async function seedRun(
    n: number,
    over: {
      status?: "running" | "passed";
      verdict?: "new" | "passed" | "unresolved" | null;
    } = {},
  ): Promise<{ runId: string; steps: string[] }> {
    const [r] = await db
      .insert(testRuns)
      .values({
        buildId,
        projectId,
        name: `run-${randomUUID()}`,
        status: over.status ?? "running",
        checkpointCount: n,
      })
      .returning();
    const runId = r!.id;
    const steps: string[] = [];
    for (let i = 0; i < n; i++) {
      const [s] = await db
        .insert(screenshots)
        .values({
          runId,
          projectId,
          testVariationId: variationId,
          name: `step-${i}`,
          viewport: "1280x720",
          browser: "chromium",
          imageKey: randomUUID(),
          verdict: over.verdict === undefined ? null : over.verdict,
          // Capture order: step i was uploaded i seconds after step 0.
          createdAt: new Date(Date.UTC(2026, 9, 23, 12, 0, i)),
        })
        .returning();
      steps.push(s!.id);
    }
    return { runId, steps };
  }

  async function stepRow(id: string) {
    const [row] = await db
      .select()
      .from(screenshots)
      .where(eq(screenshots.id, id));
    return row!;
  }

  async function addRegion(runId: string, screenshotId: string) {
    await db.insert(diffRegions).values({
      runId,
      projectId,
      screenshotId,
      severity: "major",
      category: "layout",
      bbox: { x: 0, y: 0, width: 10, height: 10 },
      description: "region",
      source: "l1_pixel",
    });
  }

  async function regionCount(screenshotId: string): Promise<number> {
    const rows = await db
      .select({ id: diffRegions.id })
      .from(diffRegions)
      .where(eq(diffRegions.screenshotId, screenshotId));
    return rows.length;
  }

  describe("bumpStepGenerations", () => {
    it("bumps only the named steps of the run", async () => {
      const { runId, steps } = await seedRun(3);
      const other = await seedRun(1);
      // A leftover re-queue count from an earlier version must be reset.
      await db
        .update(screenshots)
        .set({ diffRequeues: 2 })
        .where(eq(screenshots.id, steps[0]!));

      const bumped = await db.transaction((tx) =>
        // `other.steps[0]` is not a step of `runId`: it must be ignored.
        bumpStepGenerations(tx, runId, [steps[0]!, steps[1]!, other.steps[0]!]),
      );

      expect(bumped.map((b) => b.id).sort()).toEqual(
        [steps[0]!, steps[1]!].sort(),
      );
      expect(bumped.every((b) => b.generation === 1)).toBe(true);

      const [s0, s1, s2, foreign] = await Promise.all(
        [...steps, other.steps[0]!].map(stepRow),
      );
      expect(s0!.diffGeneration).toBe(1);
      expect(s1!.diffGeneration).toBe(1);
      expect(s2!.diffGeneration).toBe(0);
      expect(foreign!.diffGeneration).toBe(0);

      expect(s0!.diffQueuedAt).toBeInstanceOf(Date);
      expect(s1!.diffQueuedAt).toBeInstanceOf(Date);
      expect(s0!.diffRequeues).toBe(0);
      expect(s2!.diffQueuedAt).toBeNull();
      expect(foreign!.diffQueuedAt).toBeNull();
    });

    it("bumps again on every call: a version is never reused", async () => {
      const { runId, steps } = await seedRun(1);
      const first = await db.transaction((tx) =>
        bumpStepGenerations(tx, runId, steps),
      );
      const second = await db.transaction((tx) =>
        bumpStepGenerations(tx, runId, steps),
      );
      expect(first).toEqual([{ id: steps[0]!, generation: 1 }]);
      expect(second).toEqual([{ id: steps[0]!, generation: 2 }]);
    });

    it("returns nothing, and writes nothing, for an empty id list", async () => {
      const { runId, steps } = await seedRun(1);
      const bumped = await db.transaction((tx) =>
        bumpStepGenerations(tx, runId, []),
      );
      expect(bumped).toEqual([]);
      expect((await stepRow(steps[0]!)).diffGeneration).toBe(0);
    });
  });

  /** Polls (capped) until some backend is waiting on a lock held by backend
   *  `blockerPid`: a positive "B is blocked on A" signal. */
  async function waitForLockWaiter(
    blockerPid: number,
    capMs = 5_000,
  ): Promise<boolean> {
    const deadline = Date.now() + capMs;
    while (Date.now() < deadline) {
      const rows = await db.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE wait_event_type = 'Lock'
          AND ${blockerPid}::int = ANY(pg_blocking_pids(pid))
      `);
      if (rows[0]!.n > 0) return true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return false;
  }

  describe("markStepDiffFailed", () => {
    it("fails the step and the run becomes unresolved", async () => {
      const { runId, steps } = await seedRun(3, { verdict: "passed" });
      const [failing, other] = [steps[2]!, steps[1]!];
      // The failing step is queued at version 1 and has no verdict yet.
      await db
        .update(screenshots)
        .set({ verdict: null, diffGeneration: 1 })
        .where(eq(screenshots.id, failing));
      await addRegion(runId, failing);
      await addRegion(runId, other);

      const result = await db.transaction((tx) =>
        markStepDiffFailed(tx, {
          runId,
          stepId: failing,
          generation: 1,
          code: "object_missing",
        }),
      );

      expect(result.applied).toBe(true);
      expect(result.rollup).toEqual({ before: "running", after: "unresolved" });

      const row = await stepRow(failing);
      expect(row.verdict).toBe("unresolved");
      expect(row.verdictAt).toBeInstanceOf(Date);
      expect(row.diffError).toBe("object_missing");
      expect(row.diffFailedAt).toBeInstanceOf(Date);

      // Its regions no longer describe its image; another step's are untouched.
      expect(await regionCount(failing)).toBe(0);
      expect(await regionCount(other)).toBe(1);
      expect((await stepRow(other)).verdict).toBe("passed");

      const [run] = await db
        .select({ status: testRuns.status })
        .from(testRuns)
        .where(eq(testRuns.id, runId));
      expect(run!.status).toBe("unresolved");
    });

    it("refreshes the run totals in the same commit", async () => {
      const { runId, steps } = await seedRun(2, { verdict: "passed" });
      await db
        .update(screenshots)
        .set({ diffPercent: 2.5, pixelMismatchCount: 25, diffImageKey: "k0" })
        .where(eq(screenshots.id, steps[0]!));
      await db
        .update(screenshots)
        .set({ verdict: null, diffGeneration: 1 })
        .where(eq(screenshots.id, steps[1]!));

      await db.transaction((tx) =>
        markStepDiffFailed(tx, {
          runId,
          stepId: steps[1]!,
          generation: 1,
          code: "engine_error",
        }),
      );

      const [run] = await db
        .select({
          diffPercent: testRuns.diffPercent,
          pixels: testRuns.pixelMisMatchCount,
          diffName: testRuns.diffName,
        })
        .from(testRuns)
        .where(eq(testRuns.id, runId));
      expect(run).toEqual({ diffPercent: 2.5, pixels: 25, diffName: "k0" });
    });

    it("is a no-op on a newer version", async () => {
      const { runId, steps } = await seedRun(2, { verdict: "passed" });
      const stepId = steps[0]!;
      // A newer job (version 2) owns the step; version 1 is stale.
      await db
        .update(screenshots)
        .set({ diffGeneration: 2 })
        .where(eq(screenshots.id, stepId));
      await addRegion(runId, stepId);
      const before = await stepRow(stepId);

      const result = await db.transaction((tx) =>
        markStepDiffFailed(tx, {
          runId,
          stepId,
          generation: 1,
          code: "timeout",
        }),
      );

      expect(result).toEqual({ applied: false });
      expect(await stepRow(stepId)).toEqual(before);
      expect(await regionCount(stepId)).toBe(1);
      const [run] = await db
        .select({ status: testRuns.status })
        .from(testRuns)
        .where(eq(testRuns.id, runId));
      expect(run!.status).toBe("running");
    });

    it("is a no-op when a newer version commits while it waits for the step", async () => {
      const { runId, steps } = await seedRun(1);
      const stepId = steps[0]!;
      await db
        .update(screenshots)
        .set({ diffGeneration: 1 })
        .where(eq(screenshots.id, stepId));

      // Transaction A queues the step again (version 2) and holds its row.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let started!: (pid: number) => void;
      const pidOfA = new Promise<number>((resolve) => (started = resolve));
      const a = db.transaction(async (tx) => {
        const rows = await tx.execute<{ pid: number }>(
          sql`SELECT pg_backend_pid() AS pid`,
        );
        await bumpStepGenerations(tx, runId, [stepId]);
        started(rows[0]!.pid);
        await gate;
      });

      // Transaction B is the version-1 job's failure. It must wait for A, then
      // find the step re-versioned and do nothing.
      const blockerPid = await pidOfA;
      const b = db.transaction((tx) =>
        markStepDiffFailed(tx, {
          runId,
          stepId,
          generation: 1,
          code: "timeout",
        }),
      );
      expect(await waitForLockWaiter(blockerPid)).toBe(true);
      release();
      await a;

      expect(await b).toEqual({ applied: false });
      const row = await stepRow(stepId);
      expect(row.diffGeneration).toBe(2);
      expect(row.verdict).toBeNull();
      expect(row.diffFailedAt).toBeNull();
    });

    it("fails four steps of one run concurrently without a deadlock", async () => {
      const { runId, steps } = await seedRun(4);
      await db
        .update(screenshots)
        .set({ diffGeneration: 1 })
        .where(eq(screenshots.runId, runId));

      const results = await Promise.all(
        steps.map((stepId) =>
          db.transaction((tx) =>
            markStepDiffFailed(tx, {
              runId,
              stepId,
              generation: 1,
              code: "engine_error",
            }),
          ),
        ),
      );

      expect(results.every((r) => r.applied)).toBe(true);
      const rows = await db
        .select({ verdict: screenshots.verdict })
        .from(screenshots)
        .where(eq(screenshots.runId, runId));
      expect(rows.every((r) => r.verdict === "unresolved")).toBe(true);
      const [run] = await db
        .select({ status: testRuns.status })
        .from(testRuns)
        .where(eq(testRuns.id, runId));
      expect(run!.status).toBe("unresolved");
    });

    it("is a no-op when the step is gone or belongs to another run", async () => {
      const { runId } = await seedRun(1);
      const other = await seedRun(1);

      const missing = await db.transaction((tx) =>
        markStepDiffFailed(tx, {
          runId,
          stepId: randomUUID(),
          generation: 0,
          code: "internal",
        }),
      );
      const foreign = await db.transaction((tx) =>
        markStepDiffFailed(tx, {
          runId,
          stepId: other.steps[0]!,
          generation: 0,
          code: "internal",
        }),
      );
      const noRun = await db.transaction((tx) =>
        markStepDiffFailed(tx, {
          runId: randomUUID(),
          stepId: other.steps[0]!,
          generation: 0,
          code: "internal",
        }),
      );

      expect(missing).toEqual({ applied: false });
      expect(foreign).toEqual({ applied: false });
      expect(noRun).toEqual({ applied: false });
      const [row] = await db
        .select({ verdict: screenshots.verdict })
        .from(screenshots)
        .where(inArray(screenshots.id, other.steps));
      expect(row!.verdict).toBeNull();
    });
  });
});
