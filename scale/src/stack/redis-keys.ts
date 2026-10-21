import { users, type DB } from "@furan/db";
import type { Redis } from "@furan/queue";

import { REDIS_KEY_PATTERN } from "./constants.js";

/** The only Redis calls the cleanup makes. */
type KeyRedis = Pick<Redis, "scan" | "unlink">;

/** Deletes every Redis key under the harness's prefix (`furan-scale:*`). */
export async function clearScaleKeys(redis: KeyRedis): Promise<void> {
  let cursor = "0";
  do {
    const [next, keys] = await redis.scan(
      cursor,
      "MATCH",
      REDIS_KEY_PATTERN,
      "COUNT",
      500,
    );
    if (keys.length > 0) await redis.unlink(...keys);
    cursor = next;
  } while (cursor !== "0");
}

/**
 * The two keys the in-process api's auth caches write per user, outside the
 * `furan-scale:` prefix: the live user (`auth:user:<id>`, TTL 60 s) and the
 * member projects (`auth:member-projects:<id>`, TTL 30 s). Their names are
 * fixed in `apps/api/src/lib/user-auth-cache.ts` and `member-projects-cache.ts`.
 */
export function authKeysFor(userIds: readonly string[]): string[] {
  return userIds.flatMap((id) => [
    `auth:user:${id}`,
    `auth:member-projects:${id}`,
  ]);
}

const UNLINK_CHUNK = 500;

/**
 * Deletes the auth cache keys of exactly these users, and no other `auth:*`
 * key (a dev stack's cache lives under the same names, for its own users).
 */
export async function clearAuthKeys(
  redis: Pick<Redis, "unlink">,
  userIds: readonly string[],
): Promise<void> {
  const keys = authKeysFor(userIds);
  for (let i = 0; i < keys.length; i += UNLINK_CHUNK) {
    await redis.unlink(...keys.slice(i, i + UNLINK_CHUNK));
  }
}

/** Every user id in the scratch database: the cache keys the run may have written. */
export async function scratchUserIds(db: DB): Promise<string[]> {
  const rows = await db.select({ id: users.id }).from(users);
  return rows.map((row) => row.id);
}
