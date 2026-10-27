import { sql, type SQL } from "drizzle-orm";

import type { DB } from "./client.js";
import { projectMembers } from "./schema/index.js";

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

/** Hooks into {@link withUserScope}'s transaction. */
export interface UserScopeOptions {
  /** Called when the transaction's callback starts (see `withUserScope`). */
  onBegin?: () => void;
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
 *
 * `opts.onBegin` runs first thing in the transaction's callback, once the
 * pool has handed over a connection and BEGIN has returned, before the scope
 * is set: the API times its pool wait with it (`furan_db_pool_wait_seconds`).
 * It must not throw.
 */
export async function withUserScope<T>(
  db: DB,
  scope: UserScope,
  fn: (tx: DB) => Promise<T>,
  opts: UserScopeOptions = {},
): Promise<T> {
  return db.transaction(async (tx) => {
    opts.onBegin?.();
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
 * queries — only the ACL gate. Inside an already-scoped request transaction
 * use {@link gateProjectMember} instead, which elevates that transaction in
 * place rather than opening a second pooled connection.
 */
export async function withPrivilegedScope<T>(
  db: DB,
  fn: (tx: DB) => Promise<T>,
): Promise<T> {
  return withUserScope(db, { userId: "", role: "owner" }, fn);
}

/**
 * Where the project-member gate ({@link gateProjectMember}) finds the project
 * a call acts on.
 */
export type GateProject =
  /**
   * A select of the owning project's id: one column, at most one row (none
   * when the resource does not exist). The gate runs it INSIDE its own
   * statement, as a subquery, so it costs no statement of its own.
   */
  | { query: SQL }
  /**
   * Resolved by the caller in code. Any rows it reads (through the same
   * transaction) are read while the role is elevated, each its own statement.
   */
  | { resolve: () => Promise<string | null> };

/**
 * The gate's verdict (through, no such resource, or not a member) and, when
 * through, the project it resolved: the one whose membership it checked, so
 * the caller can act in it without reading the resource again.
 */
export type GateResult =
  | { outcome: "ok"; projectId: string }
  | { outcome: "not_found" }
  | { outcome: "forbidden" };

/** The gate's verdict alone. */
export type GateOutcome = GateResult["outcome"];

/**
 * Reads the current role and switches to the RLS-bypass role, in that order:
 * the prior role is read from a MATERIALIZED CTE before the outer row, whose
 * `set_config` elevates, is formed.
 */
const ELEVATE_ROLE = sql`
  WITH prior AS MATERIALIZED (
    SELECT current_setting('app.user_role', true) AS role
  )
  SELECT prior.role, set_config('app.user_role', 'owner', true) AS elevated
  FROM prior`;

/** Puts `role` back, best effort: the transaction may already be aborted. */
async function restoreRoleQuietly(tx: DB, role: string): Promise<void> {
  try {
    await tx.execute(sql`SELECT set_config('app.user_role', ${role}, true)`);
  } catch {
    // A failing query aborted the transaction; the request fails anyway, so
    // there is no live role to restore.
  }
}

/**
 * The tRPC `projectMember` gate's reads (spec 2026-10-27 §7): the project a
 * call acts on and the caller's membership row in it, read as the RLS-bypass
 * role (`app.user_role = 'owner'`) on the CALLER'S OWN open transaction, so the
 * gate can see rows RLS would hide from the caller (it is the authorization
 * boundary, ADR-058) without checking out a second pooled connection.
 *
 * Two statements, in this order:
 *  1. read the current role and set `owner` ({@link ELEVATE_ROLE});
 *  2. resolve the project (a `query` runs here, as a subquery), read the
 *     membership row, then restore the prior role. Each step is a
 *     MATERIALIZED CTE the next one reads, so the restore's `set_config`
 *     runs only after both reads, which therefore still run as `owner`.
 * A `resolve` runs between the two, elevated, at the cost of its own reads.
 * On `ok` the result carries the project resolved (as Postgres returned it,
 * lowercase uuid text).
 *
 * Every setting is transaction-local (`is_local = true`), as before: the role
 * the procedure body sees is the one it had before the gate, and nothing
 * outlives the transaction. `tx` MUST be an open transaction. If a step fails,
 * the restore is still attempted and its error swallowed (the transaction is
 * aborted, and the request with it), then the failure is rethrown.
 *
 * Every value reaches Postgres as a bound parameter.
 */
export async function gateProjectMember(
  tx: DB,
  userId: string,
  project: GateProject,
): Promise<GateResult> {
  const elevated = await tx.execute<{ role: string | null }>(ELEVATE_ROLE);
  const prior = elevated[0]?.role ?? "";

  let resolved: SQL;
  if ("query" in project) {
    resolved = sql`(${project.query})`;
  } else {
    let projectId: string | null;
    try {
      projectId = await project.resolve();
    } catch (err) {
      await restoreRoleQuietly(tx, prior);
      throw err;
    }
    // An empty id means no project, as it always has.
    resolved = sql`${projectId || null}::uuid`;
  }

  let rows: Array<{ project_id: string | null; member: boolean }>;
  try {
    rows = await tx.execute<{ project_id: string | null; member: boolean }>(sql`
      WITH resolved AS MATERIALIZED (
        SELECT ${resolved} AS project_id
      ),
      membership AS MATERIALIZED (
        SELECT resolved.project_id,
               EXISTS (
                 SELECT 1 FROM ${projectMembers}
                 WHERE ${projectMembers.userId} = ${userId}
                   AND ${projectMembers.projectId} = resolved.project_id
               ) AS member
        FROM resolved
      )
      SELECT membership.project_id, membership.member,
             set_config('app.user_role', ${prior}, true) AS restored
      FROM membership`);
  } catch (err) {
    await restoreRoleQuietly(tx, prior);
    throw err;
  }
  const row = rows[0];
  if (!row?.project_id) return { outcome: "not_found" };
  return row.member
    ? { outcome: "ok", projectId: row.project_id }
    : { outcome: "forbidden" };
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
