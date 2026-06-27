import type { DB } from "@furan/db";
import { describe, expect, it, vi } from "vitest";

import { resolveAuthUser } from "../src/lib/resolve-auth-user.js";
import type { UserAuthCache } from "../src/lib/user-auth-cache.js";

// A db whose query chain throws — proves a path didn't touch the DB.
const throwingDb = {
  select() {
    throw new Error("DB should not be queried");
  },
} as unknown as DB;

// A db whose select(...).from(...).where(...).limit(1) resolves to `rows`.
function dbReturning(row: { role: string; isActive: boolean } | undefined): DB {
  return {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => (row ? [row] : []) }),
      }),
    }),
  } as unknown as DB;
}

function fakeCache(get: UserAuthCache["get"]): UserAuthCache & {
  set: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
} {
  return {
    get: vi.fn(get),
    set: vi.fn(async () => {}),
    del: vi.fn(async () => {}),
  };
}

describe("resolveAuthUser", () => {
  it("returns the cached value without querying the DB", async () => {
    const cache = fakeCache(async () => ({ role: "admin", isActive: true }));
    const r = await resolveAuthUser({ db: throwingDb, cache }, "u1");
    expect(r).toEqual({ role: "admin", isActive: true });
    expect(cache.set).not.toHaveBeenCalled();
  });

  it("on a cache miss, reads the DB and populates the cache", async () => {
    const cache = fakeCache(async () => null);
    const db = dbReturning({ role: "editor", isActive: true });
    const r = await resolveAuthUser({ db, cache }, "u1");
    expect(r).toEqual({ role: "editor", isActive: true });
    expect(cache.set).toHaveBeenCalledWith("u1", {
      role: "editor",
      isActive: true,
    });
  });

  it("works with no cache (direct DB read)", async () => {
    const db = dbReturning({ role: "guest", isActive: false });
    expect(await resolveAuthUser({ db }, "u1")).toEqual({
      role: "guest",
      isActive: false,
    });
  });

  it("returns null for an empty userId, touching neither cache nor DB", async () => {
    const cache = fakeCache(async () => {
      throw new Error("cache should not be consulted");
    });
    expect(await resolveAuthUser({ db: throwingDb, cache }, "")).toBeNull();
    expect(cache.get).not.toHaveBeenCalled();
  });

  it("does not cache a missing user", async () => {
    const cache = fakeCache(async () => null);
    const db = dbReturning(undefined);
    expect(await resolveAuthUser({ db, cache }, "u1")).toBeNull();
    expect(cache.set).not.toHaveBeenCalled();
  });
});
