import { randomBytes, randomUUID } from "node:crypto";

import {
  builds,
  projectMembers,
  projects,
  screenshots,
  testRuns,
  testVariations,
  users,
} from "@furan/db";
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

/** A storage key no other row references: 64 random hex characters. */
const unrelatedKey = () => randomBytes(32).toString("hex");

/**
 * A project with one step of its own: a build, a run, a variation and a
 * screenshot, whose image is `imageKey` (an unrelated key unless given) and
 * whose diff image is `diffImageKey`.
 */
async function seedProjectWithStep(
  h: Awaited<ReturnType<typeof createTestApp>>,
  keys: { imageKey?: string; diffImageKey?: string } = {},
) {
  const [project] = await h.db
    .insert(projects)
    .values({ name: `sp-${randomUUID()}` })
    .returning();
  const [build] = await h.db
    .insert(builds)
    .values({ projectId: project!.id })
    .returning();
  const [run] = await h.db
    .insert(testRuns)
    .values({ buildId: build!.id, projectId: project!.id, name: "t" })
    .returning();
  const [variation] = await h.db
    .insert(testVariations)
    .values({
      name: "home",
      projectId: project!.id,
      branchName: "main",
      browser: "chromium",
      viewport: "400x400",
    })
    .returning();
  await h.db.insert(screenshots).values({
    runId: run!.id,
    projectId: project!.id,
    testVariationId: variation!.id,
    name: "home",
    imageKey: keys.imageKey ?? unrelatedKey(),
    viewport: "400x400",
    browser: "chromium",
    diffImageKey: keys.diffImageKey ?? null,
  });
  return { project: project!, build: build! };
}

/**
 * An editor who is a member of a project of their own, B, which has a step
 * whose image is `ownKey` (its bytes stored): a caller with a real
 * membership, so the proxy's project scoping runs for them (an editor with
 * none is turned away before any key is looked up).
 */
async function seedOutsiderWithOwnProject(
  h: Awaited<ReturnType<typeof createTestApp>>,
) {
  const outsider = await seedUser(h, "editor");
  const ownKey = unrelatedKey();
  await createStorage().put(ownKey, TINY_PNG, "image/png");
  const { project } = await seedProjectWithStep(h, { imageKey: ownKey });
  await h.db
    .insert(projectMembers)
    .values({ userId: outsider.id, projectId: project.id });
  return { outsider, ownKey };
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

  test("serves a step's own diff image to a member, and 404s a non-member", async () => {
    // A step's diff image is referenced only by `screenshots.diff_image_key`
    // (the run's `diff_name` names its worst step's), so the proxy must
    // attribute that column to the project too.
    const h = await createTestApp();
    try {
      const storage = createStorage();
      const key = objectKey(TINY_PNG);
      await storage.put(key, TINY_PNG, "image/png");

      // Project A's step has the diff image.
      const { project: a } = await seedProjectWithStep(h, {
        diffImageKey: key,
      });
      const member = await seedUser(h, "editor");
      await h.db
        .insert(projectMembers)
        .values({ userId: member.id, projectId: a.id });
      // The outsider is a member of B only, with a step of its own: the
      // lookup runs, scoped to B, and must not find A's row.
      const { outsider, ownKey } = await seedOutsiderWithOwnProject(h);

      const asMember = await h.app.inject({
        method: "GET",
        url: `/api/v1/storage/${key}`,
        headers: {
          authorization: `Bearer ${h.app.jwt.sign({ sub: member.id, role: "editor" })}`,
        },
      });
      expect(asMember.statusCode).toBe(200);
      expect(Buffer.from(asMember.rawPayload).equals(TINY_PNG)).toBe(true);

      const outsiderGets = (k: string) =>
        h.app.inject({
          method: "GET",
          url: `/api/v1/storage/${k}`,
          headers: {
            authorization: `Bearer ${h.app.jwt.sign({ sub: outsider.id, role: "editor" })}`,
          },
        });
      // Their own project's image: the membership is real.
      expect((await outsiderGets(ownKey)).statusCode).toBe(200);
      // Project A's diff image: not theirs.
      expect((await outsiderGets(key)).statusCode).toBe(404);
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

      // Another tenant, A, owns the key: as a step's image and as its run's
      // diff.
      const { project: a, build } = await seedProjectWithStep(h, {
        imageKey: key,
      });
      await h.db.insert(testRuns).values({
        buildId: build.id,
        projectId: a.id,
        name: "t2",
        diffName: key,
      });

      // An editor of another project, B, must NOT be able to read it, even
      // though the bytes are present in storage: the lookup runs for B and
      // must not find A's rows.
      const { outsider, ownKey } = await seedOutsiderWithOwnProject(h);
      const token = h.app.jwt.sign({ sub: outsider.id, role: "editor" });
      const get = (k: string) =>
        h.app.inject({
          method: "GET",
          url: `/api/v1/storage/${k}`,
          headers: { authorization: `Bearer ${token}` },
        });

      expect((await get(ownKey)).statusCode).toBe(200);
      expect((await get(key)).statusCode).toBe(404);
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
