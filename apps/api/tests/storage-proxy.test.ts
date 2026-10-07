import { randomUUID } from "node:crypto";

import { builds, projectMembers, projects, testRuns, users } from "@furan/db";
import { createStorage, objectKey } from "@furan/storage";
import { describe, expect, test } from "vitest";

import type { MemberProjectsCache } from "../src/lib/member-projects-cache.js";
import { hashPassword } from "../src/lib/password.js";

import { createTestApp } from "./helpers.js";

/** In-memory {@link MemberProjectsCache} for exercising the hot-path cache. */
function fakeCache(): MemberProjectsCache {
  const store = new Map<string, string[]>();
  return {
    get: (userId) => Promise.resolve(store.get(userId) ?? null),
    set: (userId, projectIds) => {
      store.set(userId, projectIds);
      return Promise.resolve();
    },
    del: (userId) => {
      store.delete(userId);
      return Promise.resolve();
    },
  };
}

const skip =
  !process.env.DATABASE_URL ||
  !process.env.S3_ENDPOINT ||
  !process.env.S3_BUCKET ||
  !process.env.S3_ACCESS_KEY ||
  !process.env.S3_SECRET_KEY;
const d = skip ? describe.skip : describe;

// Minimal but valid 1×1 PNG (decodes cleanly + carries proper magic bytes).
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII=",
  "base64",
);

// Seed a real user (auth resolves the LIVE user from the DB, so a JWT for a
// non-existent id is rejected — every authenticated case needs a real row).
// Unique email per call so repeated local runs against the shared dev DB
// don't collide on the users.email unique constraint.
async function seedUser(
  h: Awaited<ReturnType<typeof createTestApp>>,
  role: "admin" | "editor",
) {
  const [u] = await h.db
    .insert(users)
    .values({
      email: `sp-${role}-${randomUUID()}@t.example`,
      hashedPassword: await hashPassword("pw-not-checked-here"),
      firstName: "SP",
      lastName: role,
      role,
      isActive: true,
    })
    .returning();
  if (!u) throw new Error("user not seeded");
  return u;
}

