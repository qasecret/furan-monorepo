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
 * Migration `0041_active_decision_flag` (ADR-074): `screenshots.
 * has_active_decision`, true exactly when the step has a `checkpoint_decisions`
 * row with `reverted_at IS NULL`; the trigger on `checkpoint_decisions` that is
 * its only maintainer; the backfill; and the partial index of open steps.
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
        new URL("../migrations/0041_active_decision_flag.sql", import.meta.url),
      ),
      "utf8",
    )
  : "";

describe.runIf(RUN_INTEGRATION)("0041_active_decision_flag migration", () => {
  let db: DB;
  let close: () => Promise<void>;

  const tag = randomUUID().slice(0, 8);
  let projectId: string;
  let buildId: string;
  let userId: string;

  /** The migration file, split and executed as drizzle's migrator does. */
  async function runMigration(): Promise<void> {
    const statements = MIGRATION_SQL.split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const stmt of statements) {
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
});
