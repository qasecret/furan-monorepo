import { describe, expect, it } from "vitest";

import {
  createRedisUserAuthCache,
  type RedisLike,
} from "../src/lib/user-auth-cache.js";

function fakeRedis(): RedisLike {
  const store = new Map<string, string>();
  return {
    get: async (k) => store.get(k) ?? null,
    set: async (k, v) => {
      store.set(k, v);
      return "OK";
    },
    del: async (k) => (store.delete(k) ? 1 : 0),
  };
}

describe("createRedisUserAuthCache", () => {
  it("round-trips set → get", async () => {
    const cache = createRedisUserAuthCache(fakeRedis());
    await cache.set("u1", { role: "admin", isActive: true });
    expect(await cache.get("u1")).toEqual({ role: "admin", isActive: true });
  });

  it("returns null for an unknown key", async () => {
    expect(await createRedisUserAuthCache(fakeRedis()).get("nope")).toBeNull();
  });

  it("del removes the entry", async () => {
    const cache = createRedisUserAuthCache(fakeRedis());
    await cache.set("u1", { role: "editor", isActive: true });
    await cache.del("u1");
    expect(await cache.get("u1")).toBeNull();
  });

  it("treats a redis get error as a miss (never throws)", async () => {
    const cache = createRedisUserAuthCache({
      get: async () => {
        throw new Error("redis down");
      },
      set: async () => "OK",
      del: async () => 1,
    });
    expect(await cache.get("u1")).toBeNull();
  });

  it("swallows set/del errors (best-effort)", async () => {
    const cache = createRedisUserAuthCache({
      get: async () => null,
      set: async () => {
        throw new Error("redis down");
      },
      del: async () => {
        throw new Error("redis down");
      },
    });
    await expect(
      cache.set("u1", { role: "guest", isActive: true }),
    ).resolves.toBeUndefined();
    await expect(cache.del("u1")).resolves.toBeUndefined();
  });
});
