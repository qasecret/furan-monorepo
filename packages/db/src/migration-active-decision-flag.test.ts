import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
 * Migration `0040_active_decision_flag` (ADR-074): `screenshots.
 * has_active_decision`, true exactly when the step has a `checkpoint_decisions`
 * row with `reverted_at IS NULL`; the trigger on `checkpoint_decisions` that is
 * its only maintainer; the backfill, under a SHARE lock on
 * `checkpoint_decisions` and retried after a deadlock; and the partial indexes
 * and statistics.
 *
 * Like the other data-migration tests, this seeds rows on the already-migrated
 * database, executes the migration file from disk and asserts. The file is
 * global, so everything is scoped to this test's own project.
 *
 * Skipped when `DATABASE_URL` is unset, like the other migration tests.
 */
const RUN_INTEGRATION = !!process.env.DATABASE_URL;

const MIGRATION_SQL = RUN_INTEGRATION
  ? readFileSync(
      fileURLToPath(
        new URL("../migrations/0040_active_decision_flag.sql", import.meta.url),
      ),
      "utf8",
    )
  : "";

describe.runIf(RUN_INTEGRATION)("0040_active_decision_flag migration", () => {
  let db: DB;
  let close: () => Promise<void>;

  const tag = randomUUID().slice(0, 8);
  let projectId: string;
  let buildId: string;
  let userId: string;

  /** The migration file's statements, split as drizzle's migrator does. */
  const statements = (): string[] =>
    MIGRATION_SQL.split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

  /** The migration file, executed statement by statement. */
  async function runMigration(): Promise<void> {
    for (const stmt of statements()) {
      await db.execute(sql.raw(stmt));
    }
  }

  async function seedRun(label: string): Promise<string> {
    const [r] = await db
      .insert(testRuns)
      .values({
        buildId,
        projectId,
        name: `${label}-${tag}`,
        status: "unresolved",
        branchName: "main",
      })
      .returning({ id: testRuns.id });
    return r!.id;
  }

  async function seedStep(runId: string, name: string): Promise<string> {
    const [v] = await db
      .insert(testVariations)
      .values({ projectId, name: `${name}-${tag}`, branchName: "main" })
      .returning({ id: testVariations.id });
    const [s] = await db
      .insert(screenshots)
      .values({
        runId,
        projectId,
        testVariationId: v!.id,
        name,
        viewport: "1280x720",
        browser: "chromium",
        imageKey: `img-${randomUUID()}`,
        verdict: "unresolved",
        verdictAt: new Date(),
      })
      .returning({ id: screenshots.id });
    return s!.id;
  }

  /** A decision on `screenshotId`; active unless `reverted`. Returns its id. */
  async function seedDecision(
    runId: string,
    screenshotId: string,
    opts: { reverted?: boolean } = {},
  ): Promise<string> {
    const [d] = await db
      .insert(checkpointDecisions)
      .values({
        projectId,
        runId,
        screenshotId,
        actionId: randomUUID(),
        decision: "approved",
        actorId: userId,
        source: "viewer",
        revertedAt: opts.reverted ? new Date() : null,
        revertedBy: opts.reverted ? userId : null,
      })
      .returning({ id: checkpointDecisions.id });
    return d!.id;
  }

  async function flagsOf(
    ids: Record<string, string>,
  ): Promise<Record<string, boolean | undefined>> {
    const rows = await db.execute<{ id: string; flag: boolean }>(
      sql`select id, has_active_decision as flag from screenshots
          where id in (${sql.join(
            Object.values(ids).map((id) => sql`${id}`),
            sql`, `,
          )})`,
    );
    const byId = new Map(rows.map((r) => [r.id, r.flag]));
    return Object.fromEntries(
      Object.entries(ids).map(([name, id]) => [name, byId.get(id)]),
    );
  }

  /** Each row's `xmin`: it changes whenever the row is rewritten. */
  async function versionsOf(ids: string[]): Promise<Record<string, string>> {
    const rows = await db.execute<{ id: string; xmin: string }>(
      sql`select id, xmin::text as xmin from screenshots
          where id in (${sql.join(
            ids.map((id) => sql`${id}`),
            sql`, `,
          )})`,
    );
    return Object.fromEntries(rows.map((r) => [r.id, r.xmin]));
  }

  beforeAll(async () => {
    const created = createDb();
    db = created.db;
    close = created.close;

    // Applied once first, so the column exists for the seed below whatever
    // state the test database is in.
    await runMigration();

    const [u] = await db
      .insert(users)
      .values({
        email: `active-flag-${tag}@t.example`,
        hashedPassword: "x",
        firstName: "Active",
        lastName: "Flag",
        role: "editor",
      })
      .returning({ id: users.id });
    userId = u!.id;
    const [p] = await db
      .insert(projects)
      .values({ name: `active-flag-${tag}` })
      .returning({ id: projects.id });
    projectId = p!.id;
    const [b] = await db
      .insert(builds)
      .values({ projectId, branchName: "main", userId })
      .returning({ id: builds.id });
    buildId = b!.id;
  });

  afterAll(async () => {
    // projects cascade to builds / runs / screenshots / variations / decisions.
    if (projectId) await db.delete(projects).where(eq(projects.id, projectId));
    if (userId) await db.delete(users).where(eq(users.id, userId));
    await close();
  });

  it("the migration backfills has_active_decision from active decisions and is idempotent", async () => {
    const runId = await seedRun("backfill");
    const ids = {
      active: await seedStep(runId, "active"),
      reverted: await seedStep(runId, "reverted"),
      none: await seedStep(runId, "none"),
      redecided: await seedStep(runId, "redecided"),
    };
    await seedDecision(runId, ids.active);
    await seedDecision(runId, ids.reverted, { reverted: true });
    await seedDecision(runId, ids.redecided, { reverted: true });
    await seedDecision(runId, ids.redecided);

    // Legacy shape: before the migration every step reads the column's
    // default, false. `none` is also given a stale true, which the backfill
    // must correct the other way.
    await db
      .update(screenshots)
      .set({ hasActiveDecision: false })
      .where(inArray(screenshots.id, Object.values(ids)));
    await db
      .update(screenshots)
      .set({ hasActiveDecision: true })
      .where(eq(screenshots.id, ids.none));
    expect(await flagsOf(ids)).toEqual({
      active: false,
      reverted: false,
      none: true,
      redecided: false,
    });

    await runMigration();
    const expected = {
      active: true,
      reverted: false,
      none: false,
      redecided: true,
    };
    expect(await flagsOf(ids)).toEqual(expected);

    // Again: nothing changes, and no row is even rewritten.
    const before = await versionsOf(Object.values(ids));
    await runMigration();
    expect(await flagsOf(ids)).toEqual(expected);
    expect(await versionsOf(Object.values(ids))).toEqual(before);
  });

  it("creates the column, an invoker-rights trigger, the indexes and the statistics, once", async () => {
    await runMigration();

    const [column] = await db.execute<{
      data_type: string;
      is_nullable: string;
      column_default: string;
    }>(
      sql`select data_type, is_nullable, column_default from information_schema.columns
          where table_name = 'screenshots' and column_name = 'has_active_decision'`,
    );
    expect(column).toEqual({
      data_type: "boolean",
      is_nullable: "NO",
      column_default: "false",
    });

    const triggers = await db.execute<{ def: string }>(
      sql`select pg_get_triggerdef(t.oid) as def from pg_trigger t
          where t.tgrelid = 'checkpoint_decisions'::regclass
            and t.tgname = 'checkpoint_decisions_sync_active_flag'`,
    );
    expect(triggers).toHaveLength(1);
    expect(triggers[0]!.def).toContain(
      "AFTER INSERT OR DELETE OR UPDATE OF reverted_at, screenshot_id",
    );
    expect(triggers[0]!.def).toContain("FOR EACH ROW");

    const [fn] = await db.execute<{ definer: boolean }>(
      sql`select prosecdef as definer from pg_proc
          where proname = 'checkpoint_decisions_sync_active_flag'`,
    );
    // Invoker rights: the trigger's write is subject to the caller's RLS.
    expect(fn).toEqual({ definer: false });

    const open = await db.execute<{ def: string }>(
      sql`select indexdef as def from pg_indexes
          where tablename = 'screenshots' and indexname = 'screenshots_pending_open_idx'`,
    );
    expect(open).toHaveLength(1);
    expect(open[0]!.def).toContain("(project_id, run_id, created_at, id)");
    expect(open[0]!.def).toMatch(
      /WHERE \(\(verdict = ANY \(ARRAY\['new'.*'unresolved'.*\]\)\) AND \(NOT has_active_decision\)\)/,
    );

    const undiffed = await db.execute<{ def: string }>(
      sql`select indexdef as def from pg_indexes
          where tablename = 'screenshots' and indexname = 'screenshots_undiffed_idx'`,
    );
    expect(undiffed).toHaveLength(1);
    expect(undiffed[0]!.def).toContain("(run_id) WHERE (verdict IS NULL)");

    const stats = await db.execute<{ kinds: string; columns: string }>(
      sql`select stxkind::text as kinds,
                 (select string_agg(a.attname, ',' order by a.attname)
                  from pg_attribute a
                  where a.attrelid = s.stxrelid and a.attnum = any(s.stxkeys)) as columns
          from pg_statistic_ext s
          where s.stxname = 'screenshots_verdict_decision_stats'`,
    );
    expect(stats).toEqual([
      { kinds: "{m}", columns: "has_active_decision,verdict" },
    ]);
  });

  it("the trigger follows raw writes: an insert already reverted, a revert, a re-insert and a delete", async () => {
    const runId = await seedRun("raw");
    const step = await seedStep(runId, "raw");
    const flag = async () => (await flagsOf({ step })).step;

    await seedDecision(runId, step, { reverted: true });
    expect(await flag()).toBe(false);

    const active = await seedDecision(runId, step);
    expect(await flag()).toBe(true);

    await db
      .update(checkpointDecisions)
      .set({ revertedAt: new Date(), revertedBy: userId })
      .where(eq(checkpointDecisions.id, active));
    expect(await flag()).toBe(false);

    const again = await seedDecision(runId, step);
    expect(await flag()).toBe(true);

    await db
      .delete(checkpointDecisions)
      .where(eq(checkpointDecisions.id, again));
    expect(await flag()).toBe(false);
  });

  it("a run deleted with its decisions leaves no error and no orphan", async () => {
    const doomed = await seedRun("doomed");
    const kept = await seedRun("kept");
    const doomedSteps = [
      await seedStep(doomed, "doomed-a"),
      await seedStep(doomed, "doomed-b"),
    ];
    await seedDecision(doomed, doomedSteps[0]!);
    await seedDecision(doomed, doomedSteps[1]!, { reverted: true });
    const keptStep = await seedStep(kept, "kept");
    await seedDecision(kept, keptStep);

    // ON DELETE CASCADE removes the run's steps and decisions in the same
    // statement; the DELETE trigger fires for each decision, whether or not
    // its step is already gone.
    await db.delete(testRuns).where(eq(testRuns.id, doomed));

    expect(
      await db
        .select({ id: screenshots.id })
        .from(screenshots)
        .where(eq(screenshots.runId, doomed)),
    ).toEqual([]);
    expect(
      await db
        .select({ id: checkpointDecisions.id })
        .from(checkpointDecisions)
        .where(inArray(checkpointDecisions.screenshotId, doomedSteps)),
    ).toEqual([]);
    expect(await flagsOf({ keptStep })).toEqual({ keptStep: true });
  });

  it("re-pointing a decision to another step updates both steps' flags", async () => {
    const runId = await seedRun("repoint");
    const from = await seedStep(runId, "repoint-from");
    const to = await seedStep(runId, "repoint-to");
    const decision = await seedDecision(runId, from);
    expect(await flagsOf({ from, to })).toEqual({ from: true, to: false });

    await db
      .update(checkpointDecisions)
      .set({ screenshotId: to })
      .where(eq(checkpointDecisions.id, decision));
    expect(await flagsOf({ from, to })).toEqual({ from: false, to: true });
  });

  /**
   * The race the backfill's SHARE lock closes. Under an autocommit runner
   * (`psql -f`), an undo that commits while the backfill's UPDATE runs finds
   * the step's flag still `false` (the legacy value) and writes nothing; the
   * UPDATE, working from a snapshot in which the decision was still active,
   * then sets `true`: a pending step hidden.
   *
   * Made deterministic with an undo held open on a second connection (B)
   * while the backfill runs on a third (A), both in the READ COMMITTED mode
   * both runners use:
   * - the bare UPDATE, without the lock, does not wait for B and leaves the
   *   stale `true` once B commits (the race is real);
   * - the migration's locked block waits for B's write (its SHARE lock request
   *   shows in `pg_locks`, not granted), then sees the undo and leaves `false`.
   */
  it("the backfill takes a SHARE lock on checkpoint_decisions, so an undo committing meanwhile leaves no stale true", async () => {
    // The backfill statement, found by what it does (not by its lock), so
    // that dropping the lock fails the behaviour below rather than the lookup.
    const block = statements().find((s) =>
      s.includes('UPDATE "screenshots" AS s'),
    );
    expect(block).toBeDefined();
    const bare = /UPDATE "screenshots" AS s[\s\S]*?;/.exec(block!)?.[0];
    expect(bare).toBeDefined();

    const a = createDb();
    const b = createDb();
    // Undos still held open when the test fails, released before closing B.
    const held: Array<() => Promise<void>> = [];
    try {
      /** A step whose decision is active but whose flag is still the legacy false. */
      async function legacyActive(label: string) {
        const runId = await seedRun(label);
        const step = await seedStep(runId, label);
        const decision = await seedDecision(runId, step);
        await db
          .update(screenshots)
          .set({ hasActiveDecision: false })
          .where(eq(screenshots.id, step));
        return { step, decision };
      }

      /** An undo of `decision` on B, written but not committed until `commit`. */
      async function holdUndo(decision: string) {
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        let written!: () => void;
        const isWritten = new Promise<void>((r) => (written = r));
        const done = b.db.transaction(async (tx) => {
          await tx
            .update(checkpointDecisions)
            .set({ revertedAt: new Date(), revertedBy: userId })
            .where(eq(checkpointDecisions.id, decision));
          written();
          await gate;
        });
        await Promise.race([isWritten, done]);
        const commit = async () => {
          held.splice(held.indexOf(commit), 1);
          release();
          await done;
        };
        held.push(commit);
        return commit;
      }

      const waitingShareLocks = async () => {
        const [row] = await db.execute<{ n: number }>(
          sql`select count(*)::int as n from pg_locks
              where locktype = 'relation'
                and relation = 'checkpoint_decisions'::regclass
                and mode = 'ShareLock' and not granted`,
        );
        return Number(row!.n);
      };

      // Without the lock: the race reproduces.
      const control = await legacyActive("race-control");
      const commitControl = await holdUndo(control.decision);
      await a.db.execute(sql.raw(bare!));
      await commitControl();
      expect(await flagsOf({ step: control.step })).toEqual({ step: true });

      // The migration's block: it waits for the undo, then gets it right.
      const locked = await legacyActive("race-locked");
      const commitLocked = await holdUndo(locked.decision);
      let finished = false;
      const backfill = a.db.execute(sql.raw(block!)).then(() => {
        finished = true;
      });
      const deadline = Date.now() + 5_000;
      while ((await waitingShareLocks()) === 0) {
        if (finished || Date.now() > deadline) {
          throw new Error("the backfill did not wait for the SHARE lock");
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(finished).toBe(false);
      await commitLocked();
      await backfill;
      expect(await flagsOf({ step: locked.step })).toEqual({ step: false });
      // The block also corrected the control's stale flag.
      expect(await flagsOf({ step: control.step })).toEqual({ step: false });
    } finally {
      for (const commit of [...held]) await commit().catch(() => {});
      await a.close();
      await b.close();
    }
  });

  /**
   * The deadlock the backfill's retry survives. Under an autocommit runner a
   * decision write that has already locked a step row (an undo of a
   * re-diffed approve clears the step's verdict before stamping its decision;
   * a run deletion's cascade can reach its steps before their decisions) then
   * waits
   * for the backfill's SHARE lock, while the backfill's UPDATE waits for that
   * step row. After `deadlock_timeout` (1 s by default) Postgres aborts the
   * one whose wait began first: here, deterministically, the backfill (it
   * waits for the step 300 ms before the undo stamps).
   *
   * Driven on three connections in the READ COMMITTED mode both runners use:
   * the undo on B locks its step and is held; the backfill on A takes SHARE
   * and waits for that step; then the undo stamps its decision, closing the
   * cycle:
   * - the backfill without the retry fails the migration with
   *   `deadlock_detected` (the deadlock is real);
   * - the migration's block rolls the attempt back (the undo then stamps its
   *   decision), waits again for SHARE behind the still-open undo, and once
   *   it commits ends exact: the undone step's flag is `false`.
   */
  it("the backfill retries after a deadlock and still ends exact", async () => {
    const block = statements().find((s) =>
      s.includes('UPDATE "screenshots" AS s'),
    );
    expect(block).toBeDefined();
    expect(block).toMatch(
      /LOOP[\s\S]*EXCEPTION WHEN deadlock_detected THEN[\s\S]*END LOOP;/,
    );
    const lock = /LOCK TABLE "checkpoint_decisions" IN SHARE MODE;/.exec(
      block!,
    )?.[0];
    const update = /UPDATE "screenshots" AS s[\s\S]*?;/.exec(block!)?.[0];
    expect(lock).toBeDefined();
    expect(update).toBeDefined();
    // The same lock and UPDATE, without the retry.
    const once = `DO $$ BEGIN ${lock} ${update} END $$;`;

    const a = createDb();
    const b = createDb();
    const held: Array<() => Promise<void>> = [];
    try {
      /** A step whose decision is active but whose flag is still the legacy false. */
      async function legacyActive(label: string) {
        const runId = await seedRun(label);
        const step = await seedStep(runId, label);
        const decision = await seedDecision(runId, step);
        await db
          .update(screenshots)
          .set({ hasActiveDecision: false })
          .where(eq(screenshots.id, step));
        return { step, decision };
      }

      /** Resolves when `p` settles, or throws after `ms`. */
      async function within<T>(p: Promise<T>, ms: number, what: string) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            p,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error(`timed out: ${what}`)),
                ms,
              );
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      }

      /**
       * An undo of a re-diffed approve on B: it clears the step's verdict
       * (locking the step row) and is held; `stamp()` then reverts the
       * decision and resolves once that write is through; `commit()` commits.
       * `pid` is B's backend, the one the backfill waits for.
       */
      async function holdUndo(step: string, decision: string) {
        let toStamp!: () => void;
        const stampGate = new Promise<void>((r) => (toStamp = r));
        let toCommit!: () => void;
        const commitGate = new Promise<void>((r) => (toCommit = r));
        let locked!: () => void;
        const isLocked = new Promise<void>((r) => (locked = r));
        let stamped!: () => void;
        const isStamped = new Promise<void>((r) => (stamped = r));
        let pid = 0;
        const done = b.db.transaction(async (tx) => {
          const [me] = await tx.execute<{ pid: number }>(
            sql`select pg_backend_pid() as pid`,
          );
          pid = Number(me!.pid);
          await tx
            .update(screenshots)
            .set({ verdict: null, verdictAt: null })
            .where(eq(screenshots.id, step));
          locked();
          await stampGate;
          await tx
            .update(checkpointDecisions)
            .set({ revertedAt: new Date(), revertedBy: userId })
            .where(eq(checkpointDecisions.id, decision));
          stamped();
          await commitGate;
        });
        await Promise.race([isLocked, done]);
        const commit = async () => {
          held.splice(held.indexOf(commit), 1);
          toStamp();
          toCommit();
          await done;
        };
        held.push(commit);
        return {
          pid,
          stamp: async () => {
            // Each waiter checks for a deadlock once, `deadlock_timeout` after
            // its own wait began, and the first to check is the victim. The
            // backfill is already waiting; a clear head start keeps it first
            // whatever the timers' jitter.
            await new Promise((r) => setTimeout(r, 300));
            toStamp();
            await within(
              Promise.race([isStamped, done]),
              10_000,
              "the undo's stamp",
            );
          },
          commit,
        };
      }

      /**
       * Whether a backend (A's backfill: nothing else here waits for B) is
       * waiting for B's `wait` lock: its step row or a table.
       */
      async function waitsFor(
        blocker: number,
        wait: "transactionid" | "relation",
      ) {
        const [row] = await db.execute<{ n: number }>(
          sql`select count(*)::int as n from pg_stat_activity
              where wait_event_type = 'Lock' and wait_event = ${wait}
                and ${blocker}::int = any(pg_blocking_pids(pid))`,
        );
        return Number(row!.n) > 0;
      }

      async function until(cond: () => Promise<boolean>, what: string) {
        const deadline = Date.now() + 5_000;
        while (!(await cond())) {
          if (Date.now() > deadline) throw new Error(`never: ${what}`);
          await new Promise((r) => setTimeout(r, 20));
        }
      }

      // Without the retry: the deadlock fails the backfill.
      const control = await legacyActive("deadlock-control");
      const controlUndo = await holdUndo(control.step, control.decision);
      const failed = a.db.execute(sql.raw(once)).then(
        () => null,
        (e: unknown) => e,
      );
      await until(
        () => waitsFor(controlUndo.pid, "transactionid"),
        "the bare backfill waits for the locked step",
      );
      await controlUndo.stamp();
      const error = (await within(failed, 10_000, "the bare backfill")) as {
        code?: string;
        cause?: { code?: string };
      } | null;
      expect(error?.code ?? error?.cause?.code).toBe("40P01");
      await controlUndo.commit();

      // The migration's block: the attempt rolls back, the undo goes
      // through, and the retry ends exact.
      const subject = await legacyActive("deadlock-retry");
      const undo = await holdUndo(subject.step, subject.decision);
      let finished = false;
      const backfill = a.db.execute(sql.raw(block!)).then(() => {
        finished = true;
      });
      await until(
        () => waitsFor(undo.pid, "transactionid"),
        "the backfill waits for the locked step",
      );
      // The cycle: the stamp waits for SHARE until the backfill's attempt
      // is chosen as the victim and rolled back.
      await undo.stamp();
      expect(finished).toBe(false);
      // The retry waits for SHARE again, behind the still-open undo.
      await until(
        () => waitsFor(undo.pid, "relation"),
        "the retry waits for SHARE behind the undo",
      );
      expect(finished).toBe(false);
      await undo.commit();
      await within(backfill, 10_000, "the retried backfill");
      expect(await flagsOf({ step: subject.step })).toEqual({ step: false });
      // The control's undo committed too: its flag is right as well.
      expect(await flagsOf({ step: control.step })).toEqual({ step: false });
    } finally {
      for (const commit of [...held]) await commit().catch(() => {});
      await a.close();
      await b.close();
    }
  });
});
