import type { RedisLike } from "./user-auth-cache.js";

/**
 * Optional cache for the set of project ids a user belongs to. The storage
 * proxy (`GET /api/v1/storage/:key`) authorizes every image fetch against this
 * set, and the diff viewer fetches many images per page — without a cache each
 * fetch re-runs the identical `project_members` lookup. The set is stable per
 * user between membership changes, so a short TTL eliminates the N round-trips.
 *
 * Absent (tests, or a deploy without it wired) → callers fall through to a
 * direct DB read, so behavior is unchanged. There is deliberately no explicit
 * invalidation on membership mutation: the TTL is short enough that a
 * newly-added / removed member self-heals within it, and the guarded content
 * is content-addressed (unguessable sha256 keys), so the bounded window is not
 * a meaningful cross-tenant exposure. Keep the TTL short if that calculus
 * changes.
 */
export interface MemberProjectsCache {
  get(userId: string): Promise<string[] | null>;
  set(userId: string, projectIds: string[]): Promise<void>;
  del(userId: string): Promise<void>;
}

const cacheKey = (userId: string) => `auth:member-projects:${userId}`;

/**
 * Redis-backed {@link MemberProjectsCache}. All ops are best-effort: a get/set
 * failure is swallowed and treated as a cache miss (the request proceeds via
 * the DB), so a Redis blip never fails authorization.
 */
export function createRedisMemberProjectsCache(
  redis: RedisLike,
  ttlSec = 30,
): MemberProjectsCache {
  return {
    async get(userId) {
      try {
        const raw = await redis.get(cacheKey(userId));
        if (!raw) return null;
        const parsed = JSON.parse(raw) as unknown;
        return Array.isArray(parsed)
          ? parsed.filter((v): v is string => typeof v === "string")
          : null;
      } catch {
        return null; // treat any cache error as a miss
      }
    },
    async set(userId, projectIds) {
      try {
        await redis.set(
          cacheKey(userId),
          JSON.stringify(projectIds),
          "EX",
          ttlSec,
        );
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
