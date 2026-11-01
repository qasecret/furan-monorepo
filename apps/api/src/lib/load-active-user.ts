import { eq, sql, tokens, users, type DB } from "@furan/db";
import { tokenScopeSchema, type TokenScope } from "@furan/shared-types";

import type { UserRole } from "../plugins/auth.js";

import { hashToken } from "./token.js";

/**
 * Load a user's CURRENT role + active state by id, returning null only when the
 * user is MISSING. Callers gate on `isActive` themselves so they can
 * distinguish "deactivated" (403 account_inactive) from "missing/bad token"
 * (401) — see resolve-auth-user.ts and the two JWT auth sites.
 *
 * Used (via {@link resolveAuthUser}) by both JWT auth paths so a verified-but-
 * stale token reflects live DB state: a demoted user gets their lower role and
 * a deactivated/deleted user is rejected on their next request, not only at
 * token expiry (default 7d). The PAT paths use {@link loadActiveUserByPat}.
 *
 * Throws on a DB error (caller lets it propagate as 500) — it does NOT fall
 * back to the token's claimed role.
 */
export async function loadActiveUser(
  db: DB,
  userId: string,
): Promise<{ role: UserRole; isActive: boolean } | null> {
  // Guard a missing/empty id BEFORE the query: a verified JWT could (only if
  // signed with our secret) lack `sub`, and Drizzle + postgres-js throw on an
  // undefined bind rather than matching zero rows. Returning null here keeps
  // the "null when missing" contract → a clean 401/anonymous.
  if (!userId) return null;
  const rows = await db
    .select({ role: users.role, isActive: users.isActive })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { role: row.role, isActive: row.isActive };
}

/** A `furan_pat_*` token's owner and grant, as {@link loadActiveUserByPat} resolves it. */
export interface PatOwner {
  id: string;
  role: UserRole;
  tokenId: string;
  scopes: TokenScope[];
  /** The one project the token works on; null = the owner's member projects. */
  projectId: string | null;
  /** True once `expires_at` has passed (by the DB clock); the caller refuses it. */
  expired: boolean;
}

/**
 * Resolve a `furan_pat_*` token to its CURRENT user (role + active state) and
 * the token's grant (scopes, bound project, expiry), returning null when the
 * token is unknown or the user is deactivated. An expired token still
 * resolves, with `expired: true`, so the caller can answer `token_expired` and
 * audit it. Single source of truth for both PAT auth branches (REST hook +
 * tRPC soft-auth) so they can't drift from each other or from
 * {@link loadActiveUser}.
 */
export async function loadActiveUserByPat(
  db: DB,
  rawToken: string,
): Promise<PatOwner | null> {
  const hash = hashToken(rawToken);
  const rows = await db
    .select({
      tokenId: tokens.id,
      userId: tokens.userId,
      scopes: tokens.scopes,
      projectId: tokens.projectId,
      expired: sql<boolean>`coalesce(${tokens.expiresAt} <= now(), false)`,
      role: users.role,
      isActive: users.isActive,
    })
    .from(tokens)
    .innerJoin(users, eq(users.id, tokens.userId))
    .where(eq(tokens.hash, hash))
    .limit(1);
  const row = rows[0];
  if (!row || !row.isActive) return null;
  return {
    id: row.userId,
    role: row.role,
    tokenId: row.tokenId,
    scopes: parseScopes(row.scopes),
    projectId: row.projectId,
    expired: row.expired,
  };
}

/**
 * The stored scopes, narrowed to the known set. `tokens_scopes_chk` already
 * guarantees it; an unknown value is dropped rather than trusted, and a token
 * left with none falls back to `read`, the narrowest scope.
 */
function parseScopes(stored: string[]): TokenScope[] {
  const known = stored.filter(
    (s): s is TokenScope => tokenScopeSchema.safeParse(s).success,
  );
  return known.length > 0 ? known : ["read"];
}
