import { TRPCError } from "@trpc/server";

import { SESSION_REQUIRED } from "../../lib/errors.js";
import { hasAdminSurface, isAtLeastAdmin } from "../../lib/roles.js";
import type { AuthedUser } from "../../plugins/auth.js";
import { t } from "../trpc.js";

/**
 * Throws unless `user` may use an admin-only surface ({@link hasAdminSurface}).
 * An admin/owner authenticated with an API token gets FORBIDDEN with message
 * `session_required` (ADR-064 step A); anyone else below admin gets a plain
 * FORBIDDEN (`message` overrides its text, e.g. analytics' wording).
 */
export function assertAdminSurface(user: AuthedUser, message?: string): void {
  if (hasAdminSurface(user)) return;
  if (isAtLeastAdmin(user.role)) {
    throw new TRPCError({ code: "FORBIDDEN", message: SESSION_REQUIRED });
  }
  throw new TRPCError(
    message ? { code: "FORBIDDEN", message } : { code: "FORBIDDEN" },
  );
}

/**
 * Asserts the caller is an authenticated admin on a session. Mirrors the REST
 * hook counterpart so admin-only mutations (e.g. `members.add`/`remove`)
 * reject non-admin sessions — and every API token — with `FORBIDDEN`.
 */
export const requireAdmin = t.middleware(({ ctx, next }) => {
  if (!ctx.user) throw new TRPCError({ code: "UNAUTHORIZED" });
  assertAdminSurface(ctx.user);
  return next({ ctx: { ...ctx, user: ctx.user } });
});
