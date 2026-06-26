import { eq, users, type DB } from "@furan/db";

import type { UserRole } from "../plugins/auth.js";

/**
 * Load a user's CURRENT role + active state by id, returning null when the user
 * is missing or deactivated.
 *
 * Used by both JWT auth paths (the REST `authenticate` hook and the tRPC
 * `softAuthenticate`) so a verified-but-stale token reflects live DB state: a
 * demoted user gets their lower role and a deactivated/deleted user is rejected
 * on their next request, rather than only at token expiry (default 7d). The PAT
 * paths already do this via the tokens→users join; this brings the JWT paths to
 * parity.
 *
 * Throws on a DB error (caller lets it propagate as 500) — it does NOT fall
 * back to the token's claimed role.
 */
export async function loadActiveUser(
  db: DB,
  userId: string,
): Promise<{ id: string; role: UserRole } | null> {
  const rows = await db
    .select({ id: users.id, role: users.role, isActive: users.isActive })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const row = rows[0];
  if (!row || !row.isActive) return null;
  return { id: row.id, role: row.role };
}
