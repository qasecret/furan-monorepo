import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { is, sql, SQL } from "drizzle-orm";
import {
  getTableConfig,
  PgDialect,
  type IndexedColumn,
  type PgTable,
} from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  baselines,
  builds,
  checkpointDecisions,
  COUNTERS_BACKFILL_SQL,
  createDb,
  eq,
  projects,
  screenshots,
  testRuns,
  testVariations,
  users,
  type DB,
} from "./index.js";

/**
 * Migration `0043_server_reads` (spec 2026-10-27 speed-at-scale server reads
 * §2): the stored pending counters on `test_runs` with their backfill (§3.1),
 * which doubles as their repair; the slice-3 read indexes, the reconciler's
 * index and the three indexes they supersede; and the two schema drift fixes.
 *
 * Like the other migration tests, it seeds rows on the already-migrated test
 * database, executes the file from disk and asserts; executing it again is the
 * "re-apply" case. The backfill is global, so assertions are scoped to this
 * test's own project.
 *
 * The database tests are skipped when `DATABASE_URL` is unset, like the other
 * migration tests. The check that the exported backfill is the file's own
 * statement needs no database.
 */
const RUN_INTEGRATION = !!process.env.DATABASE_URL;

const MIGRATION_SQL = readFileSync(
  fileURLToPath(
    new URL("../migrations/0043_server_reads.sql", import.meta.url),
  ),
  "utf8",
);

const STATEMENTS = MIGRATION_SQL.split("--> statement-breakpoint")
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

/** A statement without the `--` comment lines that lead it. */
function withoutLeadingComments(statement: string): string {
  const lines = statement.split("\n");
  while (lines.length > 0 && /^\s*(--.*)?$/.test(lines[0]!)) lines.shift();
  return lines.join("\n");
}

/** The ten slice-3 indexes, exactly as Postgres prints them. */
const SLICE3_INDEXES: Record<string, string> = {
  test_runs_pending_idx:
    "CREATE INDEX test_runs_pending_idx ON public.test_runs USING btree (project_id, build_id) WHERE (pending_steps > 0)",
  test_runs_build_created_idx:
    "CREATE INDEX test_runs_build_created_idx ON public.test_runs USING btree (build_id, created_at, id)",
  test_runs_build_status_idx:
    "CREATE INDEX test_runs_build_status_idx ON public.test_runs USING btree (build_id, status) INCLUDE (name)",
  screenshots_variation_created_idx:
    "CREATE INDEX screenshots_variation_created_idx ON public.screenshots USING btree (test_variation_id, created_at DESC, id DESC)",
  baselines_variation_branch_created_idx:
    "CREATE INDEX baselines_variation_branch_created_idx ON public.baselines USING btree (test_variation_id, branch_name, created_at DESC, id DESC)",
  screenshots_image_key_idx:
    "CREATE INDEX screenshots_image_key_idx ON public.screenshots USING btree (image_key)",
  screenshots_dom_key_idx:
    "CREATE INDEX screenshots_dom_key_idx ON public.screenshots USING btree (dom_key) WHERE (dom_key IS NOT NULL)",
  screenshots_element_map_key_idx:
    "CREATE INDEX screenshots_element_map_key_idx ON public.screenshots USING btree (element_map_key) WHERE (element_map_key IS NOT NULL)",
  screenshots_diff_image_key_idx:
    "CREATE INDEX screenshots_diff_image_key_idx ON public.screenshots USING btree (diff_image_key) WHERE (diff_image_key IS NOT NULL)",
  test_runs_diff_name_idx:
    "CREATE INDEX test_runs_diff_name_idx ON public.test_runs USING btree (diff_name) WHERE (diff_name IS NOT NULL)",
};

/** The diff-worker reconciler's empty-run scan (beyond spec §2). */
const RUNNING_IDX =
  "CREATE INDEX test_runs_running_idx ON public.test_runs USING btree (updated_at) WHERE (status = 'running'::run_status)";

