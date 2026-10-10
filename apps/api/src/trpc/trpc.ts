import { withUserScope, type DB } from "@furan/db";
import { initTRPC } from "@trpc/server";

import { createDeferredSink } from "../lib/deferred-sink.js";

import type { Context } from "./context.js";

export const t = initTRPC.context<Context>().create();

/**
 * Thrown inside {@link scopeToUser}'s transaction to roll it back when the
 * procedure failed. Carries tRPC's `{ ok: false }` result out of the
 * transaction so the middleware can return it unchanged. Never escapes the
 * middleware.
 */
class ProcedureFailed extends Error {
  constructor(readonly result: unknown) {
    super("procedure failed; rolling back its request transaction");
  }
}

/**
 * Runs each procedure inside a user-scoped transaction (ADR-058): pins
 * `app.user_id` / `app.user_role` via `withUserScope` and swaps `ctx.db` for
 * the transaction handle for the procedure's duration, so Postgres RLS can
 * enforce tenant isolation from the DB layer.
 *
 * Unauthenticated procedures (no `ctx.user`) run WITHOUT a scope/transaction:
 * they don't read project-scoped data, and once RLS is enabled they fail-closed
 * to zero project rows — which is correct. RLS is still OFF today, so this is a
 * behavior-preserving change: queries simply run inside a transaction now (a
 * per-procedure atomic unit), which is why every existing tRPC test still holds.
 *
 * Downstream middlewares (`authed`, `projectMember`, `requireAdmin`) run AFTER
 * this and inherit the scoped `ctx.db`, so their own membership lookups are
 * covered too. Nested `ctx.db.transaction(...)` inside a procedure becomes a
 * savepoint on the outer transaction (supported by postgres.js).
 *
 * The transaction COMMITS only when the procedure succeeds. tRPC's `next()`
 * never throws — a failing procedure comes back as `{ ok: false, error }` — so
 * the callback throws {@link ProcedureFailed} to force a ROLLBACK, then the
 * middleware returns that same result, leaving the error (code, message,
 * `cause`) exactly as thrown.
 */
const scopeToUser = t.middleware(async ({ ctx, next }) => {
  // The sink lives in the middleware closure (not on the Context), so
  // `ctx.onCommit` is the only surface a procedure sees — it can't reach or
  // mutate the underlying effect list. Injected in both branches so the ctx
  // shape (and its inferred type) is consistent for every procedure.
  const sink = createDeferredSink();
  const scopedCtx = { ...ctx, onCommit: sink.onCommit };
  if (!ctx.user) return next({ ctx: scopedCtx });
  const { id, role } = ctx.user;
  const run = (tx: DB) => next({ ctx: { ...scopedCtx, db: tx } });
  let result: Awaited<ReturnType<typeof run>>;
  try {
    result = await withUserScope(ctx.db, { userId: id, role }, async (tx) => {
      const outcome = await run(tx);
      if (!outcome.ok) throw new ProcedureFailed(outcome);
      return outcome;
    });
  } catch (err) {
    // Rolled back: nothing the procedure wrote survives, and its deferred
    // effects are dropped (they would reference rows that aren't there).
    if (err instanceof ProcedureFailed) return err.result as typeof result;
    throw err;
  }
  // Committed: now run post-commit effects (diff enqueues).
  await sink.drain();
  return result;
});

/**
 * Base procedure every router builds from. Applies {@link scopeToUser} first so
 * the RLS identity is set before any auth/membership middleware or resolver
 * runs. Compose auth on top as before (`publicProcedure.use(authed)` etc.).
 */
export const publicProcedure = t.procedure.use(scopeToUser);
