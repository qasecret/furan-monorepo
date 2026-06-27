import { and, eq, projectMembers } from "@furan/db";
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

    const projectId = await opts.from.resolver({
      input: input as TInput,
      ctx,
    });
    if (!projectId) throw new TRPCError({ code: "NOT_FOUND" });

    const rows = await ctx.db
      .select({ id: projectMembers.id })
      .from(projectMembers)
      .where(
        and(
          eq(projectMembers.userId, ctx.user.id),
          eq(projectMembers.projectId, projectId),
        ),
      )
      .limit(1);
    if (rows.length === 0) throw new TRPCError({ code: "FORBIDDEN" });

    return next();
  });
}
