import { getSecret } from "@furan/config";
import { Redis } from "ioredis";

export type { Redis } from "ioredis";

export function createRedisConnection(): Redis {
  return new Redis(getSecret("REDIS_URL"), {
    // BullMQ requires unbounded per-request retries and no ready check.
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    // Fail a connect attempt in 10s instead of hanging boot on an
    // unreachable Redis. Reconnection stays enabled (BullMQ relies on it).
    connectTimeout: 10_000,
  });
}

/**
 * Connection for request-path commands that must FAIL FAST while Redis is
 * down — the api's shared rate-limit store (ADR-063). The BullMQ connection
 * above retries a command forever, which would hang the HTTP request (a
 * login) for the length of a Redis outage. Here a command errors immediately
 * while disconnected (no offline queue), never waits more than 500 ms for a
 * reply (covers a hung / partitioned Redis whose socket stays open), and a
 * connect attempt gives up after 500 ms; `maxRetriesPerRequest: 1` per the
 * @fastify/rate-limit README. Reconnection stays enabled. Callers must treat
 * an error as "store unavailable" (the rate limiter fails open). `url`
 * defaults to REDIS_URL.
 */
export function createFailFastRedisConnection(
  url: string = getSecret("REDIS_URL"),
): Redis {
  return new Redis(url, {
    connectTimeout: 500,
    commandTimeout: 500,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
}
