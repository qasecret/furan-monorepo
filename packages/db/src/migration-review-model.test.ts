import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  builds,
  checkpointDecisions,
  createDb,
  eq,
  inArray,
  projects,
  screenshots,
  testRuns,
  testVariations,
  users,
  type DB,
} from "./index.js";

/**
 * Migration `0035_review_model`: per-checkpoint verdicts, the append-only
 * `checkpoint_decisions` log and the run-level status override.
 *
 * Asserts the post-migration shape against a live database (columns, enums,
 * index definitions, FK on-delete rules) and the load-bearing behaviours the
 * constraints exist for (one active decision per checkpoint, closed `source`
 * set, microsecond `created_at` ordering). Skipped when `DATABASE_URL` is unset
 * — same convention as the other migration tests in this package.
 */
const RUN_INTEGRATION = !!process.env.DATABASE_URL;

/** The SQLSTATE of a failed statement. drizzle wraps the driver error, so walk
 *  the `cause` chain to the PostgresError that carries `code`. */
function sqlState(err: unknown): string | undefined {
  let cur: unknown = err;
  for (let depth = 0; cur && depth < 5; depth++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

async function expectSqlState(
  fn: () => Promise<unknown>,
  state: string,
): Promise<void> {
  let caught: unknown;
  try {
    await fn();
  } catch (e) {
    caught = e;
  }
  expect(caught, "expected the statement to fail").toBeDefined();
  expect(sqlState(caught)).toBe(state);
}

describe.runIf(RUN_INTEGRATION)("0035_review_model migration", () => {
  let db: DB;
  let close: () => Promise<void>;

  const tag = randomUUID();
  const userIds: string[] = [];
  let projectId: string;
  let buildId: string;
  let variationId: string;
  let actorId: string;

  beforeAll(async () => {
    const created = createDb();
    db = created.db;
    close = created.close;

    const [actor] = await db
      .insert(users)
      .values({
        email: `review-model-${tag}@t.example`,
        hashedPassword: "x",
        firstName: "review",
        lastName: "model",
        role: "editor",
      })
      .returning();
    actorId = actor!.id;
    userIds.push(actorId);

    const [p] = await db
      .insert(projects)
      .values({ name: `review-model-${tag}` })
      .returning();
    projectId = p!.id;
    const [b] = await db
      .insert(builds)
      .values({ projectId, userId: actorId, isRunning: false })
      .returning();
    buildId = b!.id;
    const [v] = await db
      .insert(testVariations)
      .values({ name: `review-model-${tag}`, projectId })
      .returning();
    variationId = v!.id;
  });

  afterAll(async () => {
    // projects cascade to builds / runs / screenshots / checkpoint_decisions.
    if (projectId) await db.delete(projects).where(eq(projects.id, projectId));
    if (userIds.length > 0) {
      await db.delete(users).where(inArray(users.id, userIds));
    }
    await close();
  });

  /** A fresh run with `n` screenshots. */
  async function seedRun(n = 1): Promise<{ runId: string; shots: string[] }> {
    const [r] = await db
      .insert(testRuns)
      .values({ buildId, projectId, name: `run-${randomUUID()}` })
      .returning();
    const runId = r!.id;
    const shots: string[] = [];
    for (let i = 0; i < n; i++) {
      const [s] = await db
        .insert(screenshots)
        .values({
          runId,
          projectId,
          testVariationId: variationId,
          name: `shot-${i}`,
          viewport: "1280x720",
          browser: "chromium",
          imageKey: randomUUID(),
        })
        .returning();
      shots.push(s!.id);
    }
    return { runId, shots };
  }

  function decision(
    runId: string,
    screenshotId: string,
    over: Partial<typeof checkpointDecisions.$inferInsert> = {},
  ): typeof checkpointDecisions.$inferInsert {
    return {
      projectId,
      runId,
      screenshotId,
      actionId: randomUUID(),
      decision: "approved",
      actorId,
      source: "viewer",
      ...over,
    };
  }

  describe("columns and enums", () => {
    it("adds screenshots.verdict, screenshots.verdict_at and test_runs.status_override", async () => {
      const rows = await db.execute<{
        table_name: string;
        column_name: string;
        udt_name: string;
        is_nullable: string;
      }>(sql`
        SELECT table_name, column_name, udt_name, is_nullable
        FROM information_schema.columns
        WHERE (table_name = 'screenshots' AND column_name IN ('verdict', 'verdict_at'))
           OR (table_name = 'test_runs' AND column_name = 'status_override')
        ORDER BY table_name, column_name
      `);
      expect(
        rows.map((r) => [r.table_name, r.column_name, r.udt_name]),
      ).toEqual([
        ["screenshots", "verdict", "checkpoint_verdict"],
        ["screenshots", "verdict_at", "timestamptz"],
        ["test_runs", "status_override", "run_status_override"],
      ]);
      // All three are nullable (NULL = not diffed yet / no override).
      expect(rows.every((r) => r.is_nullable === "YES")).toBe(true);
    });

    it("declares the three enums with the labels the shared model mirrors", async () => {
      const labels = async (type: string): Promise<string[]> => {
        const rows = await db.execute<{ enumlabel: string }>(sql`
          SELECT enumlabel FROM pg_enum
          WHERE enumtypid = ${type}::regtype
          ORDER BY enumsortorder
        `);
        return rows.map((r) => r.enumlabel);
      };
      expect(await labels("checkpoint_verdict")).toEqual([
        "new",
        "passed",
        "unresolved",
      ]);
      expect(await labels("checkpoint_decision")).toEqual([
        "approved",
        "rejected",
      ]);
      expect(await labels("run_status_override")).toEqual(["passed", "failed"]);
    });

    it("round-trips verdict, verdict_at and status_override", async () => {
      const { runId, shots } = await seedRun(1);
      const at = new Date("2026-10-09T10:00:00.000Z");
      await db
        .update(screenshots)
        .set({ verdict: "unresolved", verdictAt: at })
        .where(eq(screenshots.id, shots[0]!));
      await db
        .update(testRuns)
        .set({ statusOverride: "failed" })
        .where(eq(testRuns.id, runId));

      const [s] = await db
        .select({ verdict: screenshots.verdict, at: screenshots.verdictAt })
        .from(screenshots)
        .where(eq(screenshots.id, shots[0]!));
      expect(s?.verdict).toBe("unresolved");
      expect(s?.at?.toISOString()).toBe(at.toISOString());
      const [r] = await db
        .select({ o: testRuns.statusOverride })
        .from(testRuns)
        .where(eq(testRuns.id, runId));
      expect(r?.o).toBe("failed");
    });

    it("defaults verdict and status_override to NULL for existing-style rows", async () => {
      const { runId, shots } = await seedRun(1);
      const [s] = await db
        .select({ verdict: screenshots.verdict, at: screenshots.verdictAt })
        .from(screenshots)
        .where(eq(screenshots.id, shots[0]!));
      expect(s).toEqual({ verdict: null, at: null });
      const [r] = await db
        .select({ o: testRuns.statusOverride })
        .from(testRuns)
        .where(eq(testRuns.id, runId));
      expect(r?.o).toBeNull();
    });

    it("rejects a verdict outside the enum (22P02)", async () => {
      const { shots } = await seedRun(1);
      await expectSqlState(
        () =>
          db.execute(
            sql`UPDATE screenshots SET verdict = 'bogus' WHERE id = ${shots[0]!}`,
          ),
        "22P02",
      );
    });
  });

  describe("checkpoint_decisions table shape", () => {
    it("has the partial unique index on (screenshot_id) WHERE reverted_at IS NULL", async () => {
      const rows = await db.execute<{ indexdef: string }>(sql`
        SELECT indexdef FROM pg_indexes
        WHERE tablename = 'checkpoint_decisions'
          AND indexname = 'checkpoint_decisions_active_uniq'
      `);
      expect(rows).toHaveLength(1);
      const def = rows[0]!.indexdef;
      expect(def).toContain("CREATE UNIQUE INDEX");
      expect(def).toContain("(screenshot_id)");
      expect(def).toContain("WHERE (reverted_at IS NULL)");
    });

    it("has the action, run and project+created_at DESC indexes", async () => {
      const rows = await db.execute<{ indexname: string; indexdef: string }>(
        sql`
          SELECT indexname, indexdef FROM pg_indexes
          WHERE tablename = 'checkpoint_decisions'
        `,
      );
      const def = (name: string): string =>
        rows.find((r) => r.indexname === name)?.indexdef ?? "";
      expect(def("checkpoint_decisions_action_idx")).toContain("(action_id)");
      expect(def("checkpoint_decisions_run_idx")).toContain("(run_id)");
      expect(def("checkpoint_decisions_project_created_idx")).toContain(
        "(project_id, created_at DESC)",
      );
    });

    it("defaults created_at to clock_timestamp()", async () => {
      const rows = await db.execute<{ column_default: string | null }>(sql`
        SELECT column_default FROM information_schema.columns
        WHERE table_name = 'checkpoint_decisions' AND column_name = 'created_at'
      `);
      expect(rows[0]?.column_default).toContain("clock_timestamp()");
    });

    it("has the closed source CHECK constraint", async () => {
      const rows = await db.execute<{ def: string }>(sql`
        SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'checkpoint_decisions'::regclass
          AND conname = 'checkpoint_decisions_source_chk'
      `);
      expect(rows).toHaveLength(1);
      for (const s of [
        "viewer",
        "batch",
        "group",
        "sdk",
        "inbox",
        "backfill",
      ]) {
        expect(rows[0]!.def).toContain(`'${s}'`);
      }
    });

    it("uses the specified FK delete rules per column", async () => {
      const rows = await db.execute<{
        column_name: string;
        delete_rule: string;
      }>(sql`
        SELECT kcu.column_name, rc.delete_rule
        FROM information_schema.referential_constraints rc
        JOIN information_schema.key_column_usage kcu
          ON kcu.constraint_name = rc.constraint_name
         AND kcu.constraint_schema = rc.constraint_schema
        WHERE kcu.table_name = 'checkpoint_decisions'
      `);
      const rule = Object.fromEntries(
        rows.map((r) => [r.column_name, r.delete_rule]),
      );
      expect(rule).toEqual({
        project_id: "CASCADE",
        run_id: "CASCADE",
        screenshot_id: "CASCADE",
        actor_id: "SET NULL",
        reverted_by: "SET NULL",
      });
    });
  });

  describe("checkpoint_decisions behaviour", () => {
    it("rejects a second active decision for one screenshot (23505)", async () => {
      const { runId, shots } = await seedRun(1);
      await db.insert(checkpointDecisions).values(decision(runId, shots[0]!));
      await expectSqlState(
        () =>
          db
            .insert(checkpointDecisions)
            .values(decision(runId, shots[0]!, { decision: "rejected" })),
        "23505",
      );
    });

    it("allows a new active decision once the previous one is reverted", async () => {
      const { runId, shots } = await seedRun(1);
      const [first] = await db
        .insert(checkpointDecisions)
        .values(decision(runId, shots[0]!))
        .returning();
      await db
        .update(checkpointDecisions)
        .set({ revertedAt: new Date(), revertedBy: actorId })
        .where(eq(checkpointDecisions.id, first!.id));

      await db
        .insert(checkpointDecisions)
        .values(decision(runId, shots[0]!, { decision: "rejected" }));

      const rows = await db
        .select()
        .from(checkpointDecisions)
        .where(eq(checkpointDecisions.screenshotId, shots[0]!));
      expect(rows).toHaveLength(2);
      expect(rows.filter((r) => r.revertedAt === null)).toHaveLength(1);
    });

    it("allows active decisions on different screenshots of one run", async () => {
      const { runId, shots } = await seedRun(2);
      await db
        .insert(checkpointDecisions)
        .values([decision(runId, shots[0]!), decision(runId, shots[1]!)]);
      const rows = await db
        .select()
        .from(checkpointDecisions)
        .where(eq(checkpointDecisions.runId, runId));
      expect(rows).toHaveLength(2);
    });

    it("rejects an invalid source (23514)", async () => {
      const { runId, shots } = await seedRun(1);
      await expectSqlState(
        () =>
          db.execute(sql`
            INSERT INTO checkpoint_decisions
              (project_id, run_id, screenshot_id, action_id, decision, source)
            VALUES
              (${projectId}, ${runId}, ${shots[0]!}, ${randomUUID()},
               'approved', 'carrier-pigeon')
          `),
        "23514",
      );
    });

    it("accepts every documented source", async () => {
      const sources = [
        "viewer",
        "batch",
        "group",
        "sdk",
        "inbox",
        "backfill",
      ] as const;
      const { runId, shots } = await seedRun(sources.length);
      await db
        .insert(checkpointDecisions)
        .values(
          sources.map((source, i) =>
            decision(runId, shots[i]!, { source, actorId: null }),
          ),
        );
      const rows = await db
        .select({ source: checkpointDecisions.source })
        .from(checkpointDecisions)
        .where(eq(checkpointDecisions.runId, runId));
      expect(rows.map((r) => r.source).sort()).toEqual([...sources].sort());
    });

    it("stores a NULL before snapshot (not undoable) and a jsonb one", async () => {
      const { runId, shots } = await seedRun(2);
      const snapshot = { baseline: null, variation: null };
      await db
        .insert(checkpointDecisions)
        .values([
          decision(runId, shots[0]!, { before: null }),
          decision(runId, shots[1]!, { before: snapshot }),
        ]);
      const rows = await db
        .select({
          s: checkpointDecisions.screenshotId,
          b: checkpointDecisions.before,
        })
        .from(checkpointDecisions)
        .where(eq(checkpointDecisions.runId, runId));
      expect(rows.find((r) => r.s === shots[0])?.b).toBeNull();
      expect(rows.find((r) => r.s === shots[1])?.b).toEqual(snapshot);
    });

    it("orders created_at with microsecond resolution inside one transaction", async () => {
      const { runId, shots } = await seedRun(3);
      await db.transaction(async (tx) => {
        for (const s of shots) {
          await tx.insert(checkpointDecisions).values(decision(runId, s));
        }
      });
      // now() would stamp every row of the transaction identically; with
      // clock_timestamp() each insert gets its own instant. Assert it
      // server-side: a JS Date has only millisecond precision, so three
      // inserts landing in one millisecond would look identical there.
      const distinct = await db.execute<{ n: number }>(sql`
        SELECT count(DISTINCT created_at)::int AS n FROM checkpoint_decisions
        WHERE run_id = ${runId}
      `);
      expect(distinct[0]?.n).toBe(3);
      // And the insertion order is preserved at microsecond resolution.
      const ordered = await db.execute<{ screenshot_id: string }>(sql`
        SELECT screenshot_id FROM checkpoint_decisions
        WHERE run_id = ${runId} ORDER BY created_at ASC
      `);
      expect(ordered.map((r) => r.screenshot_id)).toEqual(shots);
    });

    it("sets actor_id and reverted_by to NULL when the user is deleted", async () => {
      const [u] = await db
        .insert(users)
        .values({
          email: `review-model-gone-${randomUUID()}@t.example`,
          hashedPassword: "x",
          firstName: "gone",
          lastName: "gone",
          role: "editor",
        })
        .returning();
      userIds.push(u!.id);
      const { runId, shots } = await seedRun(1);
      const [d] = await db
        .insert(checkpointDecisions)
        .values(
          decision(runId, shots[0]!, {
            actorId: u!.id,
            revertedAt: new Date(),
            revertedBy: u!.id,
          }),
        )
        .returning();

      await db.delete(users).where(eq(users.id, u!.id));

      const [after] = await db
        .select()
        .from(checkpointDecisions)
        .where(eq(checkpointDecisions.id, d!.id));
      expect(after).toBeDefined();
      expect(after?.actorId).toBeNull();
      expect(after?.revertedBy).toBeNull();
    });

    it("cascades when the screenshot is deleted", async () => {
      const { runId, shots } = await seedRun(1);
      await db.insert(checkpointDecisions).values(decision(runId, shots[0]!));
      await db.delete(screenshots).where(eq(screenshots.id, shots[0]!));
      const rows = await db
        .select()
        .from(checkpointDecisions)
        .where(eq(checkpointDecisions.runId, runId));
      expect(rows).toHaveLength(0);
    });

    it("cascades when the run is deleted", async () => {
      const { runId, shots } = await seedRun(1);
      await db.insert(checkpointDecisions).values(decision(runId, shots[0]!));
      await db.delete(testRuns).where(eq(testRuns.id, runId));
      const rows = await db
        .select()
        .from(checkpointDecisions)
        .where(eq(checkpointDecisions.screenshotId, shots[0]!));
      expect(rows).toHaveLength(0);
    });
  });
});