/**
 * The plain single-column indexes 0043 drops, each with the new index whose
 * leading column replaces it.
 */
const SUPERSEDED_INDEXES: Record<string, string> = {
  test_runs_build_id_idx: "test_runs_build_created_idx",
  screenshots_test_variation_id_idx: "screenshots_variation_created_idx",
  baselines_test_variation_id_idx: "baselines_variation_branch_created_idx",
};

/**
 * Indexes that live in migration SQL only, by table: Drizzle's index builder
 * cannot express `INCLUDE (...)` (see the note in `schema/test_runs.ts`).
 */
const SQL_ONLY_INDEXES: Record<string, string[]> = {
  test_runs: ["test_runs_build_status_idx"],
};

/** The definition from ` USING ` on: the same for an index of any name. */
function usingClause(indexdef: string): string {
  return indexdef.slice(indexdef.indexOf(" USING "));
}

describe("0043 backfill constant", () => {
  it("COUNTERS_BACKFILL_SQL is the migration's backfill statement, verbatim", () => {
    expect(MIGRATION_SQL).toContain(COUNTERS_BACKFILL_SQL);
    // A statement of its own, not part of a larger one.
    expect(STATEMENTS.map(withoutLeadingComments)).toContain(
      COUNTERS_BACKFILL_SQL,
    );
  });
});

