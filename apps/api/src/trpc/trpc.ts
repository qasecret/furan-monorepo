import { withUserScope } from "@furan/db";
import { initTRPC } from "@trpc/server";

import type { Context } from "./context.js";

export const t = initTRPC.context<Context>().create();

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
 */
const scopeToUser = t.middleware(({ ctx, next }) => {
  if (!ctx.user) return next();
  const { id, role } = ctx.user;
  return withUserScope(ctx.db, { userId: id, role }, (tx) =>
    next({ ctx: { ...ctx, db: tx } }),
  );
});

/**
 * Base procedure every router builds from. Applies {@link scopeToUser} first so
 * the RLS identity is set before any auth/membership middleware or resolver
 * runs. Compose auth on top as before (`publicProcedure.use(authed)` etc.).
 */
export const publicProcedure = t.procedure.use(scopeToUser);
