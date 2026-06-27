import type { UserRole } from "../plugins/auth.js";

/** Cached liveness snapshot for a user (keyed by user id). */
export interface CachedUserAuth {
  role: UserRole;
  isActive: boolean;
}

/**
 * Optional cache in front of the per-JWT-request user lookup. Absent (tests, or
 * a deploy without it wired) → callers fall through to a direct DB read, so
 * behavior is unchanged. Demotion/deactivation stays immediate because the cache
 * is invalidated on every role/active change (see routes/users-admin.ts); the
 * TTL is only a self-healing safety net for a missed invalidation.
 */
export interface UserAuthCache {
  get(userId: string): Promise<CachedUserAuth | null>;
  set(userId: string, value: CachedUserAuth): Promise<void>;
  del(userId: string): Promise<void>;
}

/** Minimal Redis surface we use — avoids a direct ioredis dependency. */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ex: "EX", seconds: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

const cacheKey = (userId: string) => `auth:user:${userId}`;

/**
 * Redis-backed {@link UserAuthCache}. All ops are best-effort: a get/set failure
 * is swallowed and treated as a cache miss (the request proceeds via the DB), so
 * a Redis blip never fails authentication. A `del` failure is logged by the
 * caller path's nearest logger — at worst the entry self-heals at TTL.
 */
export function createRedisUserAuthCache(
  redis: RedisLike,
  ttlSec = 60,
): UserAuthCache {
  return {
    async get(userId) {
      try {
        const raw = await redis.get(cacheKey(userId));
        if (!raw) return null;
        return JSON.parse(raw) as CachedUserAuth;
      } catch {
        return null; // treat any cache error as a miss
      }
    },
    async set(userId, value) {
      try {
        await redis.set(cacheKey(userId), JSON.stringify(value), "EX", ttlSec);
      } catch {
        // best-effort — a failed write just means the next read hits the DB
      }
    },
    async del(userId) {
      try {
        await redis.del(cacheKey(userId));
      } catch {
        // best-effort — a missed invalidation self-heals at TTL
      }
    },
  };
}
