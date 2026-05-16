import { TRPCError } from "@trpc/server";

import { t } from "../trpc.js";

/**
 * Asserts `ctx.user` is non-null. Re-binds the narrowed user onto ctx
 * so downstream procedures get strict typing.
 */
export const authed = t.middleware(({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});
