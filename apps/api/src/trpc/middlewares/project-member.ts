import { gateProjectMember, type SQL } from "@furan/db";
import { TRPCError } from "@trpc/server";

import { isAtLeastAdmin } from "../../lib/roles.js";
import type { Context } from "../context.js";
import { t } from "../trpc.js";

export type Action = "read" | "write";

export interface ProjectMemberOpts<TInput> {
  from:
    | {
        /**
         * The project, from a select the gate runs inside its own statement
         * (one column, at most one row; none when the resource does not
         * exist). Use it for a lookup of the resource's row: the gate then
         * costs 2 statements, the lookup included.
         */
        query: (args: { input: TInput }) => SQL;
      }
    | {
        /**
         * The project, resolved in code. Reads made through `ctx.db` run as
         * the RLS-bypass role, each its own statement on top of the gate's 2:
         * prefer `query` for a row lookup.
         */
        resolver: (args: {
          input: TInput;
          ctx: Context;
        }) => Promise<string | null>;
      };
}

/** What the gate adds to the context (see {@link projectMember}). */
export interface GatedContext {
  gatedProjectId: string | null;
}

const gated = (gatedProjectId: string | null): GatedContext => ({
  gatedProjectId,
});

/**
 * tRPC analogue of `requireProjectMember` (hooks/require-project-member.ts).
 * Admin bypass; otherwise looks up `(userId, projectId)` in `project_members`.
 * Guests are rejected (parity with the REST hook).
 *
 * Downstream, `ctx.gatedProjectId` is the project the gate resolved from
 * `from` and checked the caller's membership in, so a handler acting on that
 * same resource need not read it again to learn its project. It is null for
 * an admin, who skips the gate: the handler resolves the project itself (with
 * the same lookup, e.g. `requireRunProject`).
 */
export function projectMember<TInput>(
  _action: Action,
  opts: ProjectMemberOpts<TInput>,
) {
  return t.middleware(async ({ ctx, input, next }) => {
    if (!ctx.user) throw new TRPCError({ code: "UNAUTHORIZED" });
    // Role-only on purpose (not `hasAdminSurface`): the membership bypass also
    // applies to an admin's API token (ADR-064 step A; see the REST hook).
    if (isAtLeastAdmin(ctx.user.role)) {
      return next({ ctx: gated(null) });
    }
    if (ctx.user.role === "guest") {
      throw new TRPCError({ code: "FORBIDDEN" });
    }

    // The projectId lookup + membership check are the authorization boundary —
    // they must read rows RLS would hide, so `gateProjectMember` runs them with
    // the role ELEVATED to owner (RLS bypass) IN PLACE on the procedure's own
    // scoped transaction (ctx.db). Elevating in place — rather than a second
    // privileged connection — avoids each gated request holding two pooled
    // connections at once (ADR-058). The elevation is restored before the
    // procedure body runs, so resolvers reading `ctx.db` here are privileged;
    // business queries are not.
    const from = opts.from;
    const args = { input: input as TInput, ctx };
    const gate = await gateProjectMember(
      ctx.db,
      ctx.user.id,
      "query" in from
        ? { query: from.query(args) }
        : { resolve: () => from.resolver(args) },
    );

    if (gate.outcome === "not_found") {
      throw new TRPCError({ code: "NOT_FOUND" });
    }
    if (gate.outcome === "forbidden") {
      throw new TRPCError({ code: "FORBIDDEN" });
    }

    return next({ ctx: gated(gate.projectId) });
  });
}