d("GET /api/v1/storage/:key", () => {
  test("serves the bytes + image/png content-type for an admin", async () => {
    const h = await createTestApp();
    try {
      const storage = createStorage();
      const key = objectKey(TINY_PNG);
      await storage.put(key, TINY_PNG, "image/png");

      const admin = await seedUser(h, "admin");
      const token = h.app.jwt.sign({ sub: admin.id, role: "admin" });

      const res = await h.app.inject({
        method: "GET",
        url: `/api/v1/storage/${key}`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toBe("image/png");
      expect(res.headers["cache-control"]).toContain("max-age=300");
      // Authenticated, project-scoped bytes: browser-cacheable, but a shared
      // cache (corporate proxy / CDN) must never store and re-serve them.
      expect(res.headers["cache-control"]).toContain("private");
      expect(res.headers["cache-control"]).not.toContain("public");
      // The global lock-down CSP covers the bytes too (see security-headers.test).
      expect(res.headers["content-security-policy"]).toContain(
        "default-src 'none'",
      );
      expect(Buffer.from(res.rawPayload).equals(TINY_PNG)).toBe(true);
    } finally {
      await h.close();
    }
  });

  test("serves a key owned by a project the caller is a member of", async () => {
    const h = await createTestApp();
    try {
      const storage = createStorage();
      const key = objectKey(TINY_PNG);
      await storage.put(key, TINY_PNG, "image/png");

      const [proj] = await h.db
        .insert(projects)
        .values({ name: `sp-${randomUUID()}` })
        .returning();
      const editor = await seedUser(h, "editor");
      await h.db
        .insert(projectMembers)
        .values({ userId: editor.id, projectId: proj!.id });
      const [build] = await h.db
        .insert(builds)
        .values({ projectId: proj!.id })
        .returning();
      // Attribute the key to the project via a test_runs.diff_name row.
      await h.db.insert(testRuns).values({
        buildId: build!.id,
        projectId: proj!.id,
        name: "t",
        diffName: key,
      });

      const token = h.app.jwt.sign({ sub: editor.id, role: "editor" });
      const res = await h.app.inject({
        method: "GET",
        url: `/api/v1/storage/${key}`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      expect(Buffer.from(res.rawPayload).equals(TINY_PNG)).toBe(true);
    } finally {
      await h.close();
    }
  });

  test("404 for a non-member even when the bytes exist (cross-tenant)", async () => {
    const h = await createTestApp();
    try {
      const storage = createStorage();
      const key = objectKey(TINY_PNG);
      await storage.put(key, TINY_PNG, "image/png");

      // An editor with no project membership must NOT be able to read a key
      // owned by another tenant, even though the bytes are present in storage.
      const outsider = await seedUser(h, "editor");
      const token = h.app.jwt.sign({ sub: outsider.id, role: "editor" });

      const res = await h.app.inject({
        method: "GET",
        url: `/api/v1/storage/${key}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await h.close();
    }
  });

  test("returns 404 for a nonexistent key", async () => {
    const h = await createTestApp();
    try {
      const admin = await seedUser(h, "admin");
      const token = h.app.jwt.sign({ sub: admin.id, role: "admin" });
      const fakeKey = "0".repeat(64);

      const res = await h.app.inject({
        method: "GET",
        url: `/api/v1/storage/${fakeKey}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await h.close();
    }
  });

  test("returns 401 when unauthenticated", async () => {
    const h = await createTestApp();
    try {
      const res = await h.app.inject({
        method: "GET",
        url: `/api/v1/storage/${"0".repeat(64)}`,
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await h.close();
    }
  });

  test("returns 404 for a malformed (non-sha256) key", async () => {
    const h = await createTestApp();
    try {
      const admin = await seedUser(h, "admin");
      const token = h.app.jwt.sign({ sub: admin.id, role: "admin" });
      const res = await h.app.inject({
        method: "GET",
        url: `/api/v1/storage/not-a-real-key`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await h.close();
    }
  });

  test("serves a `.elements.json` sidecar with application/json content-type", async () => {
    const h = await createTestApp();
    try {
      const storage = createStorage();
      // 64-hex prefix + the `.elements.json` suffix is the on-disk key
      // the SDK writes (PR #61). The proxy must serve this byte-identical.
      const key = "a".repeat(64) + ".elements.json";
      const payload = '{"v":1,"elements":{},"capturedAt":0}';
      await storage.put(key, Buffer.from(payload), "application/json");

      const admin = await seedUser(h, "admin");
      const token = h.app.jwt.sign({ sub: admin.id, role: "admin" });

      const res = await h.app.inject({
        method: "GET",
        url: `/api/v1/storage/${key}`,
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toMatch(/application\/json/);
      expect(res.body).toBe(payload);
    } finally {
      await h.close();
    }
  });

  test("uses the member-projects cache: hit authorizes without a membership row", async () => {
    const h = await createTestApp({ memberProjectsCache: fakeCache() });
    try {
      const storage = createStorage();
      const key = objectKey(TINY_PNG);
      await storage.put(key, TINY_PNG, "image/png");

      // Project + key attribution exist, but the caller has NO project_members
      // row — authorization must come from the pre-seeded cache entry.
      const [proj] = await h.db
        .insert(projects)
        .values({ name: `sp-${randomUUID()}` })
        .returning();
      const editor = await seedUser(h, "editor");
      const [build] = await h.db
        .insert(builds)
        .values({ projectId: proj!.id })
        .returning();
      await h.db.insert(testRuns).values({
        buildId: build!.id,
        projectId: proj!.id,
        name: "t",
        diffName: key,
      });

      const cache = h.app.memberProjectsCache!;
      await cache.set(editor.id, [proj!.id]);

      const token = h.app.jwt.sign({ sub: editor.id, role: "editor" });
      const res = await h.app.inject({
        method: "GET",
        url: `/api/v1/storage/${key}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await h.close();
    }
  });

  test("populates the member-projects cache on a miss", async () => {
    const cache = fakeCache();
    const h = await createTestApp({ memberProjectsCache: cache });
    try {
      const storage = createStorage();
      const key = objectKey(TINY_PNG);
      await storage.put(key, TINY_PNG, "image/png");

      const [proj] = await h.db
        .insert(projects)
        .values({ name: `sp-${randomUUID()}` })
        .returning();
      const editor = await seedUser(h, "editor");
      await h.db
        .insert(projectMembers)
        .values({ userId: editor.id, projectId: proj!.id });
      const [build] = await h.db
        .insert(builds)
        .values({ projectId: proj!.id })
        .returning();
      await h.db.insert(testRuns).values({
        buildId: build!.id,
        projectId: proj!.id,
        name: "t",
        diffName: key,
      });

      expect(await cache.get(editor.id)).toBeNull(); // cold

      const token = h.app.jwt.sign({ sub: editor.id, role: "editor" });
      const res = await h.app.inject({
        method: "GET",
        url: `/api/v1/storage/${key}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      // The DB membership read populated the cache with the resolved set.
      expect(await cache.get(editor.id)).toEqual([proj!.id]);
    } finally {
      await h.close();
    }
  });

  test("rejects keys with non-`.elements.json` suffixes as 404", async () => {
    const h = await createTestApp();
    try {
      const admin = await seedUser(h, "admin");
      const token = h.app.jwt.sign({ sub: admin.id, role: "admin" });
      const key = "a".repeat(64) + ".bogus";
      const res = await h.app.inject({
        method: "GET",
        url: `/api/v1/storage/${key}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await h.close();
    }
  });
});
