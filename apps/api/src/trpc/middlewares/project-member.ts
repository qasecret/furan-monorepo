import {
  and,
  type DB,
  eq,
  projectMembers,
  withPrivilegedScope,
} from "@furan/db";
import { TRPCError } from "@trpc/server";

import { isAtLeastAdmin } from "../../lib/roles.js";
import type { Context } from "../context.js";
import { t } from "../trpc.js";

export type Action = "read" | "write";

export interface ProjectMemberOpts<TInput> {
  from: {
    // Resolvers receive a PRIVILEGED (RLS-bypass) `db`: they resolve a project
    // id from a project-scoped row, and the gate is the authorization boundary,
    // so it can't be subject to the RLS it enforces (ADR-058). Resolvers that
    // read the DB must use this `db`, not `ctx.db`.
    resolver: (args: {
      input: TInput;
      ctx: Context;
      db: DB;
    }) => Promise<string | null>;
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
    // run them PRIVILEGED (RLS bypass) on the UNSCOPED pool (`ctx.rawDb`), so
    // RLS can't hide the row the gate needs and the owner GUC never leaks into
    // the procedure's scoped transaction.
    const outcome = await withPrivilegedScope(
      ctx.rawDb,
      async (db): Promise<"ok" | "not_found" | "forbidden"> => {
        const projectId = await opts.from.resolver({
          input: input as TInput,
          ctx,
          db,
        });
        if (!projectId) return "not_found";
        const rows = await db
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
