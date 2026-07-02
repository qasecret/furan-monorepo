import type { FastifyReply, FastifyRequest } from "fastify";

import { sendError } from "../lib/errors.js";
import { roleRank } from "../lib/roles.js";
import type { UserRole } from "../plugins/auth.js";

export function requireRole(...roles: UserRole[]) {
  // Rank-based, not exact-membership: the caller passes if their tier is at
  // least the lowest required tier. The hierarchy owner ⊇ admin ⊇ editor ⊇
  // guest means a higher tier satisfies any lower gate (an owner passes
  // requireRole("admin")) without hard-coding an "owner" exception. Computed
  // once per registration. Empty `roles` ⇒ Infinity ⇒ deny (safe default).
  const threshold = Math.min(...roles.map(roleRank));
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!req.auth) {
      return sendError(reply, 401, "unauthenticated");
    }
    if (roleRank(req.auth.role) < threshold) {
      return sendError(reply, 403, "forbidden");
    }
  };
}
