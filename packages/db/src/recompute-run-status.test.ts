import { randomUUID } from "node:crypto";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  baselines,
  builds,
  checkpointDecisions,
  computeRunCounters,
  createDb,
  eq,
  loadRollupInputs,
  projects,
  recomputeRunStatus,
  schema,
  screenshots,
  sql,
  testRuns,
  testVariations,
  type DB,
  type RunStatus,
  type Tx,
} from "./index.js";

/**
 * `recomputeRunStatus` is the only writer of `test_runs.status` after a diff
 * (spec §4.3). These tests drive every rollup rule end-to-end through real
 * rows, then pin the behaviours the writer exists for: `merge` follows the
 * baselines table, an unchanged run is a true no-op, and concurrent writers
 * serialize on the run's row lock.
 *
 * Skipped when `DATABASE_URL` is unset, like the other integration tests here.
 */
const RUN_INTEGRATION = !!process.env.DATABASE_URL;

type Verdict = "new" | "passed" | "unresolved" | null;
type Decision = "approved" | "rejected";

/** "ok" for a fulfilled promise; otherwise the SQLSTATE of the failure (drizzle
 *  wraps the driver error, so walk the `cause` chain to the PostgresError that
 *  carries `code`), falling back to the error message. */
function outcome(r: PromiseSettledResult<unknown>): string {
  if (r.status === "fulfilled") return "ok";
  let cur: unknown = r.reason;
  for (let depth = 0; cur && depth < 5; depth++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return String(r.reason);
}

describe.runIf(RUN_INTEGRATION)("recomputeRunStatus", () => {
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
      .values({ name: `recompute-status-${tag}` })
      .returning();
    projectId = p!.id;
    const [b] = await db
      .insert(builds)
      .values({ projectId, isRunning: false })
      .returning();
    buildId = b!.id;
    const [v] = await db
      .insert(testVariations)
      .values({ name: `recompute-status-${tag}`, projectId })
      .returning();
    variationId = v!.id;
  });

  afterAll(async () => {
    // projects cascade to builds / runs / screenshots / decisions / baselines.
    if (projectId) await db.delete(projects).where(eq(projects.id, projectId));
    await close();
  });

  interface SeedOpts {
    status?: RunStatus;
    override?: "passed" | "failed" | null;
    /**
     * One entry per checkpoint: its verdict, optional active decision, and
     * whether its diff failed for good.
     */
    checkpoints?: Array<{
      verdict: Verdict;
      decision?: Decision;
      diffFailed?: boolean;
    }>;
  }

  /** A run with one screenshot per `checkpoints` entry, verdicts and decisions
   *  written straight into the rows the writer reads. */
  async function seedRun(
    opts: SeedOpts = {},
    target: DB | Tx = db,
  ): Promise<{ runId: string; shots: string[] }> {
    const [r] = await target
      .insert(testRuns)
      .values({
        buildId,
        projectId,
        name: `run-${randomUUID()}`,
        status: opts.status ?? "running",
        statusOverride: opts.override ?? null,
      })
      .returning();
    const runId = r!.id;
    const shots: string[] = [];
    for (const [i, c] of (opts.checkpoints ?? []).entries()) {
      const [s] = await target
        .insert(screenshots)
        .values({
          runId,
          projectId,
          testVariationId: variationId,
          name: `shot-${i}`,
          viewport: "1280x720",
          browser: "chromium",
          imageKey: randomUUID(),
          verdict: c.verdict,
          diffFailedAt: c.diffFailed ? new Date() : null,
          diffError: c.diffFailed ? "engine_error" : null,
        })
        .returning();
      shots.push(s!.id);
      if (c.decision) {
        await addDecision(runId, s!.id, c.decision, target);
      }
    }
    // The counters a writer would have left for these rows (spec 2026-10-27
    // §3.1), so a test sees only what its own recompute moves.
    const seeded = (await loadRollupInputs(target, [runId])).get(runId)!;
    const counters = computeRunCounters(seeded, seeded.lifecycle);
    await target
      .update(testRuns)
      .set({
        pendingSteps: counters.pendingSteps,
        failedSteps: counters.failedSteps,
      })
      .where(eq(testRuns.id, runId));
    return { runId, shots };
  }

  async function addDecision(
    runId: string,
    screenshotId: string,
    decision: Decision,
    target: DB | Tx = db,
    over: Partial<typeof checkpointDecisions.$inferInsert> = {},
  ): Promise<void> {
    await target.insert(checkpointDecisions).values({
      projectId,
      runId,
      screenshotId,
      actionId: randomUUID(),
      decision,
      source: "viewer",
      ...over,
    });
  }

  async function storedRun(runId: string) {
    const [row] = await db
      .select({
        status: testRuns.status,
        merge: testRuns.merge,
        updatedAt: testRuns.updatedAt,
        pendingSteps: testRuns.pendingSteps,
        failedSteps: testRuns.failedSteps,
      })
      .from(testRuns)
      .where(eq(testRuns.id, runId));
    return row!;
  }

  /** The row's physical version: it only changes when an UPDATE rewrote it. */
  async function xminOf(runId: string): Promise<string> {
    const rows = await db.execute<{ x: string }>(
      sql`SELECT xmin::text AS x FROM test_runs WHERE id = ${runId}`,
    );
    return rows[0]!.x;
  }

  /** Polls (capped) until some backend is waiting on a Lock held by backend
   *  `blockerPid`: a positive "B is blocked on A" signal, rather than only
   *  noticing that B has not finished yet. */
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

  describe("the §4.3 rollup rules, through real rows", () => {
    it("rule 1: an aborted run stays aborted whatever its checkpoints say", async () => {
      const { runId } = await seedRun({
        status: "aborted",
        checkpoints: [{ verdict: "unresolved", decision: "rejected" }],
      });
      const res = await recomputeRunStatus(db, runId);
      expect(res).toEqual({
        before: "aborted",
        after: "aborted",
        changed: false,
      });
      expect((await storedRun(runId)).status).toBe("aborted");
    });

    it("rule 1: an empty run stays empty", async () => {
      const { runId } = await seedRun({
        status: "empty",
        checkpoints: [{ verdict: "new" }],
      });
      const res = await recomputeRunStatus(db, runId);
      expect(res.after).toBe("empty");
      expect((await storedRun(runId)).status).toBe("empty");
    });

    it("rule 1 beats an override on an aborted run", async () => {
      const { runId } = await seedRun({
        status: "aborted",
        override: "passed",
        checkpoints: [{ verdict: "unresolved" }],
      });
      expect((await recomputeRunStatus(db, runId)).after).toBe("aborted");
    });

    it("rule 2: a failed override wins over passing checkpoints", async () => {
      const { runId } = await seedRun({
        status: "passed",
        override: "failed",
        checkpoints: [{ verdict: "passed" }],
      });
      const res = await recomputeRunStatus(db, runId);
      expect(res).toEqual({
        before: "passed",
        after: "failed",
        changed: true,
      });
      expect((await storedRun(runId)).status).toBe("failed");
    });

    it("rule 2: a passed override wins over unresolved and undiffed checkpoints", async () => {
      const { runId } = await seedRun({
        status: "unresolved",
        override: "passed",
        checkpoints: [{ verdict: "unresolved" }, { verdict: null }],
      });
      const res = await recomputeRunStatus(db, runId);
      expect(res.after).toBe("passed");
      expect((await storedRun(runId)).status).toBe("passed");
    });

    it("rule 3: a run with no checkpoints keeps its lifecycle status", async () => {
      const { runId } = await seedRun({ status: "running", checkpoints: [] });
      const res = await recomputeRunStatus(db, runId);
      expect(res).toEqual({
        before: "running",
        after: "running",
        changed: false,
      });
    });

    it("rule 4: any checkpoint without a verdict makes the run running", async () => {
      const { runId } = await seedRun({
        status: "passed",
        checkpoints: [
          { verdict: "passed" },
          { verdict: null },
          { verdict: "unresolved" },
        ],
      });
      const res = await recomputeRunStatus(db, runId);
      expect(res).toEqual({
        before: "passed",
        after: "running",
        changed: true,
      });
      expect((await storedRun(runId)).status).toBe("running");
    });

    it("rule 5: all passed -> passed", async () => {
      const { runId } = await seedRun({
        status: "running",
        checkpoints: [{ verdict: "passed" }, { verdict: "passed" }],
      });
      expect((await recomputeRunStatus(db, runId)).after).toBe("passed");
      expect((await storedRun(runId)).status).toBe("passed");
    });

    it("rule 5: new outranks passed", async () => {
      const { runId } = await seedRun({
        checkpoints: [{ verdict: "passed" }, { verdict: "new" }],
      });
      expect((await recomputeRunStatus(db, runId)).after).toBe("new");
    });

    it("rule 5: unresolved outranks new and passed", async () => {
      const { runId } = await seedRun({
        checkpoints: [
          { verdict: "passed" },
          { verdict: "new" },
          { verdict: "unresolved" },
        ],
      });
      expect((await recomputeRunStatus(db, runId)).after).toBe("unresolved");
    });

    it("rule 5: a rejected decision (failed) outranks an unresolved verdict", async () => {
      const { runId } = await seedRun({
        checkpoints: [
          { verdict: "unresolved" },
          { verdict: "unresolved", decision: "rejected" },
        ],
      });
      expect((await recomputeRunStatus(db, runId)).after).toBe("failed");
      expect((await storedRun(runId)).status).toBe("failed");
    });

    it("rule 5: approving the only unresolved checkpoint passes the run", async () => {
      const { runId } = await seedRun({
        status: "unresolved",
        checkpoints: [
          { verdict: "passed" },
          { verdict: "unresolved", decision: "approved" },
        ],
      });
      const res = await recomputeRunStatus(db, runId);
      expect(res).toEqual({
        before: "unresolved",
        after: "passed",
        changed: true,
      });
    });

    it("rule 5: partial approval leaves the run unresolved", async () => {
      const { runId } = await seedRun({
        status: "unresolved",
        checkpoints: [
          { verdict: "unresolved", decision: "approved" },
          { verdict: "unresolved" },
        ],
      });
      const res = await recomputeRunStatus(db, runId);
      expect(res.after).toBe("unresolved");
      expect(res.changed).toBe(false);
    });

    it("rule 5: approving a new checkpoint passes it", async () => {
      const { runId } = await seedRun({
        status: "new",
        checkpoints: [{ verdict: "new", decision: "approved" }],
      });
      expect((await recomputeRunStatus(db, runId)).after).toBe("passed");
    });

    it("ignores reverted decisions: the verdict stands again", async () => {
      const { runId, shots } = await seedRun({
        status: "passed",
        checkpoints: [{ verdict: "unresolved" }],
      });
      await addDecision(runId, shots[0]!, "approved", db, {
        revertedAt: new Date(),
      });
      const res = await recomputeRunStatus(db, runId);
      expect(res).toEqual({
        before: "passed",
        after: "unresolved",
        changed: true,
      });
    });

    it("counts only the active decision when a reverted one sits beside it", async () => {
      const { runId, shots } = await seedRun({
        status: "failed",
        checkpoints: [{ verdict: "unresolved" }],
      });
      await addDecision(runId, shots[0]!, "rejected", db, {
        revertedAt: new Date(),
      });
      await addDecision(runId, shots[0]!, "approved");
      expect((await recomputeRunStatus(db, runId)).after).toBe("passed");
    });

    it("does not mix in checkpoints or decisions of another run", async () => {
      const a = await seedRun({
        checkpoints: [{ verdict: "passed" }],
      });
      await seedRun({
        checkpoints: [{ verdict: "unresolved", decision: "rejected" }],
      });
      expect((await recomputeRunStatus(db, a.runId)).after).toBe("passed");
    });

    it("never fixes a lifecycle status by itself: a stale status is rolled forward", async () => {
      // Stored `running` while every checkpoint has long since been diffed.
      const { runId } = await seedRun({
        status: "running",
        checkpoints: [{ verdict: "unresolved" }],
      });
      expect((await recomputeRunStatus(db, runId)).after).toBe("unresolved");
      expect((await storedRun(runId)).status).toBe("unresolved");
    });
  });

  describe("merge follows the baselines table", () => {
    it("is true iff a baselines row exists for the run", async () => {
      const { runId } = await seedRun({
        status: "passed",
        checkpoints: [{ verdict: "passed" }],
      });
      // Seeded runs start with merge = false and no baseline.
      let res = await recomputeRunStatus(db, runId);
      expect(res.changed).toBe(false);
      expect((await storedRun(runId)).merge).toBe(false);

      await db.insert(baselines).values({
        testVariationId: variationId,
        testRunId: runId,
        baselineName: randomUUID(),
      });
      res = await recomputeRunStatus(db, runId);
      // Status did not move, but merge did: that alone is a change.
      expect(res).toEqual({
        before: "passed",
        after: "passed",
        changed: true,
      });
      expect((await storedRun(runId)).merge).toBe(true);

      await db.delete(baselines).where(eq(baselines.testRunId, runId));
      res = await recomputeRunStatus(db, runId);
      expect(res.changed).toBe(true);
      expect((await storedRun(runId)).merge).toBe(false);
    });

    it("is not set by a baseline that belongs to another run", async () => {
      const mine = await seedRun({
        status: "passed",
        checkpoints: [{ verdict: "passed" }],
      });
      const other = await seedRun({
        status: "passed",
        checkpoints: [{ verdict: "passed" }],
      });
      await db.insert(baselines).values({
        testVariationId: variationId,
        testRunId: other.runId,
        baselineName: randomUUID(),
      });
      await recomputeRunStatus(db, mine.runId);
      expect((await storedRun(mine.runId)).merge).toBe(false);
    });
  });

  describe("the stored pending counters (spec 2026-10-27 §3.2)", () => {
    /** Overwrites the run's stored counters, as a stale write would leave them. */
    async function setCounters(
      runId: string,
      pendingSteps: number,
      failedSteps: number,
    ): Promise<void> {
      await db
        .update(testRuns)
        .set({ pendingSteps, failedSteps })
        .where(eq(testRuns.id, runId));
    }

    it("writes pending_steps and failed_steps with the status, in the one UPDATE and with no extra statement", async () => {
      // Stored `running` (counters 0) with every step diffed: the rollup makes
      // it reviewable.
      const { runId } = await seedRun({
        status: "running",
        checkpoints: [
          { verdict: "unresolved" },
          { verdict: "new" },
          { verdict: "unresolved", diffFailed: true },
          { verdict: "passed" },
          { verdict: "unresolved", decision: "approved" },
        ],
      });
      expect(await storedRun(runId)).toMatchObject({
        status: "running",
        pendingSteps: 0,
        failedSteps: 0,
      });

      const queries: string[] = [];
      const client = postgres(process.env.DATABASE_URL!, { max: 1 });
      const counting = drizzle(client, {
        schema,
        logger: { logQuery: (q) => void queries.push(q) },
      });
      try {
        expect(await recomputeRunStatus(counting, runId)).toEqual({
          before: "running",
          after: "unresolved",
          changed: true,
        });
      } finally {
        await client.end();
      }

      expect(await storedRun(runId)).toMatchObject({
        status: "unresolved",
        pendingSteps: 3,
        failedSteps: 1,
      });
      // The lock, the three input reads, the baseline probe, and one UPDATE
      // that carries the status and both counters.
      expect(queries).toHaveLength(6);
      const updates = queries.filter((q) => /^update /i.test(q));
      expect(updates).toHaveLength(1);
      expect(updates[0]).toMatch(/"status"/);
      expect(updates[0]).toMatch(/"pending_steps"/);
      expect(updates[0]).toMatch(/"failed_steps"/);
    });

    it("a counter-only change is a change: written, without bumping updated_at", async () => {
      const { runId, shots } = await seedRun({
        status: "unresolved",
        checkpoints: [{ verdict: "unresolved" }, { verdict: "unresolved" }],
      });
      expect((await storedRun(runId)).pendingSteps).toBe(2);
      const stale = new Date("2026-01-01T00:00:00.000Z");
      await db
        .update(testRuns)
        .set({ updatedAt: stale })
        .where(eq(testRuns.id, runId));

      // Approving one of the two leaves the run unresolved.
      await addDecision(runId, shots[0]!, "approved");
      expect(await recomputeRunStatus(db, runId)).toEqual({
        before: "unresolved",
        after: "unresolved",
        changed: true,
      });
      const row = await storedRun(runId);
      expect(row).toMatchObject({
        status: "unresolved",
        pendingSteps: 1,
        failedSteps: 0,
      });
      // `updated_at` follows the status (and merge) only, as before.
      expect(row.updatedAt.toISOString()).toBe(stale.toISOString());
    });

    it("writes nothing when the status and the counters are already right", async () => {
      const { runId } = await seedRun({
        status: "unresolved",
        checkpoints: [
          { verdict: "unresolved" },
          { verdict: "unresolved", diffFailed: true },
        ],
      });
      expect(await storedRun(runId)).toMatchObject({
        pendingSteps: 2,
        failedSteps: 1,
      });
      const xminBefore = await xminOf(runId);
      expect(await recomputeRunStatus(db, runId)).toEqual({
        before: "unresolved",
        after: "unresolved",
        changed: false,
      });
      expect(await xminOf(runId)).toBe(xminBefore);
    });

    it("repairs stale counters in both directions", async () => {
      const settled = await seedRun({
        status: "passed",
        checkpoints: [{ verdict: "passed" }],
      });
      const open = await seedRun({
        status: "new",
        checkpoints: [{ verdict: "new" }, { verdict: "new" }],
      });
      await setCounters(settled.runId, 5, 3);
      await setCounters(open.runId, 0, 0);

      expect((await recomputeRunStatus(db, settled.runId)).changed).toBe(true);
      expect((await recomputeRunStatus(db, open.runId)).changed).toBe(true);
      expect(await storedRun(settled.runId)).toMatchObject({
        status: "passed",
        pendingSteps: 0,
        failedSteps: 0,
      });
      expect(await storedRun(open.runId)).toMatchObject({
        status: "new",
        pendingSteps: 2,
        failedSteps: 0,
      });
    });

    it("are 0 for a run that is not reviewable, whatever was stored", async () => {
      const open = [
        { verdict: "unresolved" as const },
        { verdict: "unresolved" as const, diffFailed: true },
      ];
      const runs = [
        await seedRun({ status: "aborted", checkpoints: open }),
        await seedRun({ status: "empty", checkpoints: open }),
        await seedRun({
          status: "unresolved",
          override: "failed",
          checkpoints: open,
        }),
        await seedRun({
          status: "unresolved",
          checkpoints: [...open, { verdict: null }],
        }),
        await seedRun({ status: "running", checkpoints: [] }),
      ];
      for (const { runId } of runs) {
        await setCounters(runId, 2, 1);
        await recomputeRunStatus(db, runId);
        expect(await storedRun(runId)).toMatchObject({
          pendingSteps: 0,
          failedSteps: 0,
        });
      }
    });

    it("judges reviewability by the status it writes: an override set, then cleared", async () => {
      const { runId } = await seedRun({
        status: "unresolved",
        checkpoints: [{ verdict: "unresolved" }, { verdict: "new" }],
      });
      expect((await storedRun(runId)).pendingSteps).toBe(2);

      await db
        .update(testRuns)
        .set({ statusOverride: "passed" })
        .where(eq(testRuns.id, runId));
      await recomputeRunStatus(db, runId);
      expect(await storedRun(runId)).toMatchObject({
        status: "passed",
        pendingSteps: 0,
        failedSteps: 0,
      });

      await db
        .update(testRuns)
        .set({ statusOverride: null })
        .where(eq(testRuns.id, runId));
      await recomputeRunStatus(db, runId);
      expect(await storedRun(runId)).toMatchObject({
        status: "unresolved",
        pendingSteps: 2,
        failedSteps: 0,
      });
    });
  });

  describe("no-op and updated_at", () => {
    it("writes nothing and leaves updated_at alone when nothing changed", async () => {
      const { runId } = await seedRun({
        status: "passed",
        checkpoints: [{ verdict: "passed" }],
      });
      const stale = new Date("2026-01-01T00:00:00.000Z");
      await db
        .update(testRuns)
        .set({ updatedAt: stale })
        .where(eq(testRuns.id, runId));
      const xminBefore = await xminOf(runId);

      const res = await recomputeRunStatus(db, runId);
      expect(res).toEqual({
        before: "passed",
        after: "passed",
        changed: false,
      });
      expect((await storedRun(runId)).updatedAt.toISOString()).toBe(
        stale.toISOString(),
      );
      // A true no-op: the row was never rewritten.
      expect(await xminOf(runId)).toBe(xminBefore);
    });

    it("bumps updated_at when the status changed", async () => {
      const { runId } = await seedRun({
        status: "running",
        checkpoints: [{ verdict: "unresolved" }],
      });
      const stale = new Date("2026-01-01T00:00:00.000Z");
      await db
        .update(testRuns)
        .set({ updatedAt: stale })
        .where(eq(testRuns.id, runId));

      const res = await recomputeRunStatus(db, runId);
      expect(res.changed).toBe(true);
      expect((await storedRun(runId)).updatedAt.getTime()).toBeGreaterThan(
        stale.getTime(),
      );
    });

    it("is idempotent: a second call right after a change is a no-op", async () => {
      const { runId } = await seedRun({
        status: "running",
        checkpoints: [{ verdict: "new" }],
      });
      expect((await recomputeRunStatus(db, runId)).changed).toBe(true);
      const xminAfterFirst = await xminOf(runId);
      expect(await recomputeRunStatus(db, runId)).toEqual({
        before: "new",
        after: "new",
        changed: false,
      });
      expect(await xminOf(runId)).toBe(xminAfterFirst);
    });
  });

  describe("errors and transactions", () => {
    it("throws run_not_found:<id> for an unknown run", async () => {
      const missing = randomUUID();
      await expect(recomputeRunStatus(db, missing)).rejects.toThrow(
        `run_not_found:${missing}`,
      );
    });

    it("joins the caller's transaction: a rollback undoes the status write", async () => {
      const { runId } = await seedRun({
        status: "running",
        checkpoints: [{ verdict: "unresolved" }],
      });
      await expect(
        db.transaction(async (tx) => {
          const res = await recomputeRunStatus(tx, runId);
          expect(res.after).toBe("unresolved");
          throw new Error("rollback");
        }),
      ).rejects.toThrow("rollback");
      expect((await storedRun(runId)).status).toBe("running");
    });

    it("commits with the caller's transaction", async () => {
      const { runId } = await seedRun({
        status: "running",
        checkpoints: [{ verdict: "unresolved" }],
      });
      await db.transaction(async (tx) => {
        await recomputeRunStatus(tx, runId);
      });
      expect((await storedRun(runId)).status).toBe("unresolved");
    });

    it("sees decisions the caller wrote earlier in the same transaction", async () => {
      const { runId, shots } = await seedRun({
        status: "unresolved",
        checkpoints: [{ verdict: "unresolved" }],
      });
      await db.transaction(async (tx) => {
        await addDecision(runId, shots[0]!, "approved", tx);
        const res = await recomputeRunStatus(tx, runId);
        expect(res.after).toBe("passed");
      });
      expect((await storedRun(runId)).status).toBe("passed");
    });
  });

  describe("with the run's lock already held (lockHeld)", () => {
    /** Rolls back a transaction once `fn` has run in it. */
    class Rollback extends Error {}

    /**
     * `recomputeRunStatus` on `runId`, plain or with `lockHeld` after locking
     * the run (as the decision core does), in a transaction that is then
     * rolled back: its result, and what it left in the run's row.
     */
    async function recomputeOnce(runId: string, held: boolean) {
      let out: unknown;
      await db
        .transaction(async (tx) => {
          const rowOf = async () => {
            const [row] = await tx
              .select({
                status: testRuns.status,
                merge: testRuns.merge,
                pendingSteps: testRuns.pendingSteps,
                failedSteps: testRuns.failedSteps,
                updatedAt: testRuns.updatedAt,
                xmin: sql<string>`xmin::text`,
              })
              .from(testRuns)
              .where(eq(testRuns.id, runId));
            return row!;
          };
          const before = await rowOf();
          if (held) {
            await tx
              .select({ id: testRuns.id })
              .from(testRuns)
              .where(eq(testRuns.id, runId))
              .for("no key update");
          }
          const result = await recomputeRunStatus(
            tx,
            runId,
            held ? { lockHeld: true } : {},
          );
          const after = await rowOf();
          out = {
            result,
            row: {
              status: after.status,
              merge: after.merge,
              pendingSteps: after.pendingSteps,
              failedSteps: after.failedSteps,
              updatedAtMoved:
                after.updatedAt.getTime() !== before.updatedAt.getTime(),
              rewritten: after.xmin !== before.xmin,
            },
          };
          throw new Rollback();
        })
        .catch((err: unknown) => {
          if (!(err instanceof Rollback)) throw err;
        });
      return out;
    }

    const open = { verdict: "unresolved" as const };
    const scenarios: Array<[string, () => Promise<string>]> = [
      [
        "aborted, a rejected step",
        async () =>
          (
            await seedRun({
              status: "aborted",
              checkpoints: [{ verdict: "unresolved", decision: "rejected" }],
            })
          ).runId,
      ],
      [
        "empty",
        async () =>
          (
            await seedRun({
              status: "empty",
              checkpoints: [{ verdict: "new" }],
            })
          ).runId,
      ],
      [
        "aborted under a passed override",
        async () =>
          (
            await seedRun({
              status: "aborted",
              override: "passed",
              checkpoints: [open],
            })
          ).runId,
      ],
      [
        "a failed override over passing steps",
        async () =>
          (
            await seedRun({
              status: "passed",
              override: "failed",
              checkpoints: [{ verdict: "passed" }],
            })
          ).runId,
      ],
      [
        "a passed override over unresolved and undiffed steps",
        async () =>
          (
            await seedRun({
              status: "unresolved",
              override: "passed",
              checkpoints: [open, { verdict: null }],
            })
          ).runId,
      ],
      [
        "no steps",
        async () =>
          (await seedRun({ status: "running", checkpoints: [] })).runId,
      ],
      [
        "an undiffed step",
        async () =>
          (
            await seedRun({
              status: "passed",
              checkpoints: [{ verdict: "passed" }, { verdict: null }, open],
            })
          ).runId,
      ],
      [
        "all passed",
        async () =>
          (
            await seedRun({
              status: "running",
              checkpoints: [{ verdict: "passed" }, { verdict: "passed" }],
            })
          ).runId,
      ],
      [
        "unresolved outranks new and passed",
        async () =>
          (
            await seedRun({
              checkpoints: [{ verdict: "passed" }, { verdict: "new" }, open],
            })
          ).runId,
      ],
      [
        "a rejected step outranks an unresolved one",
        async () =>
          (
            await seedRun({
              checkpoints: [
                open,
                { verdict: "unresolved", decision: "rejected" },
              ],
            })
          ).runId,
      ],
      [
        "the only unresolved step approved",
        async () =>
          (
            await seedRun({
              status: "unresolved",
              checkpoints: [
                { verdict: "passed" },
                { verdict: "unresolved", decision: "approved" },
              ],
            })
          ).runId,
      ],
      [
        "a partial approval: nothing to write",
        async () =>
          (
            await seedRun({
              status: "unresolved",
              checkpoints: [
                { verdict: "unresolved", decision: "approved" },
                open,
              ],
            })
          ).runId,
      ],
      [
        "counters with a failed diff and an approved step",
        async () =>
          (
            await seedRun({
              status: "running",
              checkpoints: [
                open,
                { verdict: "new" },
                { verdict: "unresolved", diffFailed: true },
                { verdict: "passed" },
                { verdict: "unresolved", decision: "approved" },
              ],
            })
          ).runId,
      ],
      [
        "many steps of each kind (grouped and counted)",
        async () =>
          (
            await seedRun({
              status: "unresolved",
              checkpoints: [
                ...Array.from({ length: 7 }, () => open),
                ...Array.from({ length: 3 }, () => ({
                  verdict: "new" as const,
                })),
                ...Array.from({ length: 4 }, () => ({
                  verdict: "unresolved" as const,
                  diffFailed: true,
                })),
                ...Array.from({ length: 2 }, () => ({
                  verdict: "passed" as const,
                })),
                ...Array.from({ length: 2 }, () => ({
                  verdict: "new" as const,
                  decision: "approved" as const,
                })),
              ],
            })
          ).runId,
      ],
      [
        "stale counters",
        async () => {
          const { runId } = await seedRun({
            status: "new",
            checkpoints: [{ verdict: "new" }, { verdict: "new" }],
          });
          await db
            .update(testRuns)
            .set({ pendingSteps: 5, failedSteps: 3 })
            .where(eq(testRuns.id, runId));
          return runId;
        },
      ],
      [
        "a baseline row: merge",
        async () => {
          const { runId } = await seedRun({
            status: "passed",
            checkpoints: [{ verdict: "passed" }],
          });
          await db.insert(baselines).values({
            testVariationId: variationId,
            testRunId: runId,
            baselineName: randomUUID(),
          });
          return runId;
        },
      ],
      [
        "merge stored with no baseline row",
        async () => {
          const { runId } = await seedRun({
            status: "passed",
            checkpoints: [{ verdict: "passed" }],
          });
          await db
            .update(testRuns)
            .set({ merge: true })
            .where(eq(testRuns.id, runId));
          return runId;
        },
      ],
      [
        "a reverted decision beside the active one",
        async () => {
          const { runId, shots } = await seedRun({
            status: "failed",
            checkpoints: [open, open],
          });
          await addDecision(runId, shots[0]!, "rejected", db, {
            revertedAt: new Date(),
          });
          await addDecision(runId, shots[0]!, "approved");
          await addDecision(runId, shots[1]!, "approved", db, {
            revertedAt: new Date(),
          });
          return runId;
        },
      ],
      [
        "a decision filed under another run",
        async () => {
          const mine = await seedRun({
            status: "unresolved",
            checkpoints: [open],
          });
          const other = await seedRun({
            status: "unresolved",
            checkpoints: [open],
          });
          await addDecision(other.runId, mine.shots[0]!, "rejected");
          return mine.runId;
        },
      ],
    ];

    it.each(scenarios)(
      "writes what the plain recompute writes: %s",
      async (_name, setup) => {
        const runId = await setup();
        const plain = await recomputeOnce(runId, false);
        const held = await recomputeOnce(runId, true);
        expect(held).toEqual(plain);
      },
    );

    it("the scenarios cover a status write, a counter-only write, a merge write and no write", async () => {
      // Guards the comparison above: it compares every kind of outcome.
      const outcomes = [];
      for (const [, setup] of scenarios) {
        const runId = await setup();
        outcomes.push(
          (await recomputeOnce(runId, true)) as {
            result: { changed: boolean; before: string; after: string };
            row: { updatedAtMoved: boolean; rewritten: boolean };
          },
        );
      }
      const kinds = new Set(
        outcomes.map(({ result, row }) =>
          !result.changed
            ? "none"
            : result.before !== result.after
              ? "status"
              : row.updatedAtMoved
                ? "merge"
                : "counters",
        ),
      );
      expect([...kinds].sort()).toEqual([
        "counters",
        "merge",
        "none",
        "status",
      ]);
      for (const { result, row } of outcomes) {
        expect(row.rewritten).toBe(result.changed);
      }
    });

    it("takes no lock and no savepoint: one read, then the UPDATE when something moved", async () => {
      const moving = await seedRun({
        status: "running",
        checkpoints: [open, { verdict: "new" }],
      });
      const settled = await seedRun({
        status: "passed",
        checkpoints: [{ verdict: "passed" }],
      });
      const statements: string[] = [];
      const client = postgres(process.env.DATABASE_URL!, {
        max: 1,
        debug: (_conn, query) => void statements.push(query),
      });
      const counting = drizzle(client, { schema });
      /** The statements since the last check: none locks or savepoints. */
      const noLockNorSavepoint = () => {
        for (const q of statements) {
          expect(q).not.toMatch(/for (no key )?update|savepoint/i);
        }
      };
      try {
        await counting.transaction(async (tx) => {
          for (const runId of [moving.runId, settled.runId].sort()) {
            await tx
              .select({ id: testRuns.id })
              .from(testRuns)
              .where(eq(testRuns.id, runId))
              .for("no key update");
          }
          statements.length = 0;
          expect(
            await recomputeRunStatus(tx, moving.runId, { lockHeld: true }),
          ).toEqual({ before: "running", after: "unresolved", changed: true });
          expect(statements).toHaveLength(2);
          expect(statements[1]).toMatch(/^update "test_runs"/i);
          // Checked before they are cleared for the second call.
          noLockNorSavepoint();
          statements.length = 0;
          expect(
            await recomputeRunStatus(tx, settled.runId, { lockHeld: true }),
          ).toEqual({ before: "passed", after: "passed", changed: false });
          expect(statements).toHaveLength(1);
          noLockNorSavepoint();
        });
      } finally {
        await client.end();
      }
      expect(await storedRun(moving.runId)).toMatchObject({
        status: "unresolved",
        pendingSteps: 2,
      });
    });

    it("throws run_not_found:<id> for an unknown run", async () => {
      const missing = randomUUID();
      await expect(
        db.transaction((tx) =>
          recomputeRunStatus(tx, missing, { lockHeld: true }),
        ),
      ).rejects.toThrow(`run_not_found:${missing}`);
    });
  });

  describe("loadRollupInputs", () => {
    it("returns the lifecycle, override, verdicts and active decisions per run", async () => {
      const a = await seedRun({
        status: "unresolved",
        override: "failed",
        checkpoints: [
          { verdict: "unresolved", decision: "approved" },
          { verdict: "passed" },
        ],
      });
      const b = await seedRun({
        status: "new",
        checkpoints: [{ verdict: null }],
      });

      const inputs = await loadRollupInputs(db, [a.runId, b.runId]);
      expect(inputs.size).toBe(2);

      const ia = inputs.get(a.runId)!;
      expect(ia.lifecycle).toBe("unresolved");
      expect(ia.override).toBe("failed");
      expect(ia.checkpoints).toHaveLength(2);
      expect(ia.checkpoints).toContainEqual({
        verdict: "unresolved",
        decision: "approved",
        diffFailed: false,
      });
      expect(ia.checkpoints).toContainEqual({
        verdict: "passed",
        decision: null,
        diffFailed: false,
      });

      const ib = inputs.get(b.runId)!;
      expect(ib.lifecycle).toBe("new");
      expect(ib.override).toBeNull();
      expect(ib.checkpoints).toEqual([
        { verdict: null, decision: null, diffFailed: false },
      ]);
    });

    it("leaves out unknown runs and handles an empty list", async () => {
      const a = await seedRun({ checkpoints: [{ verdict: "passed" }] });
      const missing = randomUUID();
      const inputs = await loadRollupInputs(db, [a.runId, missing]);
      expect([...inputs.keys()]).toEqual([a.runId]);
      expect((await loadRollupInputs(db, [])).size).toBe(0);
    });

    it("ignores reverted decisions", async () => {
      const { runId, shots } = await seedRun({
        checkpoints: [{ verdict: "unresolved" }],
      });
      await addDecision(runId, shots[0]!, "rejected", db, {
        revertedAt: new Date(),
      });
      const inputs = await loadRollupInputs(db, [runId]);
      expect(inputs.get(runId)!.checkpoints).toEqual([
        { verdict: "unresolved", decision: null, diffFailed: false },
      ]);
    });

    it("lists a run with no checkpoints with an empty checkpoint array", async () => {
      const { runId } = await seedRun({ checkpoints: [] });
      const inputs = await loadRollupInputs(db, [runId]);
      expect(inputs.get(runId)!.checkpoints).toEqual([]);
    });

    it("is batched: three queries for any number of runs", async () => {
      const seeded = await Promise.all(
        [1, 2, 3, 4].map(() =>
          seedRun({
            checkpoints: [
              { verdict: "unresolved", decision: "approved" },
              { verdict: "new" },
            ],
          }),
        ),
      );

      // A separate connection whose logger counts the statements it sends.
      const queries: string[] = [];
      const client = postgres(process.env.DATABASE_URL!, { max: 1 });
      const counting = drizzle(client, {
        schema,
        logger: { logQuery: (q) => void queries.push(q) },
      });
      try {
        const inputs = await loadRollupInputs(
          counting,
          seeded.map((s) => s.runId),
        );
        expect(inputs.size).toBe(4);
        expect(queries).toHaveLength(3);
        queries.length = 0;
        await loadRollupInputs(counting, [seeded[0]!.runId]);
        expect(queries).toHaveLength(3);
      } finally {
        await client.end();
      }
    });
  });

  describe("concurrent writers", () => {
    it("serializes on the run's row lock: B waits for A, then sees A's decision", async () => {
      const { runId, shots } = await seedRun({
        status: "unresolved",
        checkpoints: [{ verdict: "unresolved" }],
      });

      const a = createDb();
      const b = createDb();
      // Open B's connection now, so connection setup cannot be what keeps its
      // recompute "pending" below.
      await b.db.execute(sql`select 1`);

      // A holds the lock (and its uncommitted approval) until `release()`.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let aHoldsLock!: () => void;
      const aReady = new Promise<void>((resolve) => {
        aHoldsLock = resolve;
      });

      let aPid = 0;
      const aDone = a.db.transaction(async (txA) => {
        const pid = await txA.execute<{ pid: number }>(
          sql`select pg_backend_pid() as pid`,
        );
        aPid = pid[0]!.pid;
        await recomputeRunStatus(txA, runId); // takes the row lock
        await txA.insert(checkpointDecisions).values({
          projectId,
          runId,
          screenshotId: shots[0]!,
          actionId: randomUUID(),
          decision: "approved",
          source: "viewer",
        });
        aHoldsLock();
        await gate; // not committed yet
      });
      // If A fails before reaching the gate, do not strand the test on `aReady`.
      aDone.catch(() => aHoldsLock());

      let bPromise: Promise<unknown> = Promise.resolve();
      try {
        await aReady;

        // B starts while A holds the lock and must not complete.
        const bResult = recomputeRunStatus(b.db, runId);
        bPromise = bResult;

        // Positive signal: a backend is waiting on a Lock held by A's backend.
        expect(await waitForLockWaiter(aPid)).toBe(true);

        // And B has not settled. (Either outcome counts as "settled", so a late
        // rejection of `bResult` cannot become an unhandled rejection here.)
        const raced = await Promise.race([
          bResult.then(
            () => "settled" as const,
            () => "settled" as const,
          ),
          new Promise<"pending">((resolve) =>
            setTimeout(() => resolve("pending"), 200),
          ),
        ]);
        expect(raced).toBe("pending");

        // Commit A. B was waiting on the lock, so it now reads A's decision.
        release();
        await aDone;
        const res = await bResult;
        expect(res).toEqual({
          before: "unresolved",
          after: "passed",
          changed: true,
        });
        expect((await storedRun(runId)).status).toBe("passed");
      } finally {
        // Always let A finish, even when an assertion failed above.
        release();
        await Promise.allSettled([aDone, bPromise]);
        await a.close();
        await b.close();
      }
    }, 20_000);

    it("insert-then-recompute does not deadlock: two transactions each approve a different checkpoint, then both recompute", async () => {
      // Every INSERT into a table with an FK to test_runs (decisions here)
      // takes FOR KEY SHARE on the parent run row. A FOR UPDATE lock conflicts
      // with that, so two transactions that each insert a child row and then
      // recompute would wait on each other (40P01). FOR NO KEY UPDATE does not
      // conflict with KEY SHARE, and still conflicts with itself.
      const { runId, shots } = await seedRun({
        status: "unresolved",
        checkpoints: [{ verdict: "unresolved" }, { verdict: "unresolved" }],
      });

      const a = createDb();
      const b = createDb();

      // Rendezvous: neither transaction recomputes before BOTH have inserted,
      // so both hold KEY SHARE on the run row at the moment they ask for the lock.
      let aInserted!: () => void;
      const aInsertedP = new Promise<void>((resolve) => {
        aInserted = resolve;
      });
      let bInserted!: () => void;
      const bInsertedP = new Promise<void>((resolve) => {
        bInserted = resolve;
      });
      const bothInserted = Promise.all([aInsertedP, bInsertedP]);

      const approveThenRecompute = (
        conn: DB,
        shot: string,
        arrive: () => void,
      ) =>
        conn.transaction(async (tx) => {
          try {
            await tx.insert(checkpointDecisions).values({
              projectId,
              runId,
              screenshotId: shot,
              actionId: randomUUID(),
              decision: "approved",
              source: "viewer",
            });
          } finally {
            // Never strand the other transaction on the rendezvous.
            arrive();
          }
          await bothInserted;
          return recomputeRunStatus(tx, runId);
        });

      try {
        // No retry on purpose: a 40P01 must fail the test.
        const [ra, rb] = await Promise.allSettled([
          approveThenRecompute(a.db, shots[0]!, aInserted),
          approveThenRecompute(b.db, shots[1]!, bInserted),
        ]);
        // "ok" or the SQLSTATE: a deadlock reads as ["ok", "40P01"].
        expect([outcome(ra), outcome(rb)]).toEqual(["ok", "ok"]);
      } finally {
        await a.close();
        await b.close();
      }

      // Both decisions committed, and the status reflects BOTH of them.
      expect((await storedRun(runId)).status).toBe("passed");
      expect(await recomputeRunStatus(db, runId)).toEqual({
        before: "passed",
        after: "passed",
        changed: false,
      });
    }, 20_000);

    it("six writers racing on one run end on the same, correct status", async () => {
      const { runId } = await seedRun({
        status: "running",
        checkpoints: [{ verdict: "unresolved" }, { verdict: "new" }],
      });
      const results = await Promise.all(
        Array.from({ length: 6 }, () => recomputeRunStatus(db, runId)),
      );
      expect(results.every((r) => r.after === "unresolved")).toBe(true);
      // Exactly one of them performed the write.
      expect(results.filter((r) => r.changed)).toHaveLength(1);
      expect((await storedRun(runId)).status).toBe("unresolved");
    });
  });
});
