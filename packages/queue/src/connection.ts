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
