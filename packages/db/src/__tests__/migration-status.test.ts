import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDb, type DB } from "../client.js";

/**
 * Smoke coverage for migration `0008_run_status_enum.sql`.
 *
 * The migration itself runs at deploy time (or via drizzle-kit migrate)
 * — we don't re-run it in isolation here. Instead we verify the
 * post-migration shape against a live database:
 *
 *   - The `run_status` enum exists with all seven labels in the
 *     declared order.
 *   - Values outside the enum are rejected at INSERT.
 *
 * A full legacy-cast round-trip (insert text rows, run migration,
 * assert remap) is reviewed in the migration SQL itself — the CASE
 * clause is the load-bearing contract. This file confirms the
 * post-state.
 *
 * Skipped automatically when `DATABASE_URL` is not set — same
 * convention as the other migration tests in this package.
 */
const RUN_INTEGRATION = !!process.env.DATABASE_URL;

describe.runIf(RUN_INTEGRATION)("0008_run_status_enum migration", () => {
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

  it("declares the seven standard labels in order", async () => {
    const rows = await db.execute<{ enumlabel: string }>(sql`
        SELECT enumlabel FROM pg_enum
        WHERE enumtypid = 'run_status'::regtype
        ORDER BY enumsortorder
      `);
    const labels = rows.map((r) => r.enumlabel);
    expect(labels).toEqual([
      "new",
      "running",
      "passed",
      "unresolved",
      "failed",
      "aborted",
      "empty",
    ]);
  });

  it("rejects writes of values outside the enum", async () => {
    await expect(
      db.execute(sql`
          INSERT INTO test_runs (project_id, build_id, test_variation_id, status)
          VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'bogus')
        `),
    ).rejects.toThrow();
  });
});
