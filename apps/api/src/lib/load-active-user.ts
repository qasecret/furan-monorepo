import { eq, tokens, users, type DB } from "@furan/db";

import type { UserRole } from "../plugins/auth.js";

import { hashToken } from "./token.js";

/**
 * Load a user's CURRENT role + active state by id, returning null when the user
 * is missing or deactivated.
 *
 * Used by both JWT auth paths (the REST `authenticate` hook and the tRPC
 * `softAuthenticate`) so a verified-but-stale token reflects live DB state: a
 * demoted user gets their lower role and a deactivated/deleted user is rejected
 * on their next request, rather than only at token expiry (default 7d). The PAT
 * paths use {@link loadActiveUserByPat} for the same liveness.
 *
 * Throws on a DB error (caller lets it propagate as 500) — it does NOT fall
 * back to the token's claimed role.
 */
export async function loadActiveUser(
  db: DB,
  userId: string,
): Promise<{ id: string; role: UserRole } | null> {
  // Guard a missing/empty id BEFORE the query: a verified JWT could (only if
  // signed with our secret) lack `sub`, and Drizzle + postgres-js throw on an
  // undefined bind rather than matching zero rows. Returning null here keeps
  // the documented "null when missing" contract → a clean 401/anonymous.
  if (!userId) return null;
  const rows = await db
    .select({ role: users.role, isActive: users.isActive })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const row = rows[0];
  if (!row || !row.isActive) return null;
  return { id: userId, role: row.role };
}

/**
 * Resolve a `furan_pat_*` token to its CURRENT user (role + active state),
 * returning null when the token is unknown or the user is deactivated. Returns
 * the matched `tokenId` so the caller can update `last_used`. Single source of
 * truth for both PAT auth branches (REST hook + tRPC soft-auth) so they can't
 * drift from each other or from {@link loadActiveUser}.
 */
export async function loadActiveUserByPat(
  db: DB,
  rawToken: string,
): Promise<{ id: string; role: UserRole; tokenId: string } | null> {
  const hash = hashToken(rawToken);
  const rows = await db
    .select({
      tokenId: tokens.id,
      userId: tokens.userId,
      role: users.role,
      isActive: users.isActive,
    })
    .from(tokens)
    .innerJoin(users, eq(users.id, tokens.userId))
    .where(eq(tokens.hash, hash))
    .limit(1);
  const row = rows[0];
  if (!row || !row.isActive) return null;
  return { id: row.userId, role: row.role, tokenId: row.tokenId };
}
