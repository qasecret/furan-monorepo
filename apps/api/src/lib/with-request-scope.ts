import { withUserScope, type DB } from "@furan/db";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { createDeferredSink } from "./deferred-sink.js";

/**
 * Runs `fn` inside a per-request user-scoped transaction (ADR-058), pinning
 * `app.user_id` / `app.user_role` (+ an optional project marker) so Postgres
 * RLS can enforce tenant isolation on the queries the REST handler issues.
 * Pass the yielded `db` to every project-scoped query — and to any helper — in
 * the handler, instead of `app.db`.
 *
 * This mirrors the tRPC `scopeToUser` middleware for the REST surface. RLS is
 * still OFF, so today this only means the handler's DB work runs inside one
 * transaction (behavior-preserving). Project-scoped routes are always
 * authenticated (`app.authenticate` + `requireProjectMember`/`requireRole`), so
 * `req.auth` is present; the `guest`/empty fallback is purely defensive and
 * fail-closes rather than widening access.
 *
 * `onCommit` registers a side effect (diff-job enqueue) to run AFTER the
 * transaction commits, so a worker can't observe the job before the rows it
 * references are visible. Deferred effects run only if `fn` resolves; if it
 * throws, the transaction rolls back and nothing is enqueued.
 *
 * INVARIANTS for `fn`:
 * - Do NOT call `reply.send()` (or `sendError`, which sends) for a SUCCESS
 *   response inside `fn`: that flushes the HTTP response before the transaction
 *   commits, so a client read-after-write can miss its own write. Instead set
 *   `reply.code(x)` and RETURN the body — Fastify sends it after the handler
 *   resolves (post-commit). Error early-returns via `sendError` are tolerated
 *   only because they occur BEFORE any write in the scope.
 * - Rollback happens only on a THROW. A returned value (including a
 *   `sendError` reply) COMMITS the transaction. So if you ever add a write
 *   before an error path, `throw` instead of `return sendError(...)` so the
 *   partial write rolls back.
 */
export async function withRequestScope<T>(
  app: FastifyInstance,
  req: FastifyRequest,
  fn: (db: DB, onCommit: (effect: () => unknown) => void) => Promise<T>,
  projectId?: string,
): Promise<T> {
  const sink = createDeferredSink();
  const result = await withUserScope(
    app.db,
    {
      userId: req.auth?.id ?? "",
      role: req.auth?.role ?? "guest",
      ...(projectId ? { projectId } : {}),
    },
    (db) => fn(db, sink.onCommit),
  );
  // Reached only if the scoped work resolved (a throw skips this and nothing
  // is enqueued), so effects fire exactly once, post-commit.
  await sink.drain();
  return result;
}
