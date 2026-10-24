import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDb, type DB } from "./index.js";

/**
 * Migration `0042_step_diff_results`: additive columns and the reconciler's
 * partial index. Executing the file from disk against the (already migrated)
 * test database is the "re-run" case: it must not fail and must leave the same
 * schema. An unreleased draft of the file built `screenshots_stuck_idx` with a
 * narrower predicate, so the file drops the index before creating it: a
 * database that re-applies it ends with the current predicate, not the draft's.
 *
 * Skipped when `DATABASE_URL` is unset, like the other migration tests.
 */
const RUN_INTEGRATION = !!process.env.DATABASE_URL;
const desc = RUN_INTEGRATION ? describe : describe.skip;

const MIGRATION_SQL = RUN_INTEGRATION
  ? readFileSync(
      fileURLToPath(
        new URL("../migrations/0042_step_diff_results.sql", import.meta.url),
      ),
      "utf8",
    )
  : "";

const STATEMENTS = MIGRATION_SQL.split("--> statement-breakpoint")
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

desc("screenshots per-step diff columns and stuck index (0042)", () => {
  let db: DB;
  let close: () => Promise<void>;
  /** The index as the migrated test database holds it. */
  let migrated: string;

  beforeAll(async () => {
    const created = createDb();
    db = created.db;
    close = created.close;
    const [def] = await definition();
    migrated = def!;
  });
  afterAll(async () => {
    await close();
  });

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

  async function definition(): Promise<string[]> {
    const rows = await db.execute<{ indexdef: string }>(
      sql`select indexdef from pg_indexes
          where tablename = 'screenshots' and indexname = 'screenshots_stuck_idx'`,
    );
    return rows.map((r) => r.indexdef);
  }

  it("is the reconciler's predicate: not failed, and no result newer than the queue time", () => {
    expect(migrated).toContain("USING btree (diff_queued_at)");
    expect(migrated).toContain("(diff_failed_at IS NULL)");
    expect(migrated).toContain("(verdict IS NULL)");
    expect(migrated).toContain("(verdict_at < diff_queued_at)");
  });

  it("re-running the SQL twice is idempotent: no error, the same one index", async () => {
    await runMigration();
    await runMigration();
    expect(await definition()).toEqual([migrated]);
  });

  it("re-running it replaces an index built by the earlier draft's narrower predicate", async () => {
    try {
      await db.execute(sql`DROP INDEX IF EXISTS "screenshots_stuck_idx"`);
      await db.execute(
        sql`CREATE INDEX "screenshots_stuck_idx" ON "screenshots" USING btree ("diff_queued_at") WHERE ("screenshots"."verdict" IS NULL AND "screenshots"."diff_failed_at" IS NULL)`,
      );
      expect(await definition()).not.toEqual([migrated]);

      await runMigration();

      expect(await definition()).toEqual([migrated]);
    } finally {
      // Leave the shared database with the current index whatever happened.
      await db.execute(sql`DROP INDEX IF EXISTS "screenshots_stuck_idx"`);
      const create = STATEMENTS.find((s) =>
        s.startsWith('CREATE INDEX IF NOT EXISTS "screenshots_stuck_idx"'),
      );
      await db.execute(sql.raw(create!));
    }
  });
});
