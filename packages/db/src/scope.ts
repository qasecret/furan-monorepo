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

/**
 * The caller identity a scoped transaction pins into GUCs so Postgres RLS
 * policies can evaluate `current_setting('app.user_id'/'app.user_role')`.
 * `role` is the app role string (`owner` / `admin` / `editor` / `guest`) — the
 * policy's admin/owner bypass matches the app's `isAtLeastAdmin`.
 */
export interface UserScope {
  userId: string;
  role: string;
  /** Optional project marker (observability; mirrors {@link withProjectScope}). */
  projectId?: string;
}

/**
 * Runs `fn` inside a transaction with the caller identity pinned as
 * transaction-local GUCs (`app.user_id`, `app.user_role`, and the
 * `app.current_project_id` marker), via `set_config(name, value, is_local =>
 * true)`. `SET LOCAL`-style scoping auto-resets at COMMIT/ROLLBACK, so the
 * identity **cannot leak** to the next borrower of a pooled connection.
 *
 * This is the load-bearing identity primitive for ADR-058 (Postgres RLS as a
 * tenant-isolation backstop). RLS is **not enabled yet** — until the enforcement
 * migration lands, these GUCs are observability-only, exactly like
 * {@link withProjectScope}, so wiring request paths through this is a pure,
 * behavior-preserving refactor. Once policies are on, any query that runs
 * outside such a scope sees zero rows (`current_setting(..., true)` → NULL →
 * fail-closed) instead of leaking cross-tenant data.
 *
 * NOTE (pgBouncer): safe only under **transaction** pooling — the GUC lifetime
 * equals the transaction equals the pooled unit. v1.0 talks directly to
 * Postgres (no pooler), so this is unconstrained today; a future pgBouncer must
 * run in transaction mode (see `arch-backend.md §4.11`).
 */
export async function withUserScope<T>(
  db: DB,
  scope: UserScope,
  fn: (tx: DB) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT
        set_config('app.user_id', ${scope.userId}, true),
        set_config('app.user_role', ${scope.role}, true),
        set_config('app.current_project_id', ${scope.projectId ?? ""}, true)`,
    );
    return fn(tx as DB);
  });
}

/**
 * Runs `fn` with the RLS-bypass identity (`app.user_role = 'owner'`, no user),
 * inside a transaction. For internal AUTHORIZATION reads that must see rows
 * regardless of the caller's own membership — chiefly the
 * `requireProjectMember` gate + its route resolvers, which resolve a project id
 * and check membership and so cannot be subject to the RLS they enforce
 * (ADR-058, finding #4). The policies treat `owner` as a bypass
 * (`app_is_admin()`), so once RLS is on these reads see everything. RLS is not
 * enabled yet, so this is a no-op marker today. Do NOT use for business
 * queries — only the ACL gate.
 */
export async function withPrivilegedScope<T>(
  db: DB,
  fn: (tx: DB) => Promise<T>,
): Promise<T> {
  return withUserScope(db, { userId: "", role: "owner" }, fn);
}

/**
 * Temporarily elevates the CURRENT open transaction to the RLS-bypass role
 * (`app.user_role = 'owner'`) for the duration of `fn`, then restores the prior
 * role — all on the SAME connection, so no second pooled connection is checked
 * out. Use this (not {@link withPrivilegedScope}) for an authorization read
 * that runs INSIDE an already-scoped request transaction (e.g. the tRPC
 * `projectMember` gate inside `scopeToUser`'s tx): a separate privileged
 * connection would make each gated request hold two pooled connections at once
 * and can exhaust the pool under load.
 *
 * `tx` MUST be an open transaction (`SET LOCAL` is transaction-scoped). The
 * restore runs in a `finally`; if a query in `fn` aborted the transaction the
 * restore no-ops (the whole unit fails anyway), so its error is swallowed.
 */
export async function withElevatedRole<T>(
  tx: DB,
  fn: () => Promise<T>,
): Promise<T> {
  const rows = await tx.execute<{ role: string | null }>(
    sql`SELECT current_setting('app.user_role', true) AS role`,
  );
  const prev = rows[0]?.role ?? "";
  await tx.execute(sql`SELECT set_config('app.user_role', 'owner', true)`);
  try {
    return await fn();
  } finally {
    try {
      await tx.execute(sql`SELECT set_config('app.user_role', ${prev}, true)`);
    } catch {
      // The transaction was aborted by a failing query in `fn`; the request
      // fails anyway, so there is no live role to restore.
    }
  }
}

/** Reads the current scoped user_id; returns null when no identity is set. */
export async function currentUserId(db: DB): Promise<string | null> {
  const rows = await db.execute<{ current_setting: string | null }>(
    sql`SELECT current_setting('app.user_id', true) AS current_setting`,
  );
  const value = rows[0]?.current_setting;
  return value && value.length > 0 ? value : null;
}

/** Reads the current scoped user_role; returns null when no identity is set. */
export async function currentUserRole(db: DB): Promise<string | null> {
  const rows = await db.execute<{ current_setting: string | null }>(
    sql`SELECT current_setting('app.user_role', true) AS current_setting`,
  );
  const value = rows[0]?.current_setting;
  return value && value.length > 0 ? value : null;
}
