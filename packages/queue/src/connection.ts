import { getSecret } from "@furan/config";
import { Redis } from "ioredis";

export function createRedisConnection(): Redis {
  return new Redis(getSecret("REDIS_URL"), {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
}
