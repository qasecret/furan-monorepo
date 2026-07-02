import { and, eq, projectMembers, withElevatedRole } from "@furan/db";
import { TRPCError } from "@trpc/server";

import { isAtLeastAdmin } from "../../lib/roles.js";
import type { Context } from "../context.js";
import { t } from "../trpc.js";

export type Action = "read" | "write";

export interface ProjectMemberOpts<TInput> {
  from: {
    resolver: (args: { input: TInput; ctx: Context }) => Promise<string | null>;
  };
}

/**
 * tRPC analogue of `requireProjectMember` (hooks/require-project-member.ts).
 * Admin bypass; otherwise looks up `(userId, projectId)` in `project_members`.
 * Guests are rejected (parity with the REST hook).
 */
export function projectMember<TInput>(
  _action: Action,
  opts: ProjectMemberOpts<TInput>,
) {
  return t.middleware(async ({ ctx, input, next }) => {
    if (!ctx.user) throw new TRPCError({ code: "UNAUTHORIZED" });
    if (isAtLeastAdmin(ctx.user.role)) return next();
    if (ctx.user.role === "guest") {
      throw new TRPCError({ code: "FORBIDDEN" });
    }
    const user = ctx.user;

    // The projectId lookup + membership check are the authorization boundary —
    // they must read rows RLS would hide, so run them with the role ELEVATED to
    // owner (RLS bypass) IN PLACE on the procedure's own scoped transaction
    // (ctx.db). Elevating in place — rather than a second privileged connection
    // — avoids each gated request holding two pooled connections at once
    // (ADR-058). The elevation is restored before the procedure body runs, so
    // resolvers reading `ctx.db` here are privileged; business queries are not.
    const outcome = await withElevatedRole(
      ctx.db,
      async (): Promise<"ok" | "not_found" | "forbidden"> => {
        const projectId = await opts.from.resolver({
          input: input as TInput,
          ctx,
        });
        if (!projectId) return "not_found";
        const rows = await ctx.db
          .select({ id: projectMembers.id })
          .from(projectMembers)
          .where(
            and(
              eq(projectMembers.userId, user.id),
              eq(projectMembers.projectId, projectId),
            ),
          )
          .limit(1);
        return rows.length > 0 ? "ok" : "forbidden";
      },
    );

    if (outcome === "not_found") throw new TRPCError({ code: "NOT_FOUND" });
    if (outcome === "forbidden") throw new TRPCError({ code: "FORBIDDEN" });

    return next();
  });
}
