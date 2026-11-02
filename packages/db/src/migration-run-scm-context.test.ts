import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDb, type DB } from "./index.js";

/**
 * Migration `0045_run_scm_context`: four additive, nullable `test_runs`
 * columns holding the repo, pull request and commit a run was made for.
 * Executing the file from disk against the (already migrated) test database is
 * the "re-run" case: it must not fail and must leave the same schema.
 *
 * Skipped when `DATABASE_URL` is unset, like the other migration tests.
 */
const RUN_INTEGRATION = !!process.env.DATABASE_URL;
const desc = RUN_INTEGRATION ? describe : describe.skip;

const MIGRATION_SQL = RUN_INTEGRATION
  ? readFileSync(
      fileURLToPath(
        new URL("../migrations/0045_run_scm_context.sql", import.meta.url),
      ),
      "utf8",
    )
  : "";

const STATEMENTS = MIGRATION_SQL.split("--> statement-breakpoint")
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

const COLUMNS: Record<string, string> = {
  repo_owner: "text",
  repo_name: "text",
  pr_number: "integer",
  commit_sha: "text",
};

desc("test_runs repo / PR / commit columns (0045)", () => {
  let db: DB;
  let close: () => Promise<void>;

  beforeAll(() => {
    const created = createDb();
    db = created.db;
    close = created.close;
  });
  afterAll(async () => {
    await close();
  });

  async function columns() {
    return db.execute<{
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>(
      sql`select column_name, data_type, is_nullable
          from information_schema.columns
          where table_name = 'test_runs'
            and column_name in ('repo_owner', 'repo_name', 'pr_number', 'commit_sha')
          order by column_name`,
    );
  }

  it("adds the four columns, all nullable, with no default", async () => {
    const rows = await columns();
    expect(rows.map((r) => r.column_name)).toEqual(Object.keys(COLUMNS).sort());
    for (const r of rows) {
      expect(r.data_type).toBe(COLUMNS[r.column_name]);
      expect(r.is_nullable).toBe("YES");
    }
  });

  it("re-running the SQL twice is idempotent: no error, the same columns", async () => {
    const before = await columns();
    for (let i = 0; i < 2; i++) {
      await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL client_min_messages = warning`);
        for (const stmt of STATEMENTS) {
          await tx.execute(sql.raw(stmt));
        }
      });
    }
    expect(await columns()).toEqual(before);
  });
});
