/**
 * Applies hand-written migrations that contain CREATE INDEX CONCURRENTLY,
 * which cannot run inside a transaction and therefore cannot be applied by
 * drizzle-kit's standard `migrate` command.
 *
 * This script:
 * 1. Checks drizzle.__drizzle_migrations to see if the migration is already applied.
 * 2. If not, runs the SQL outside any transaction.
 * 3. Records the migration hash in drizzle.__drizzle_migrations so drizzle-kit
 *    will not attempt to re-run it on the next `drizzle-kit migrate` invocation.
 *
 * Usage (run after `drizzle-kit migrate`):
 *   DATABASE_URL=... node --loader tsx src/apply-concurrent-migrations.ts
 *
 * Or via pnpm:
 *   DATABASE_URL=... pnpm --filter @furan/db exec tsx src/apply-concurrent-migrations.ts
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import postgres from "postgres";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, "../migrations");
const DRIZZLE_SCHEMA = "drizzle";
const DRIZZLE_TABLE = "__drizzle_migrations";

/**
 * Migrations in this list are applied outside a transaction.
 * Each entry: { tag: journal tag, when: timestamp from _journal.json }
 */
const CONCURRENT_MIGRATIONS: { tag: string; when: number }[] = [
  { tag: "0014_inbox_partial_index", when: 1779854000000 },
];

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("ERROR: DATABASE_URL is not set");
    process.exit(1);
  }

  // Use a single connection (max:1) — CONCURRENTLY needs no transaction wrapper.
  const sql = postgres(url, { max: 1 });

  try {
    // Fetch the most-recently recorded migration timestamp.
    const rows = await sql`
      select created_at
      from ${sql(DRIZZLE_SCHEMA)}.${sql(DRIZZLE_TABLE)}
      order by created_at desc
      limit 1
    `;
    const lastAppliedAt: number =
      rows.length > 0 ? Number(rows[0]!.created_at) : 0;

    for (const { tag, when } of CONCURRENT_MIGRATIONS) {
      if (lastAppliedAt >= when) {
        console.log(
          `[skip] ${tag} already applied (lastAppliedAt=${lastAppliedAt} >= when=${when})`,
        );
        continue;
      }

      const sqlFilePath = path.join(MIGRATIONS_DIR, `${tag}.sql`);
      const sqlContent = fs.readFileSync(sqlFilePath, "utf8");
      const hash = crypto.createHash("sha256").update(sqlContent).digest("hex");

      // Check if this exact hash is already recorded (idempotency guard).
      const existing = await sql`
        select id from ${sql(DRIZZLE_SCHEMA)}.${sql(DRIZZLE_TABLE)}
        where hash = ${hash}
      `;
      if (existing.length > 0) {
        console.log(`[skip] ${tag} hash already in __drizzle_migrations`);
        continue;
      }

      console.log(`[apply] ${tag} ...`);

      // Split on drizzle statement-breakpoints and run each statement.
      const statements = sqlContent
        .split("--> statement-breakpoint")
        .map((s) => s.trim())
        .filter(Boolean);

      for (const stmt of statements) {
        // Run outside any transaction — required for CONCURRENTLY.
        await sql.unsafe(stmt);
      }

      // Record in drizzle's migrations table.
      await sql`
        insert into ${sql(DRIZZLE_SCHEMA)}.${sql(DRIZZLE_TABLE)} (hash, created_at)
        values (${hash}, ${when})
      `;

      console.log(`[done]  ${tag}`);
    }
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
