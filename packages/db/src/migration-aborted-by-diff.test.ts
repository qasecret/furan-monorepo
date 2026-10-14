import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  builds,
  createDb,
  eq,
  projects,
  testRuns,
  users,
  type DB,
} from "./index.js";

/**
 * Migration `0038_aborted_by_diff` (Ruling R46): an additive, idempotent
 * column. The test database is already migrated, so executing the file again
 * from disk is exactly the "re-run" case: it must be a no-op that neither
 * fails nor touches existing values.
 *
 * Skipped when `DATABASE_URL` is unset, like the other migration tests.
 */
const RUN_INTEGRATION = !!process.env.DATABASE_URL;
const desc = RUN_INTEGRATION ? describe : describe.skip;

const MIGRATION_SQL = RUN_INTEGRATION
  ? readFileSync(
      fileURLToPath(
        new URL("../migrations/0038_aborted_by_diff.sql", import.meta.url),
      ),
      "utf8",
    )
  : "";

desc("test_runs.aborted_by_diff (0038)", () => {
  let db: DB;
  let close: () => Promise<void>;
  let projectId: string;
  let buildId: string;

  beforeAll(async () => {
    const created = createDb();
    db = created.db;
    close = created.close;
    const uniq = `${Date.now()}-${Math.random()}`;
    const [u] = await db
      .insert(users)
      .values({
        email: `db-abd-${uniq}@x.test`,
        hashedPassword: "x",
        firstName: "db",
        lastName: "abd",
        role: "admin",
      })
      .returning();
    const [p] = await db
      .insert(projects)
      .values({ name: `db-abd-${uniq}` })
      .returning();
    projectId = p!.id;
    const [b] = await db
      .insert(builds)
      .values({ projectId, userId: u!.id, isRunning: false })
      .returning();
    buildId = b!.id;
  });
  afterAll(async () => {
    await db.delete(projects).where(eq(projects.id, projectId));
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

  it("defaults to false, NOT NULL", async () => {
    const [r] = await db
      .insert(testRuns)
      .values({ buildId, projectId, name: "home", branchName: "main" })
      .returning();
    expect(r!.abortedByDiff).toBe(false);
    await expect(
      db.execute(
        sql`UPDATE test_runs SET aborted_by_diff = NULL WHERE id = ${r!.id}`,
      ),
    ).rejects.toThrow();
  });

  it("re-running the SQL is a no-op: no error, values kept", async () => {
    const [flagged] = await db
      .insert(testRuns)
      .values({
        buildId,
        projectId,
        name: "aborted-by-diff",
        branchName: "main",
        status: "aborted",
        abortedByDiff: true,
      })
      .returning();

    await runMigration();
    await runMigration();

    const [after] = await db
      .select({ abortedByDiff: testRuns.abortedByDiff })
      .from(testRuns)
      .where(eq(testRuns.id, flagged!.id));
    expect(after!.abortedByDiff).toBe(true);
  });
});
