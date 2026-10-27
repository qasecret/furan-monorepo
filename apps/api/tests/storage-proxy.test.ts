import { randomBytes, randomUUID } from "node:crypto";

import {
  builds,
  projectMembers,
  projects,
  screenshots,
  sql,
  testRuns,
  testVariations,
  users,
  type DB,
} from "@furan/db";
import { createStorage, objectKey } from "@furan/storage";
import { describe, expect, test } from "vitest";

import type { MemberProjectsCache } from "../src/lib/member-projects-cache.js";
import { hashPassword } from "../src/lib/password.js";
import { keyOwnershipQuery } from "../src/routes/storage-proxy.js";

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
  role: "owner" | "admin" | "editor" | "guest",
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

type SeededUser = Awaited<ReturnType<typeof seedUser>>;

/** GET the proxy as `user`, a row from {@link seedUser}. */
function getAs(
  h: Awaited<ReturnType<typeof createTestApp>>,
  user: SeededUser,
  key: string,
) {
  return h.app.inject({
    method: "GET",
    url: `/api/v1/storage/${key}`,
    headers: {
      authorization: `Bearer ${h.app.jwt.sign({ sub: user.id, role: user.role })}`,
    },
  });
}

/** A storage key no other row references: 64 random hex characters. */
const unrelatedKey = () => randomBytes(32).toString("hex");

/**
 * A project with one step of its own: a build, a run, a variation and a
 * screenshot, whose image is `imageKey` (an unrelated key unless given). Any
 * other key column the proxy checks can be set: the step's `domKey`,
 * `elementMapKey` and `diffImageKey`, and the run's legacy `imageName` and
 * `diffName`.
 */
