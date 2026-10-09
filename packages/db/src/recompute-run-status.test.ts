import { randomUUID } from "node:crypto";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  baselines,
  builds,
  checkpointDecisions,
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
    /** One entry per checkpoint: its verdict and optional active decision. */
    checkpoints?: Array<{ verdict: Verdict; decision?: Decision }>;
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
        })
        .returning();
      shots.push(s!.id);
      if (c.decision) {
        await addDecision(runId, s!.id, c.decision, target);
      }
    }
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
      });
      expect(ia.checkpoints).toContainEqual({
        verdict: "passed",
        decision: null,
      });

      const ib = inputs.get(b.runId)!;
      expect(ib.lifecycle).toBe("new");
      expect(ib.override).toBeNull();
      expect(ib.checkpoints).toEqual([{ verdict: null, decision: null }]);
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
        { verdict: "unresolved", decision: null },
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

      // A holds the lock (and its uncommitted approval) until `release()`.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let aHoldsLock!: () => void;
      const aReady = new Promise<void>((resolve) => {
        aHoldsLock = resolve;
      });

      const aDone = a.db.transaction(async (txA) => {
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
        const raced = await Promise.race([
          bResult.then(() => "resolved" as const),
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

    it("two writers racing on one run end on the same, correct status", async () => {
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
