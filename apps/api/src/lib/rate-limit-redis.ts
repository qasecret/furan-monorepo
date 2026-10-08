import { createFailFastRedisConnection, type Redis } from "@furan/queue";

/** Minimal logger surface (pino-compatible) — keeps this free of a pino dep. */
interface StoreLogger {
  warn(obj: object, msg: string): void;
  info(msg: string): void;
}

/**
 * Dedicated Redis connection for the shared @fastify/rate-limit store
 * (ADR-063). Fail-fast options (see `createFailFastRedisConnection`) so a
 * Redis outage makes the limiter fail OPEN (`skipOnError`) instead of hanging
 * logins. The plugin swallows store errors silently, so the outage is
 * surfaced here instead: one warn when the connection first errors, one info
 * when it is back — not one line per request or per reconnect attempt.
 */
export function createRateLimitRedis(logger: StoreLogger, url?: string): Redis {
  const redis = createFailFastRedisConnection(url);
  let degraded = false;
  redis.on("error", (err: Error) => {
    if (degraded) return;
    degraded = true;
    logger.warn({ err }, "rate_limit_store_unavailable_failing_open");
  });
  redis.on("ready", () => {
    if (!degraded) return;
    degraded = false;
    logger.info("rate_limit_store_recovered");
  });
  return redis;
}
