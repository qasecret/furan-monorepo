import { sql } from "drizzle-orm";

import type { DB } from "./client.js";

/**
 * Runs `fn` inside a transaction with `app.current_project_id` set as a
 * transaction-local marker (`set_config(name, value, is_local=true)`). The
 * marker exists for observability today and for v1.1+ RLS once ADR-022
 * reverses. Until then, project-scoping is a query-construction convention
 * enforced by the `@furan/no-raw-drizzle` ESLint rule plus
 * `requireProjectMember` in `apps/api`.
 */
export async function withProjectScope<T>(
  db: DB,
  projectId: string,
  fn: (tx: DB) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('app.current_project_id', ${projectId}, true)`,
    );
    return fn(tx as DB);
  });
}

/** Reads the current scoped project_id; returns null when not in scope. */
export async function currentProjectId(db: DB): Promise<string | null> {
  const rows = await db.execute<{ current_setting: string | null }>(
    sql`SELECT current_setting('app.current_project_id', true) AS current_setting`,
  );
  const value = rows[0]?.current_setting;
  return value && value.length > 0 ? value : null;
}
