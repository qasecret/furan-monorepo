import type { DB } from "@furan/db";

import type { UserRole } from "../plugins/auth.js";

import { loadActiveUser } from "./load-active-user.js";
import type { UserAuthCache } from "./user-auth-cache.js";

/**
 * Cache-aware read of a user's live role + active state for the JWT auth paths.
 * Returns `{ role, isActive } | null` (null = missing); callers gate on
 * `isActive` to distinguish deactivated (403) from missing (401).
 *
 * Cache (when present) → DB on miss → cache the found result. Only existing
 * users are cached (no negative caching of "missing"). Absent cache → direct DB
 * read, identical to the no-cache behavior.
 */
export async function resolveAuthUser(
  deps: { db: DB; cache?: UserAuthCache | null },
  userId: string,
): Promise<{ role: UserRole; isActive: boolean } | null> {
  if (!userId) return null;

  if (deps.cache) {
    const cached = await deps.cache.get(userId);
    if (cached) return cached; // hit (only found users are cached)
  }

  const fresh = await loadActiveUser(deps.db, userId);
  if (fresh && deps.cache) await deps.cache.set(userId, fresh);
  return fresh;
}
