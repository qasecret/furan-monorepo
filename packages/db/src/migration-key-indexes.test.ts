import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { sql } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDb, screenshots, testRuns, type DB } from "./index.js";

/**
 * Migration `0044_key_indexes_with_project` (speed-at-scale server reads,
 * slice 3, rulings R20 and R21): the storage proxy's six key indexes lead with
 * the key and carry `project_id`, and `test_runs.image_name` gets an index.
 *
 * Like the other migration tests, it executes the file from disk against the
 * already-migrated test database. Applying it again is the "re-apply" case;
 * putting 0043's single-column indexes back first is the "0043 has already
 * built them" case, which is what every database that ran 0043 holds.
 *
 * Skipped when `DATABASE_URL` is unset, like the other migration tests.
 */
const RUN_INTEGRATION = !!process.env.DATABASE_URL;

function statementsOf(file: string): string[] {
  return readFileSync(
    fileURLToPath(new URL(`../migrations/${file}`, import.meta.url)),
    "utf8",
  )
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const MIGRATION_0044 = RUN_INTEGRATION
  ? statementsOf("0044_key_indexes_with_project.sql")
  : [];
const MIGRATION_0043 = RUN_INTEGRATION
  ? statementsOf("0043_server_reads.sql")
  : [];

/** The six key indexes, exactly as Postgres prints them. */
const KEY_INDEXES: Record<string, string> = {
  screenshots_image_key_idx:
    "CREATE INDEX screenshots_image_key_idx ON public.screenshots USING btree (image_key, project_id)",
  screenshots_dom_key_idx:
    "CREATE INDEX screenshots_dom_key_idx ON public.screenshots USING btree (dom_key, project_id) WHERE (dom_key IS NOT NULL)",
  screenshots_element_map_key_idx:
    "CREATE INDEX screenshots_element_map_key_idx ON public.screenshots USING btree (element_map_key, project_id) WHERE (element_map_key IS NOT NULL)",
  screenshots_diff_image_key_idx:
    "CREATE INDEX screenshots_diff_image_key_idx ON public.screenshots USING btree (diff_image_key, project_id) WHERE (diff_image_key IS NOT NULL)",
  test_runs_diff_name_idx:
    "CREATE INDEX test_runs_diff_name_idx ON public.test_runs USING btree (diff_name, project_id) WHERE (diff_name IS NOT NULL)",
  test_runs_image_name_idx:
    "CREATE INDEX test_runs_image_name_idx ON public.test_runs USING btree (image_name, project_id) WHERE (image_name IS NOT NULL)",
};

/** What 0043 built under five of those names: the key alone. */
const KEY_INDEXES_0043: Record<string, string> = {
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

const KEY_INDEX_NAMES = Object.keys(KEY_INDEXES);

/** True for a statement of 0043 that drops or builds one of its key indexes. */
function touchesKey0043Index(statement: string): boolean {
  return Object.keys(KEY_INDEXES_0043).some((n) =>
    statement.includes(`"${n}"`),
  );
}

/** The column each index is led by, and the table it is on. */
const LEADING_COLUMN: Record<string, { table: PgTable; column: string }> = {
  screenshots_image_key_idx: { table: screenshots, column: "image_key" },
  screenshots_dom_key_idx: { table: screenshots, column: "dom_key" },
  screenshots_element_map_key_idx: {
    table: screenshots,
    column: "element_map_key",
  },
  screenshots_diff_image_key_idx: {
    table: screenshots,
    column: "diff_image_key",
  },
  test_runs_diff_name_idx: { table: testRuns, column: "diff_name" },
  test_runs_image_name_idx: { table: testRuns, column: "image_name" },
};

describe.runIf(RUN_INTEGRATION)(
  "0044_key_indexes_with_project migration",
  () => {
    let db: DB;
    let close: () => Promise<void>;

    /** Statements executed as drizzle's migrator does: one transaction. */
    async function run(statements: string[]): Promise<void> {
      await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL client_min_messages = warning`);
        for (const stmt of statements) await tx.execute(sql.raw(stmt));
      });
    }

    /** Every index of `table` but its primary key, by name. */
    async function indexDefs(table: string): Promise<Record<string, string>> {
      const rows = await db.execute<{ indexname: string; indexdef: string }>(
        sql`select indexname, indexdef from pg_indexes
          where schemaname = 'public' and tablename = ${table}
            and indexname <> ${`${table}_pkey`}`,
      );
      return Object.fromEntries(rows.map((r) => [r.indexname, r.indexdef]));
    }

    async function allDefs(): Promise<Record<string, string>> {
      return {
        ...(await indexDefs("screenshots")),
        ...(await indexDefs("test_runs")),
      };
    }

    async function keyDefs(): Promise<Record<string, string | undefined>> {
      const defs = await allDefs();
      return Object.fromEntries(KEY_INDEX_NAMES.map((n) => [n, defs[n]]));
    }

    /**
     * The database as 0043 alone leaves it: the five single-column indexes, and
     * no `test_runs_image_name_idx` (0044 creates it). Built by executing the
     * statements of 0043 that touch those indexes, not by a copy of them.
     */
    async function putBack0043Indexes(): Promise<void> {
      const touching = MIGRATION_0043.filter(touchesKey0043Index);
      // A DROP and a CREATE for each of the five.
      expect(touching).toHaveLength(10);
      await run([
        `DROP INDEX IF EXISTS "test_runs_image_name_idx"`,
        ...touching,
      ]);
    }

    beforeAll(async () => {
      const created = createDb();
      db = created.db;
      close = created.close;
    });

    afterAll(async () => {
      // Leave the database as a migrated one is.
      await run(MIGRATION_0044);
      await close();
    });

    it("builds the six key indexes, each with its exact definition", async () => {
      await run(MIGRATION_0044);
      expect(await keyDefs()).toEqual(KEY_INDEXES);
    });

    it("every index leads with its key and carries the project, in the schema as in the database", async () => {
      await run(MIGRATION_0044);
      for (const [name, { table, column }] of Object.entries(LEADING_COLUMN)) {
        const declared = getTableConfig(table).indexes.find(
          (i) => i.config.name === name,
        );
        expect(declared, name).toBeDefined();
        const cols = declared!.config.columns.map(
          (c) => (c as { name: string }).name,
        );
        expect({ name, cols }).toEqual({ name, cols: [column, "project_id"] });
      }
      expect(await keyDefs()).toEqual(KEY_INDEXES);
    });

    it("replaces the single-column indexes 0043 built, under the same names", async () => {
      await putBack0043Indexes();
      // The starting point is 0043's: five single-column indexes, no sixth.
      expect(await keyDefs()).toEqual({
        ...KEY_INDEXES_0043,
        test_runs_image_name_idx: undefined,
      });

      await run(MIGRATION_0044);

      expect(await keyDefs()).toEqual(KEY_INDEXES);
    });

    it("re-applying it is a no-op: the same six indexes, and no other index touched", async () => {
      await run(MIGRATION_0044);
      const before = await allDefs();

      await run(MIGRATION_0044);
      await run(MIGRATION_0044);

      // Every index of both tables, the six included, is as it was.
      expect(await allDefs()).toEqual(before);
      expect(await keyDefs()).toEqual(KEY_INDEXES);
    });

    it("applies in the same transaction as 0043's index statements, as drizzle-kit applies both to a database that has run neither", async () => {
      await putBack0043Indexes();
      await run([
        ...MIGRATION_0043.filter(touchesKey0043Index),
        ...MIGRATION_0044,
      ]);
      expect(await keyDefs()).toEqual(KEY_INDEXES);
    });

    it("a lookup by the key alone still uses the leading column of each index", async () => {
      await run(MIGRATION_0044);
      // The retention sweep reads `image_key IN (...)` with no project. The
      // planner is kept off a sequential scan so that the answer does not depend
      // on how many rows the shared test database holds.
      const lookups: Array<[string, string]> = [
        [
          "screenshots_image_key_idx",
          "select image_key from screenshots where image_key = any (array['a','b'])",
        ],
        [
          "screenshots_dom_key_idx",
          "select dom_key from screenshots where dom_key = 'a'",
        ],
        [
          "screenshots_element_map_key_idx",
          "select element_map_key from screenshots where element_map_key = 'a'",
        ],
        [
          "screenshots_diff_image_key_idx",
          "select diff_image_key from screenshots where diff_image_key = 'a'",
        ],
        [
          "test_runs_diff_name_idx",
          "select diff_name from test_runs where diff_name = 'a'",
        ],
        [
          "test_runs_image_name_idx",
          "select image_name from test_runs where image_name = 'a'",
        ],
      ];
      await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL enable_seqscan = off`);
        for (const [index, query] of lookups) {
          const plan = await tx.execute<{ "QUERY PLAN": string }>(
            sql.raw(`EXPLAIN ${query}`),
          );
          const text = plan.map((r) => r["QUERY PLAN"]).join("\n");
          expect({ index, usesIt: text.includes(index) }).toEqual({
            index,
            usesIt: true,
          });
        }
      });
    });

    it("builds over existing rows without rewriting them, and finds them through the new indexes", async () => {
      // An index changes no data: a run's row is not rewritten (same `xmin`) and
      // is found through the new composite. Scoped to a run of this test's own.
      const projectId = randomUUID();
      const runId = randomUUID();
      const buildId = randomUUID();
      await db.execute(
        sql`insert into projects (id, name) values (${projectId}, ${`keyidx-${projectId}`})`,
      );
      try {
        await db.execute(
          sql`insert into builds (id, project_id) values (${buildId}, ${projectId})`,
        );
        await db.execute(
          sql`insert into test_runs (id, build_id, project_id, name, image_name, diff_name)
            values (${runId}, ${buildId}, ${projectId}, 'run', ${"1".repeat(64)}, ${"2".repeat(64)})`,
        );
        const read = () =>
          db.execute<{ xmin: string; image_name: string; diff_name: string }>(
            sql`select xmin::text as xmin, image_name, diff_name from test_runs where id = ${runId}`,
          );
        const before = await read();

        await run(MIGRATION_0044);

        expect(await read()).toEqual(before);
        await db.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL enable_seqscan = off`);
          const found = await tx.execute<{ id: string }>(
            sql`select id from test_runs
              where image_name = ${"1".repeat(64)} and project_id = ${projectId}`,
          );
          expect(found.map((r) => r.id)).toEqual([runId]);
        });
      } finally {
        await db.execute(sql`delete from projects where id = ${projectId}`);
      }
    });
  },
);
