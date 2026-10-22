import { randomUUID } from "node:crypto";

import { createRedisConnection } from "@furan/queue";
import { describe, expect, it } from "vitest";

import { authKeysFor, clearAuthKeys } from "../src/stack/redis-keys.js";

describe("authKeysFor", () => {
  it("names exactly the two cache keys the api writes per user", () => {
    expect(authKeysFor(["u1", "u2"])).toEqual([
      "auth:user:u1",
      "auth:member-projects:u1",
      "auth:user:u2",
      "auth:member-projects:u2",
    ]);
    expect(authKeysFor([])).toEqual([]);
  });
});

describe("clearAuthKeys", () => {
  it("unlinks only the given users' keys, in bounded batches", async () => {
    const calls: string[][] = [];
    const ids = Array.from({ length: 600 }, (_, i) => `u${i}`);
    await clearAuthKeys(
      {
        unlink: async (...keys: string[]) => {
          calls.push(keys);
          return keys.length;
        },
      } as never,
      ids,
    );
    expect(calls.every((keys) => keys.length <= 500)).toBe(true);
    expect(calls.flat()).toEqual(authKeysFor(ids));
    // Never a pattern: no wildcard reaches Redis.
    expect(calls.flat().some((key) => key.includes("*"))).toBe(false);
  });

  it("makes no call for no users", async () => {
    let called = false;
    await clearAuthKeys(
      {
        unlink: async () => {
          called = true;
          return 0;
        },
      } as never,
      [],
    );
    expect(called).toBe(false);
  });
});

/** Against the test Redis named by SCALE_REDIS_URL; skipped without it. */
const redisUrl = process.env.SCALE_REDIS_URL;

describe.skipIf(!redisUrl)("clearAuthKeys (test Redis)", () => {
  it("removes the scratch users' keys and leaves every other auth key", async () => {
    process.env.REDIS_URL = redisUrl;
    const redis = createRedisConnection();
    const mine = randomUUID();
    const other = randomUUID();
    const keep = [
      `auth:user:${other}`,
      `auth:member-projects:${other}`,
      `auth:other-kind:${mine}`,
    ];
    try {
      for (const key of [...authKeysFor([mine]), ...keep]) {
        await redis.set(key, "x", "EX", 60);
      }
      await clearAuthKeys(redis, [mine]);
      for (const key of authKeysFor([mine])) {
        expect(await redis.exists(key)).toBe(0);
      }
      for (const key of keep) expect(await redis.exists(key)).toBe(1);
    } finally {
      await redis.unlink(...authKeysFor([mine, other]), ...keep);
      redis.disconnect();
    }
  });
});
