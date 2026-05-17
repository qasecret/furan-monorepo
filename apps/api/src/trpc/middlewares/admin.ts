import { TRPCError } from "@trpc/server";

import { t } from "../trpc.js";

/**
 * Asserts the caller is an authenticated admin. Mirrors the REST hook
 * counterpart so admin-only mutations (e.g. `members.add`/`remove`) reject
 * non-admin sessions with `FORBIDDEN`.
 */
export const requireAdmin = t.middleware(({ ctx, next }) => {
  if (!ctx.user) throw new TRPCError({ code: "UNAUTHORIZED" });
  if (ctx.user.role !== "admin") throw new TRPCError({ code: "FORBIDDEN" });
  return next({ ctx: { ...ctx, user: ctx.user } });
});