describe.runIf(RUN_INTEGRATION)("0043_server_reads migration", () => {
  let db: DB;
  let close: () => Promise<void>;

  const tag = randomUUID().slice(0, 8);
  let projectId: string;
  let buildId: string;
  let userId: string;

  /**
   * The migration file, split and executed as drizzle's migrator does (in one
   * transaction), without the "already exists, skipping" notices of a re-run.
   */
  async function runMigration(): Promise<void> {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL client_min_messages = warning`);
      for (const stmt of STATEMENTS) {
        await tx.execute(sql.raw(stmt));
      }
    });
  }

  async function seedRun(
    label: string,
    opts: {
      status: NonNullable<(typeof testRuns.$inferInsert)["status"]>;
      override?: "passed" | "failed";
    },
  ): Promise<string> {
    const [r] = await db
      .insert(testRuns)
      .values({
        buildId,
        projectId,
        name: `${label}-${tag}`,
        status: opts.status,
        statusOverride: opts.override ?? null,
        branchName: "main",
      })
      .returning({ id: testRuns.id });
    return r!.id;
  }

  async function seedStep(
    runId: string,
    name: string,
    opts: {
      verdict: "new" | "passed" | "unresolved" | null;
      diffFailed?: boolean;
    },
  ): Promise<string> {
    // Step names repeat across runs; each step gets its own variation.
    const [v] = await db
      .insert(testVariations)
      .values({
        projectId,
        name: `${name}-${randomUUID().slice(0, 8)}-${tag}`,
        branchName: "main",
      })
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
        verdict: opts.verdict,
        verdictAt: opts.verdict === null ? null : new Date(),
        diffFailedAt: opts.diffFailed ? new Date() : null,
        diffError: opts.diffFailed ? "engine_error" : null,
      })
      .returning({ id: screenshots.id });
    return s!.id;
  }

  /** A decision on the step; active unless `reverted`. */
  async function seedDecision(
    runId: string,
    screenshotId: string,
    opts: { decision?: "approved" | "rejected"; reverted?: boolean } = {},
  ): Promise<void> {
    await db.insert(checkpointDecisions).values({
      projectId,
      runId,
      screenshotId,
      actionId: randomUUID(),
      decision: opts.decision ?? "approved",
      actorId: userId,
      source: "viewer",
      revertedAt: opts.reverted ? new Date() : null,
      revertedBy: opts.reverted ? userId : null,
    });
  }

  type Counters = { pending: number; failed: number };

  async function countersOf(
    runs: Record<string, string>,
  ): Promise<Record<string, Counters | undefined>> {
    const rows = await db.execute<{
      id: string;
      pending: number;
      failed: number;
    }>(
      sql`select id, pending_steps as pending, failed_steps as failed
          from test_runs
          where id in (${sql.join(
            Object.values(runs).map((id) => sql`${id}`),
            sql`, `,
          )})`,
    );
    const byId = new Map(
      rows.map((r) => [r.id, { pending: r.pending, failed: r.failed }]),
    );
    return Object.fromEntries(
      Object.entries(runs).map(([label, id]) => [label, byId.get(id)]),
    );
  }

  /** Each run's `xmin`: it changes whenever the row is rewritten. */
  async function versionsOf(ids: string[]): Promise<Record<string, string>> {
    const rows = await db.execute<{ id: string; xmin: string }>(
      sql`select id, xmin::text as xmin from test_runs
          where id in (${sql.join(
            ids.map((id) => sql`${id}`),
            sql`, `,
          )})`,
    );
    return Object.fromEntries(rows.map((r) => [r.id, r.xmin]));
  }

  /** Every index of `table` but its primary key, by name. */
  async function indexDefs(table: string): Promise<Map<string, string>> {
    const rows = await db.execute<{ indexname: string; indexdef: string }>(
      sql`select indexname, indexdef from pg_indexes
          where schemaname = 'public' and tablename = ${table}
            and indexname <> ${`${table}_pkey`}`,
    );
    return new Map(rows.map((r) => [r.indexname, r.indexdef]));
  }

  async function slice3Defs(): Promise<Record<string, string | undefined>> {
    const rows = await db.execute<{ indexname: string; indexdef: string }>(
      sql`select indexname, indexdef from pg_indexes
          where schemaname = 'public'
            and indexname in (${sql.join(
              Object.keys(SLICE3_INDEXES).map((n) => sql`${n}`),
              sql`, `,
            )})`,
    );
    const byName = new Map(rows.map((r) => [r.indexname, r.indexdef]));
    return Object.fromEntries(
      Object.keys(SLICE3_INDEXES).map((n) => [n, byName.get(n)]),
    );
  }

  /**
   * Each index the Drizzle schema declares on `table`, as Postgres prints it
   * (from ` USING ` on). Every declaration is rendered the way drizzle-kit
   * renders it and built on a temporary copy of the table, so Postgres
   * normalises it exactly as it normalised the migration's index.
   */
  async function schemaIndexDefs(table: PgTable): Promise<Map<string, string>> {
    const cfg = getTableConfig(table);
    const dialect = new PgDialect();
    const render = (chunk: SQL): string => {
      const q = dialect.sqlToQuery(chunk);
      expect(q.params).toEqual([]);
      return q.sql.replaceAll(`"${cfg.name}".`, "");
    };
    const column = (c: IndexedColumn | SQL): string => {
      if (is(c, SQL)) return render(c);
      const order = c.indexConfig.order ?? "asc";
      const nulls = c.indexConfig.nulls ?? "last";
      return `"${c.name}"${order === "asc" ? "" : " DESC"}${
        order === "asc" && nulls === "last"
          ? ""
          : ` NULLS ${nulls.toUpperCase()}`
      }`;
    };

    const out = new Map<string, string>();
    const probe = `probe_${cfg.name}`;
    await db.transaction(async (tx) => {
      await tx.execute(
        sql.raw(
          `CREATE TEMP TABLE "${probe}" (LIKE "${cfg.name}") ON COMMIT DROP`,
        ),
      );
      for (const [i, idx] of cfg.indexes.entries()) {
        const c = idx.config;
        const cols = c.columns
          .map((col) => column(col as IndexedColumn | SQL))
          .join(", ");
        const where = c.where ? ` WHERE ${render(c.where)}` : "";
        const name = `${probe}_${i}`;
        await tx.execute(
          sql.raw(
            `CREATE ${c.unique ? "UNIQUE " : ""}INDEX "${name}" ON "${probe}" USING ${c.method ?? "btree"} (${cols})${where}`,
          ),
        );
        const [row] = await tx.execute<{ def: string }>(
          sql`select pg_get_indexdef(${name}::regclass) as def`,
        );
        out.set(c.name!, usingClause(row!.def));
      }
    });
    return out;
  }

  beforeAll(async () => {
    const created = createDb();
    db = created.db;
    close = created.close;

    // Applied once first, so the columns exist for the seeds below whatever
    // state the test database is in.
    await runMigration();

    const [u] = await db
      .insert(users)
      .values({
        email: `server-reads-${tag}@t.example`,
        hashedPassword: "x",
        firstName: "Server",
        lastName: "Reads",
        role: "editor",
      })
      .returning({ id: users.id });
    userId = u!.id;
    const [p] = await db
      .insert(projects)
      .values({ name: `server-reads-${tag}` })
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

  it("backfills pending_steps and failed_steps by spec §3.1, writing only the runs whose counters change", async () => {
    // A reviewable run: every kind of step.
    const mixed = await seedRun("mixed", { status: "unresolved" });
    await seedStep(mixed, "new", { verdict: "new" }); // pending
    await seedStep(mixed, "unresolved", { verdict: "unresolved" }); // pending
    await seedStep(mixed, "passed", { verdict: "passed" });
    const decided = await seedStep(mixed, "decided", { verdict: "unresolved" });
    await seedDecision(mixed, decided);
    const reverted = await seedStep(mixed, "reverted", {
      verdict: "unresolved",
    });
    await seedDecision(mixed, reverted, { reverted: true }); // pending
    await seedStep(mixed, "failed", {
      verdict: "unresolved",
      diffFailed: true,
    }); // pending, failed
    const failedDecided = await seedStep(mixed, "failed-decided", {
      verdict: "unresolved",
      diffFailed: true,
    });
    await seedDecision(mixed, failedDecided, { decision: "rejected" });

    // Reviewable, whatever the stored rollup says.
    const onlyFailed = await seedRun("only-failed", { status: "unresolved" });
    await seedStep(onlyFailed, "failed", {
      verdict: "unresolved",
      diffFailed: true,
    });
    const fresh = await seedRun("fresh", { status: "new" });
    await seedStep(fresh, "a", { verdict: "new" });
    await seedStep(fresh, "b", { verdict: "new" });
    const rejected = await seedRun("rejected", { status: "failed" });
    const rejectedStep = await seedStep(rejected, "rejected", {
      verdict: "unresolved",
    });
    await seedDecision(rejected, rejectedStep, { decision: "rejected" });
    await seedStep(rejected, "open", { verdict: "new" });
    const resolved = await seedRun("resolved", { status: "passed" });
    await seedStep(resolved, "passed", { verdict: "passed" });
    const approved = await seedStep(resolved, "approved", {
      verdict: "unresolved",
    });
    await seedDecision(resolved, approved);

    // Not reviewable: both counters stay 0.
    const running = await seedRun("running", { status: "running" });
    await seedStep(running, "open", { verdict: "unresolved" });
    const aborted = await seedRun("aborted", { status: "aborted" });
    await seedStep(aborted, "open", {
      verdict: "unresolved",
      diffFailed: true,
    });
    const empty = await seedRun("empty", { status: "empty" });
    await seedStep(empty, "open", { verdict: "new" });
    const overridden = await seedRun("overridden", {
      status: "unresolved",
      override: "passed",
    });
    await seedStep(overridden, "open", {
      verdict: "unresolved",
      diffFailed: true,
    });
    const undiffed = await seedRun("undiffed", { status: "unresolved" });
    await seedStep(undiffed, "open", { verdict: "unresolved" });
    await seedStep(undiffed, "undiffed", { verdict: null });

    const runs = {
      mixed,
      onlyFailed,
      fresh,
      rejected,
      resolved,
      running,
      aborted,
      empty,
      overridden,
      undiffed,
    };
    const zero = { pending: 0, failed: 0 };
    // The columns' default, as on a database that has just added them.
    expect(Object.values(await countersOf(runs))).toEqual(
      Object.values(runs).map(() => zero),
    );
    const untouched = [resolved, running, aborted, empty, overridden, undiffed];
    const before = await versionsOf(untouched);

    await runMigration();

    expect(await countersOf(runs)).toEqual({
      mixed: { pending: 4, failed: 1 },
      onlyFailed: { pending: 1, failed: 1 },
      fresh: { pending: 2, failed: 0 },
      rejected: { pending: 1, failed: 0 },
      resolved: zero,
      running: zero,
      aborted: zero,
      empty: zero,
      overridden: zero,
      undiffed: zero,
    });
    // A run whose counts are both 0 is not even rewritten.
    expect(await versionsOf(untouched)).toEqual(before);
  });

  it("re-running the backfill fixes counters that were wrong in either direction", async () => {
    const pending = await seedRun("repair-pending", { status: "unresolved" });
    await seedStep(pending, "failed", {
      verdict: "unresolved",
      diffFailed: true,
    });
    await seedStep(pending, "new", { verdict: "new" });
    const partly = await seedRun("repair-partly", { status: "unresolved" });
    await seedStep(partly, "failed", {
      verdict: "unresolved",
      diffFailed: true,
    });
    const settled = await seedRun("repair-settled", { status: "passed" });
    await seedStep(settled, "passed", { verdict: "passed" });
    const running = await seedRun("repair-running", { status: "running" });
    await seedStep(running, "open", { verdict: "unresolved" });
    const runs = { pending, partly, settled, running };
    const right = {
      pending: { pending: 2, failed: 1 },
      partly: { pending: 1, failed: 1 },
      settled: { pending: 0, failed: 0 },
      running: { pending: 0, failed: 0 },
    };
    await db.execute(sql.raw(COUNTERS_BACKFILL_SQL));
    expect(await countersOf(runs)).toEqual(right);

    // Stale both ways: too high on runs with nothing pending (one of them not
    // even reviewable), 0 on a run with pending steps, and one counter off.
    const corrupt = async (
      id: string,
      pendingSteps: number,
      failedSteps: number,
    ) =>
      db
        .update(testRuns)
        .set({ pendingSteps, failedSteps })
        .where(eq(testRuns.id, id));
    await corrupt(settled, 5, 3);
    await corrupt(running, 2, 0);
    await corrupt(pending, 0, 0);
    await corrupt(partly, 1, 0);

    const repaired = await db.execute(sql.raw(COUNTERS_BACKFILL_SQL));

    expect(await countersOf(runs)).toEqual(right);
    expect(repaired.count).toBe(4);
  });

  it("re-running it on correct counters changes no row", async () => {
    const pending = await seedRun("rerun-pending", { status: "new" });
    await seedStep(pending, "new", { verdict: "new" });
    await db.execute(sql.raw(COUNTERS_BACKFILL_SQL));

    const again = await db.execute(sql.raw(COUNTERS_BACKFILL_SQL));

    expect(again.count).toBe(0);
    expect(await countersOf({ pending })).toEqual({
      pending: { pending: 1, failed: 0 },
    });
  });

  it("re-applying 0043 is a no-op: the same columns, indexes and counters, and no row rewritten", async () => {
    const pending = await seedRun("reapply-pending", { status: "unresolved" });
    await seedStep(pending, "open", {
      verdict: "unresolved",
      diffFailed: true,
    });
    await seedStep(pending, "new", { verdict: "new" });
    const settled = await seedRun("reapply-settled", { status: "passed" });
    await seedStep(settled, "passed", { verdict: "passed" });
    const runs = { pending, settled };

    await runMigration();
    const counters = await countersOf(runs);
    expect(counters).toEqual({
      pending: { pending: 2, failed: 1 },
      settled: { pending: 0, failed: 0 },
    });
    const versions = await versionsOf(Object.values(runs));
    const tables = ["test_runs", "screenshots", "baselines"] as const;
    const defs = await Promise.all(tables.map((t) => indexDefs(t)));

    await runMigration();

    expect(await countersOf(runs)).toEqual(counters);
    expect(await versionsOf(Object.values(runs))).toEqual(versions);
    expect(await Promise.all(tables.map((t) => indexDefs(t)))).toEqual(defs);
  });

  it("creates every slice-3 index with its exact definition", async () => {
    expect(await slice3Defs()).toEqual(SLICE3_INDEXES);
  });

  it("creates the reconciler's index on running runs", async () => {
    const inDb = await indexDefs("test_runs");
    expect(inDb.get("test_runs_running_idx")).toBe(RUNNING_IDX);
    expect(
      getTableConfig(testRuns).indexes.map((i) => i.config.name),
    ).toContain("test_runs_running_idx");
  });

  it("drops the indexes the new ones supersede, from the database and the schema", async () => {
    for (const table of [testRuns, screenshots, baselines]) {
      const cfg = getTableConfig(table);
      const inDb = await indexDefs(cfg.name);
      const declared = cfg.indexes.map((i) => i.config.name);
      for (const [gone, replacement] of Object.entries(SUPERSEDED_INDEXES)) {
        expect(inDb.has(gone)).toBe(false);
        expect(declared).not.toContain(gone);
        // Its replacement is on the same table, if this is the table.
        if (gone.startsWith(`${cfg.name}_`)) {
          expect(inDb.has(replacement)).toBe(true);
        }
      }
    }
  });

  it("adds pending_steps and failed_steps NOT NULL DEFAULT 0", async () => {
    const columns = await db.execute<{
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string;
    }>(
      sql`select column_name, data_type, is_nullable, column_default
          from information_schema.columns
          where table_schema = 'public' and table_name = 'test_runs'
            and column_name in ('pending_steps', 'failed_steps')
          order by column_name`,
    );
    expect(columns).toEqual([
      {
        column_name: "failed_steps",
        data_type: "integer",
        is_nullable: "NO",
        column_default: "0",
      },
      {
        column_name: "pending_steps",
        data_type: "integer",
        is_nullable: "NO",
        column_default: "0",
      },
    ]);
  });

  it("schema and migrations agree: every index of test_runs, screenshots and baselines, with its definition", async () => {
    for (const table of [testRuns, screenshots, baselines]) {
      const cfg = getTableConfig(table);
      const inDb = await indexDefs(cfg.name);
      const declared = [
        ...cfg.indexes.map((i) => i.config.name!),
        ...cfg.uniqueConstraints.map((u) => u.getName()!),
        ...(SQL_ONLY_INDEXES[cfg.name] ?? []),
      ];
      expect([...inDb.keys()].sort()).toEqual(declared.sort());

      for (const [name, def] of await schemaIndexDefs(table)) {
        expect({ name, def: usingClause(inDb.get(name)!) }).toEqual({
          name,
          def,
        });
      }
    }
  });

  it("schema and migrations agree on the two drift indexes", async () => {
    const declared = getTableConfig(testRuns).indexes.map((i) => i.config.name);
    const inDb = await indexDefs("test_runs");

    // Declared before 0043 but never created, and read by no query: gone from
    // both.
    expect(declared).not.toContain("test_runs_status_created_idx");
    expect(inDb.has("test_runs_status_created_idx")).toBe(false);

    // Created by 0014 (the inbox reads), and now declared too.
    expect(declared).toContain("test_runs_inbox_idx");
    expect(inDb.get("test_runs_inbox_idx")).toBe(
      "CREATE INDEX test_runs_inbox_idx ON public.test_runs USING btree (project_id, status, created_at DESC, id DESC) WHERE (status = ANY (ARRAY['unresolved'::run_status, 'failed'::run_status]))",
    );
  });
});