async function seedProjectWithStep(
  h: Awaited<ReturnType<typeof createTestApp>>,
  keys: {
    imageKey?: string;
    domKey?: string;
    elementMapKey?: string;
    diffImageKey?: string;
    runImageName?: string;
    runDiffName?: string;
  } = {},
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
    .values({
      buildId: build!.id,
      projectId: project!.id,
      name: "t",
      imageName: keys.runImageName ?? null,
      diffName: keys.runDiffName ?? null,
    })
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
    domKey: keys.domKey ?? null,
    elementMapKey: keys.elementMapKey ?? null,
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

  // ── Ownership: every key source, both ways ──────────────────────────────
  // The proxy attributes a key to a project through exactly these six columns
  // (and only these). Each one is checked the same way: the owning project's
  // member and an admin are served, anyone else is refused with the one
  // `not_found` body that an unknown key also gets, so a refusal never says
  // whether the key exists in another tenant.
  const KEY_SOURCES: Array<{
    column: string;
    makeKey: () => string;
    seed: (key: string) => Parameters<typeof seedProjectWithStep>[1];
  }> = [
    {
      column: "screenshots.image_key",
      makeKey: unrelatedKey,
      seed: (key) => ({ imageKey: key }),
    },
    {
      column: "screenshots.dom_key",
      makeKey: unrelatedKey,
      seed: (key) => ({ domKey: key }),
    },
    {
      column: "screenshots.element_map_key",
      makeKey: () => `${unrelatedKey()}.elements.json`,
      seed: (key) => ({ elementMapKey: key }),
    },
    {
      column: "screenshots.diff_image_key",
      makeKey: unrelatedKey,
      seed: (key) => ({ diffImageKey: key }),
    },
    {
      column: "test_runs.diff_name",
      makeKey: unrelatedKey,
      seed: (key) => ({ runDiffName: key }),
    },
    {
      column: "test_runs.image_name",
      makeKey: unrelatedKey,
      seed: (key) => ({ runImageName: key }),
    },
  ];

  const NOT_FOUND = {
    code: "not_found",
    message: "Not found",
    statusCode: 404,
  };

  test.each(KEY_SOURCES)(
    "$column: served to a member and an admin, refused to everyone else",
    async ({ makeKey, seed }) => {
      const h = await createTestApp();
      try {
        const storage = createStorage();
        const key = makeKey();
        await storage.put(key, TINY_PNG, "image/png");
        // A key no row references, with bytes: its refusal can only be the
        // authorization one.
        const unknownKey = unrelatedKey();
        await storage.put(unknownKey, TINY_PNG, "image/png");

        // Project A holds the key; its member is served.
        const { project: a } = await seedProjectWithStep(h, seed(key));
        const member = await seedUser(h, "editor");
        await h.db
          .insert(projectMembers)
          .values({ userId: member.id, projectId: a.id });
        const admin = await seedUser(h, "admin");
        // The outsider belongs to project B only, and B does not hold the key.
        const { outsider, ownKey } = await seedOutsiderWithOwnProject(h);
        // And someone who belongs to no project at all.
        const nobody = await seedUser(h, "editor");

        const get = (user: SeededUser, k: string) => getAs(h, user, k);

        const asMember = await get(member, key);
        expect(asMember.statusCode).toBe(200);
        expect(Buffer.from(asMember.rawPayload).equals(TINY_PNG)).toBe(true);

        const asAdmin = await get(admin, key);
        expect(asAdmin.statusCode).toBe(200);
        expect(Buffer.from(asAdmin.rawPayload).equals(TINY_PNG)).toBe(true);

        // The outsider's membership is real (their own key is served), yet
        // project A's key is not theirs.
        expect((await get(outsider, ownKey)).statusCode).toBe(200);
        const refusals = [
          await get(outsider, key),
          await get(nobody, key),
          await get(member, unknownKey),
        ];
        for (const res of refusals) {
          expect(res.statusCode).toBe(404);
          expect(res.json()).toEqual(NOT_FOUND);
        }
      } finally {
        await h.close();
      }
    },
  );

  test("roles: an owner is served any stored key; a guest is held to membership like an editor", async () => {
    const h = await createTestApp();
    try {
      const storage = createStorage();
      const key = unrelatedKey();
      await storage.put(key, TINY_PNG, "image/png");
      const { project: a } = await seedProjectWithStep(h, { imageKey: key });
      const owner = await seedUser(h, "owner");
      const guestMember = await seedUser(h, "guest");
      await h.db
        .insert(projectMembers)
        .values({ userId: guestMember.id, projectId: a.id });
      const guestOutsider = await seedUser(h, "guest");

      const get = (user: SeededUser, k: string) => getAs(h, user, k);

      expect((await get(owner, key)).statusCode).toBe(200);
      // A key no row references is still served to an owner: the bypass is by
      // role alone, as an admin's is.
      const loose = unrelatedKey();
      await storage.put(loose, TINY_PNG, "image/png");
      expect((await get(owner, loose)).statusCode).toBe(200);

      expect((await get(guestMember, key)).statusCode).toBe(200);
      expect((await get(guestOutsider, key)).statusCode).toBe(404);
    } finally {
      await h.close();
    }
  });

  // ── The probe's plan (budget R6) ────────────────────────────────────────
  // The probe is one statement of one `EXISTS` per key column, OR-ed, so each
  // arm is planned alone and answered by its own index, and evaluation stops
  // at the first arm that finds the key.
  interface PlanNode {
    "Node Type": string;
    "Relation Name"?: string;
    "Index Name"?: string;
    "Actual Loops"?: number;
    Plans?: PlanNode[];
  }
  const planNodes = (node: PlanNode): PlanNode[] => [
    node,
    ...(node.Plans ?? []).flatMap(planNodes),
  ];
  async function explainProbe(
    db: DB,
    projectId: string,
    key: string,
    analyze: boolean,
  ): Promise<PlanNode[]> {
    const probe = keyOwnershipQuery(db, [projectId], key);
    const rows = await db.execute<{ "QUERY PLAN": Array<{ Plan: PlanNode }> }>(
      analyze
        ? sql`EXPLAIN (ANALYZE, FORMAT JSON) ${probe}`
        : sql`EXPLAIN (FORMAT JSON) ${probe}`,
    );
    return planNodes(rows[0]!["QUERY PLAN"][0]!.Plan);
  }

  test("the ownership probe answers each key source from its own index", async () => {
    // Plans depend on table size and statistics, so seed a project large
    // enough that a sequential scan is the wrong answer for the planner too,
    // then analyze. Everything is rolled back.
    const h = await createTestApp();
    const rollback = new Error("rollback");
    const seen: {
      cold?: PlanNode[];
      hit?: PlanNode[];
    } = {};
    try {
      await h.db
        .transaction(async (tx) => {
          const [project] = await tx
            .insert(projects)
            .values({ name: `sp-${randomUUID()}` })
            .returning();
          const [build] = await tx
            .insert(builds)
            .values({ projectId: project!.id })
            .returning();
          const [variation] = await tx
            .insert(testVariations)
            .values({
              name: "home",
              projectId: project!.id,
              branchName: "main",
              browser: "chromium",
              viewport: "400x400",
            })
            .returning();
          // 20 000 runs and as many steps. About 45% of the runs and of the
          // steps carry a diff, 60% of the steps an element map, 10% a DOM
          // snapshot; every key is distinct.
          await tx.execute(sql`
            INSERT INTO test_runs (build_id, project_id, name, diff_name)
            SELECT ${build!.id}::uuid, ${project!.id}::uuid, 'r' || n,
                   CASE WHEN n % 100 < 45
                        THEN md5(random()::text) || md5(random()::text) END
              FROM generate_series(1, 20000) AS n`);
          await tx.execute(sql`
            INSERT INTO screenshots (run_id, project_id, test_variation_id, name,
                                     viewport, browser, image_key, dom_key,
                                     element_map_key, diff_image_key)
            SELECT r.id, ${project!.id}::uuid, ${variation!.id}::uuid, 'home',
                   '400x400', 'chromium',
                   md5(random()::text) || md5(random()::text),
                   CASE WHEN r.n % 10 = 0
                        THEN md5(random()::text) || md5(random()::text) END,
                   CASE WHEN r.n % 10 < 6
                        THEN md5(random()::text) || md5(random()::text)
                             || '.elements.json' END,
                   CASE WHEN r.n % 100 < 45
                        THEN md5(random()::text) || md5(random()::text) END
              FROM (SELECT id, row_number() OVER () AS n
                      FROM test_runs WHERE project_id = ${project!.id}::uuid) AS r`);
          await tx.execute(sql`ANALYZE screenshots`);
          await tx.execute(sql`ANALYZE test_runs`);

          // A key nothing holds: every arm is planned, and none is skipped.
          seen.cold = await explainProbe(
            tx as unknown as DB,
            project!.id,
            unrelatedKey(),
            false,
          );
          // A key a step's image holds: the first arm finds it, and the rest
          // never run.
          const [step] = await tx.execute<{ key: string }>(sql`
            SELECT image_key AS key FROM screenshots
             WHERE project_id = ${project!.id}::uuid LIMIT 1`);
          seen.hit = await explainProbe(
            tx as unknown as DB,
            project!.id,
            step!.key,
            true,
          );
          throw rollback;
        })
        .catch((err: unknown) => {
          if (err !== rollback) throw err;
        });

      // Each key column of `screenshots` is read through its own index by a
      // plain index scan: never a sequential scan, and never a bitmap scan,
      // which has to collect every match of a shared key before it returns
      // the first.
      const shots = seen
        .cold!.filter((n) => n["Relation Name"] === "screenshots")
        .map((n) => [n["Node Type"], n["Index Name"]]);
      expect(shots).toEqual([
        ["Index Scan", "screenshots_image_key_idx"],
        ["Index Scan", "screenshots_diff_image_key_idx"],
        ["Index Scan", "screenshots_element_map_key_idx"],
        ["Index Scan", "screenshots_dom_key_idx"],
      ]);
      // The run's legacy diff image is read through its partial index too.
      const runs = seen
        .cold!.filter((n) => n["Relation Name"] === "test_runs")
        .map((n) => [n["Node Type"], n["Index Name"]]);
      expect(runs).toContainEqual(["Index Scan", "test_runs_diff_name_idx"]);

      // A hit in the first arm stops there: no other table or index is read.
      const ran = seen.hit!.filter(
        (n) => n["Relation Name"] !== undefined && (n["Actual Loops"] ?? 0) > 0,
      );
      expect(ran.map((n) => n["Index Name"])).toEqual([
        "screenshots_image_key_idx",
      ]);
    } finally {
      await h.close();
    }
  });
});
