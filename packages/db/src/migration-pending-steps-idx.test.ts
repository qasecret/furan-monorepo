import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDb, type DB } from "./index.js";

/**
 * Migration `0040_pending_steps_idx`: an additive, idempotent partial index.
 * Executing the file from disk against the (already migrated) test database is
 * the "re-run" case: it must be a no-op that does not fail, and the index must
 * hold exactly the steps a verdict of `new` or `unresolved` makes candidates
 * for review.
 *
 * Skipped when `DATABASE_URL` is unset, like the other migration tests.
 */
const RUN_INTEGRATION = !!process.env.DATABASE_URL;
const desc = RUN_INTEGRATION ? describe : describe.skip;

const MIGRATION_SQL = RUN_INTEGRATION
  ? readFileSync(
      fileURLToPath(
        new URL("../migrations/0040_pending_steps_idx.sql", import.meta.url),
      ),
      "utf8",
    )
  : "";

desc("screenshots pending-steps partial index (0040)", () => {
  let db: DB;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const created = createDb();
    db = created.db;
    close = created.close;
  });
  afterAll(async () => {
    await close();
  });

  /** The migration file, split and executed as drizzle's migrator does. */
  async function runMigration(): Promise<void> {
    const statements = MIGRATION_SQL.split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const stmt of statements) {
      await db.execute(sql.raw(stmt));
    }
  }

  async function definition(): Promise<string[]> {
    const rows = await db.execute<{ indexdef: string }>(
      sql`select indexdef from pg_indexes
          where tablename = 'screenshots' and indexname = 'screenshots_pending_idx'`,
    );
    return rows.map((r) => r.indexdef);
  }

  it("re-running the SQL is a no-op: no error, one index", async () => {
    await runMigration();
    await runMigration();
    expect(await definition()).toHaveLength(1);
  });

  it("is (run_id, created_at), only for the new and unresolved verdicts", async () => {
    await runMigration();
    const [def] = await definition();
    expect(def).toContain("(run_id, created_at)");
    expect(def).toContain("WHERE");
    expect(def).toMatch(/verdict = ANY \(ARRAY\['new'.*'unresolved'.*\]\)/);
    expect(def).not.toContain("passed");
  });
});
