import { withUserScope, type DB } from "@furan/db";
import { initTRPC } from "@trpc/server";

import { createDeferredSink } from "../lib/deferred-sink.js";
import {
  procedureOutcome,
  recordPoolWait,
  recordProcedure,
} from "../lib/request-metrics.js";
import { ReviewRefusal } from "../lib/review/errors.js";

import type { Context } from "./context.js";

/**
 * `errorFormatter` lifts a review refusal's structured payload onto
 * `data.details` (per-checkpoint reasons, race winner, bulk preview) so the
 * dashboard can render it. Every other error keeps its shape: `details` is
 * `undefined` (dropped by JSON) unless the cause is a `ReviewRefusal`.
 */
export const t = initTRPC.context<Context>().create({
  errorFormatter: ({ shape, error }) => ({
    ...shape,
    data: {
      ...shape.data,
      details:
        error.cause instanceof ReviewRefusal ? error.cause.details : undefined,
    },
  }),
});

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
 * `ctx.onCommit` still works for them: with no transaction, its effects run
 * once the procedure succeeds, and never when it fails.
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
 *
 * The wait for the transaction (from asking for it until its callback starts:
 * a pooled connection, then BEGIN) is observed into
 * `furan_db_pool_wait_seconds`, once per procedure that opens one, whatever
 * the procedure then does (spec 2026-10-27 §8). A transaction that never
 * begins (the database is unreachable) is not observed: its failure is the
 * procedure's, a `server_error` in `furan_trpc_procedure_duration_seconds`.
 */
const scopeToUser = t.middleware(async ({ ctx, next }) => {
  // The sink lives in the middleware closure (not on the Context), so
  // `ctx.onCommit` is the only surface a procedure sees — it can't reach or
  // mutate the underlying effect list. Injected in both branches so the ctx
  // shape (and its inferred type) is consistent for every procedure.
  const sink = createDeferredSink();
  const scopedCtx = { ...ctx, onCommit: sink.onCommit };
  if (!ctx.user) {
    // No transaction to wait for, so effects run as soon as the procedure
    // succeeds. A failed procedure's effects are dropped, as in the scoped path.
    const result = await next({ ctx: scopedCtx });
    if (result.ok) await sink.drain();
    return result;
  }
  const { id, role } = ctx.user;
  const run = (tx: DB) => next({ ctx: { ...scopedCtx, db: tx } });
  let result: Awaited<ReturnType<typeof run>>;
  const askedAt = performance.now();
  const onBegin = () => {
    try {
      recordPoolWait(
        ctx.telemetry.metrics,
        (performance.now() - askedAt) / 1000,
      );
    } catch {
      // Metric only (a hand-built `createCaller` context may carry no
      // telemetry): never fail, or alter, the procedure.
    }
  };
  try {
    result = await withUserScope(
      ctx.db,
      { userId: id, role },
      async (tx) => {
        const outcome = await run(tx);
        if (!outcome.ok) throw new ProcedureFailed(outcome);
        return outcome;
      },
      { onBegin },
    );
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
 * Times each procedure call into `furan_trpc_procedure_duration_seconds`,
 * labelled by procedure path, type and outcome (ok, client_error or
 * server_error). Outermost on {@link publicProcedure}, so the sample covers
 * the user scope's transaction, authorization and the resolver.
 *
 * `next()` never throws (a failing procedure comes back as `{ ok: false }`),
 * so every call is observed exactly once, a rolled-back one included.
 *
 * Observing must never change what a procedure returns. A context built by
 * hand (a `createCaller` test passing only the fields it needs) may carry no
 * `telemetry`; the observation is skipped then, and the result goes out as it
 * was.
 */
const timeProcedure = t.middleware(async ({ ctx, path, type, next }) => {
  const startedAt = performance.now();
  const result = await next();
  try {
    recordProcedure(
      ctx.telemetry.metrics,
      { procedure: path, type, outcome: procedureOutcome(result) },
      (performance.now() - startedAt) / 1000,
    );
  } catch {
    // Metric only: never fail, or alter, the procedure it describes.
  }
  return result;
});

/**
 * Base procedure every router builds from. Applies {@link timeProcedure}, then
 * {@link scopeToUser}, so the RLS identity is set before any auth/membership
 * middleware or resolver runs. Compose auth on top as before
 * (`publicProcedure.use(authed)` etc.).
 */
export const publicProcedure = t.procedure.use(timeProcedure).use(scopeToUser);
