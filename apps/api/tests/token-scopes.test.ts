import type { AddressInfo } from "node:net";

import {
  and,
  auditLog,
  builds,
  checkpointDecisions,
  eq,
  projectMembers,
  projects,
  screenshots,
  sql,
  testRuns,
  testVariations,
  tokens,
  users,
} from "@furan/db";
import type { CheckpointVerdict, TokenScope } from "@furan/shared-types";
import { createStorage, objectKey } from "@furan/storage";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";

import { hashPassword } from "../src/lib/password.js";
import { resetTokenDenialAudit } from "../src/lib/token-access.js";
import { generateRawToken } from "../src/lib/token.js";
import { tokenPolicy } from "../src/routes/tokens.js";
import type { AppRouter } from "../src/trpc/v1/router.js";

import { createTestApp, type TestApp } from "./helpers.js";

/**
 * ADR-064 step B — scoped API tokens:
 *   - mint: scopes (`sdk` default, `read`), an optional project binding and an
 *     expiry (default 90 days, capped by FURAN_PAT_MAX_LIFETIME_DAYS);
 *   - an expired token → 401 `token_expired`;
 *   - a scoped token uses only REST routes that opt in (`tokenAccess`), never
 *     tRPC (`session_required`); a `read` token can't write
 *     (`insufficient_scope`);
 *   - bound → that project only (an admin skips membership there); unbound →
 *     member projects only, no admin bypass;
 *   - its approve accepts only `new` checkpoints;
 *   - refusals are audited (`token.denied`, throttled).
 * `legacy` tokens keep step A (pat-session-only.test.ts).
 */

const d =
  !process.env.DATABASE_URL ||
  !process.env.S3_ENDPOINT ||
  !process.env.S3_BUCKET ||
  !process.env.S3_ACCESS_KEY ||
  !process.env.S3_SECRET_KEY
    ? describe.skip
    : describe;

// Minimal but valid 1×1 PNG.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII=",
  "base64",
);

type Role = "admin" | "editor";

interface Principal {
  id: string;
  jwt: string;
}

interface Seeded {
  admin: Principal;
  editor: Principal;
  /** Both principals are members. */
  projectA: string;
  /** Only the editor is a member. */
  projectB: string;
  /** Nobody is a member. */
  projectC: string;
}

async function seedPrincipal(h: TestApp, role: Role): Promise<Principal> {
  const [user] = await h.db
    .insert(users)
    .values({
      email: `scoped-${role}@t.example`,
      hashedPassword: await hashPassword("x"),
      firstName: "Scoped",
      lastName: role,
      role,
      isActive: true,
    })
    .returning();
  if (!user) throw new Error(`${role} not seeded`);
  return { id: user.id, jwt: h.app.jwt.sign({ sub: user.id, role }) };
}

async function seed(h: TestApp): Promise<Seeded> {
  // FK-order: dependents before parents (tokens cascade with users/projects).
  await h.db.delete(auditLog);
  await h.db.delete(screenshots);
  await h.db.delete(testRuns);
  await h.db.delete(builds);
  await h.db.delete(projectMembers);
  await h.db.delete(projects);
  await h.db.delete(users);

  const admin = await seedPrincipal(h, "admin");
  const editor = await seedPrincipal(h, "editor");
  const made = await h.db
    .insert(projects)
    .values([{ name: "scoped-a" }, { name: "scoped-b" }, { name: "scoped-c" }])
    .returning({ id: projects.id, name: projects.name });
  const id = (name: string) => made.find((p) => p.name === name)!.id;
  await h.db.insert(projectMembers).values([
    { projectId: id("scoped-a"), userId: admin.id },
    { projectId: id("scoped-a"), userId: editor.id },
    { projectId: id("scoped-b"), userId: editor.id },
  ]);
  return {
    admin,
    editor,
    projectA: id("scoped-a"),
    projectB: id("scoped-b"),
    projectC: id("scoped-c"),
  };
}

/**
 * Insert a token directly (the raw/hash pair the mint route produces), so the
 * mint route's per-instance rate limit doesn't couple these tests.
 */
async function insertToken(
  h: TestApp,
  userId: string,
  grant: {
    scopes?: TokenScope[];
    projectId?: string | null;
    expired?: boolean;
  } = {},
): Promise<{ raw: string; id: string }> {
  const { raw, hash } = generateRawToken();
  const [row] = await h.db
    .insert(tokens)
    .values({
      userId,
      label: "scoped-ci",
      hash,
      scopes: grant.scopes ?? ["sdk"],
      projectId: grant.projectId ?? null,
      expiresAt: grant.expired
        ? sql`now() - interval '1 minute'`
        : sql`now() + interval '1 day'`,
    })
    .returning({ id: tokens.id });
  return { raw, id: row!.id };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function deniedAudits(h: TestApp, tokenId: string) {
  return h.db
    .select({ metadata: auditLog.metadata, actorId: auditLog.actorId })
    .from(auditLog)
    .where(
      and(eq(auditLog.action, "token.denied"), eq(auditLog.targetId, tokenId)),
    );
}

describe("tokenPolicy", () => {
  test("the default cap (365) offers every preset and defaults to 90 days", () => {
    expect(tokenPolicy(365)).toEqual({
      lifetimeDays: [7, 30, 90, 180, 365],
      defaultLifetimeDays: 90,
      allowNoExpiry: false,
    });
  });

  test("a lower cap trims the presets, offers the cap itself and lowers the default", () => {
    expect(tokenPolicy(60)).toEqual({
      lifetimeDays: [7, 30, 60],
      defaultLifetimeDays: 60,
      allowNoExpiry: false,
    });
  });

  test("cap 0 allows tokens that never expire", () => {
    expect(tokenPolicy(0)).toEqual({
      lifetimeDays: [7, 30, 90, 180, 365],
      defaultLifetimeDays: 90,
      allowNoExpiry: true,
    });
  });
});

d("scoped API tokens (ADR-064 step B)", () => {
  let h: TestApp;
  let baseUrl: string;
  let s: Seeded;

  beforeAll(async () => {
    h = await createTestApp({ skipReady: true });
    await h.app.listen({ host: "127.0.0.1", port: 0 });
    const addr = h.app.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    resetTokenDenialAudit();
    s = await seed(h);
  });

  function trpc(token: string) {
    return createTRPCClient<AppRouter>({
      links: [
        httpBatchLink({ url: `${baseUrl}/trpc`, headers: bearer(token) }),
      ],
    });
  }

  function createBuild(token: string, projectId: string) {
    return h.app.inject({
      method: "POST",
      url: `/projects/${projectId}/builds`,
      headers: bearer(token),
      payload: { branchName: "main", name: "scoped-build" },
    });
  }

  // -------------------------------------------------------------------------
  // Minting
  // -------------------------------------------------------------------------

  describe("mint", () => {
    function mint(jwt: string, payload: Record<string, unknown>) {
      return h.app.inject({
        method: "POST",
        url: "/account/tokens",
        headers: bearer(jwt),
        payload,
      });
    }

    test("defaults: sdk, unbound, 90 days; audited with the grant", async () => {
      const res = await mint(s.editor.jwt, { label: "ci" });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body).toMatchObject({
        label: "ci",
        scopes: ["sdk"],
        projectId: null,
        token: expect.stringMatching(/^furan_pat_/),
      });
      const days =
        (new Date(body.expiresAt).getTime() - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(89.9);
      expect(days).toBeLessThan(90.1);

      const [audit] = await h.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, "token.created"));
      expect(audit).toMatchObject({
        actorId: s.editor.id,
        targetId: body.id,
        metadata: {
          label: "ci",
          scopes: ["sdk"],
          projectId: null,
          expiresAt: new Date(body.expiresAt).toISOString(),
        },
      });
      expect(JSON.stringify(audit?.metadata)).not.toContain(body.token);
    });

    test("read scope; sdk wins over read; a lifetime and a member project", async () => {
      const read = await mint(s.editor.jwt, {
        label: "reader",
        scopes: ["read"],
        expiresInDays: 7,
        projectId: s.projectB,
      });
      expect(read.statusCode).toBe(201);
      expect(read.json()).toMatchObject({
        scopes: ["read"],
        projectId: s.projectB,
      });
      const days =
        (new Date(read.json().expiresAt).getTime() - Date.now()) / 86_400_000;
      expect(Math.round(days)).toBe(7);

      const both = await mint(s.editor.jwt, {
        label: "both",
        scopes: ["read", "sdk"],
      });
      expect(both.json()).toMatchObject({ scopes: ["sdk"] });
    });

    test("a lifetime over the cap, or none, is refused", async () => {
      const long = await mint(s.editor.jwt, {
        label: "long",
        expiresInDays: 366,
      });
      expect(long.statusCode).toBe(400);
      expect(long.json()).toMatchObject({ code: "expiry_too_long" });

      const never = await mint(s.editor.jwt, {
        label: "never",
        expiresInDays: null,
      });
      expect(never.statusCode).toBe(400);
      expect(never.json()).toMatchObject({ code: "expiry_required" });
    });

    test("unknown scopes are invalid; `legacy` can't be minted", async () => {
      for (const scopes of [["legacy"], ["admin"], []]) {
        const res = await mint(s.editor.jwt, { label: "bad", scopes });
        expect(res.statusCode).toBe(400);
      }
    });

    test("binding: an editor only to a member project; an admin to any project", async () => {
      // Its own app: the mint route allows 10 requests an hour per instance.
      const fresh = await createTestApp({ skipReady: true });
      try {
        const mintFresh = (jwt: string, payload: Record<string, unknown>) =>
          fresh.app.inject({
            method: "POST",
            url: "/account/tokens",
            headers: bearer(jwt),
            payload,
          });
        const notMember = await mintFresh(s.editor.jwt, {
          label: "c",
          projectId: s.projectC,
        });
        expect(notMember.statusCode).toBe(404);
        expect(notMember.json()).toMatchObject({ code: "project_not_found" });

        const missing = await mintFresh(s.editor.jwt, {
          label: "x",
          projectId: "00000000-0000-4000-8000-000000000000",
        });
        expect(missing.statusCode).toBe(404);

        const admin = await mintFresh(s.admin.jwt, {
          label: "c",
          projectId: s.projectC,
        });
        expect(admin.statusCode).toBe(201);
        expect(admin.json()).toMatchObject({ projectId: s.projectC });
      } finally {
        await fresh.close();
      }
    });

    test("list shows the grant, the bound project's name and the last use", async () => {
      const bound = await insertToken(h, s.editor.id, {
        scopes: ["read"],
        projectId: s.projectB,
      });
      const used = await h.app.inject({
        method: "GET",
        url: "/users/me",
        headers: bearer(bound.raw),
      });
      expect(used.statusCode).toBe(200);

      const res = await h.app.inject({
        method: "GET",
        url: "/account/tokens",
        headers: bearer(s.editor.jwt),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([
        {
          id: bound.id,
          label: "scoped-ci",
          createdAt: expect.any(String),
          lastUsedAt: expect.any(String),
          lastUsedIp: "127.0.0.1",
          scopes: ["read"],
          projectId: s.projectB,
          projectName: "scoped-b",
          expiresAt: expect.any(String),
        },
      ]);
    });

    test("GET /account/token-policy is session-only and reports the cap", async () => {
      const res = await h.app.inject({
        method: "GET",
        url: "/account/token-policy",
        headers: bearer(s.editor.jwt),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(tokenPolicy(365));

      const pat = await insertToken(h, s.editor.id);
      const viaPat = await h.app.inject({
        method: "GET",
        url: "/account/token-policy",
        headers: bearer(pat.raw),
      });
      expect(viaPat.statusCode).toBe(403);
      expect(viaPat.json()).toMatchObject({ code: "session_required" });
    });
  });

  // -------------------------------------------------------------------------
  // Expiry
  // -------------------------------------------------------------------------

  test("an expired token → 401 token_expired (REST) / UNAUTHORIZED (tRPC), audited once", async () => {
    const t = await insertToken(h, s.editor.id, {
      scopes: ["legacy"],
      expired: true,
    });
    for (let i = 0; i < 2; i++) {
      const res = await createBuild(t.raw, s.projectA);
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ code: "token_expired" });
    }
    await expect(trpc(t.raw).inbox.list.query({})).rejects.toMatchObject({
      data: { code: "UNAUTHORIZED" },
    });

    const audits = await deniedAudits(h, t.id);
    expect(audits).toEqual([
      {
        actorId: s.editor.id,
        metadata: {
          reason: "expired",
          method: "POST",
          route: "/projects/:id/builds",
        },
      },
    ]);
  });

  // -------------------------------------------------------------------------
  // Route scopes
  // -------------------------------------------------------------------------

  describe("route scopes", () => {
    test("sdk token: SDK routes and account reads work", async () => {
      const t = await insertToken(h, s.editor.id);
      expect((await createBuild(t.raw, s.projectA)).statusCode).toBe(201);
      const me = await h.app.inject({
        method: "GET",
        url: "/users/me",
        headers: bearer(t.raw),
      });
      expect(me.statusCode).toBe(200);
      const project = await h.app.inject({
        method: "GET",
        url: `/projects/${s.projectA}`,
        headers: bearer(t.raw),
      });
      expect(project.statusCode).toBe(200);
    });

    test("read token: reads work, writes → 403 insufficient_scope (audited)", async () => {
      const t = await insertToken(h, s.editor.id, { scopes: ["read"] });
      const list = await h.app.inject({
        method: "GET",
        url: `/projects/${s.projectA}/builds`,
        headers: bearer(t.raw),
      });
      expect(list.statusCode).toBe(200);

      const write = await createBuild(t.raw, s.projectA);
      expect(write.statusCode).toBe(403);
      expect(write.json()).toMatchObject({ code: "insufficient_scope" });
      expect(await deniedAudits(h, t.id)).toEqual([
        {
          actorId: s.editor.id,
          metadata: {
            reason: "insufficient_scope",
            method: "POST",
            route: "/projects/:id/builds",
          },
        },
      ]);
    });

    test("routes that don't opt in are session-only for scoped tokens", async () => {
      const t = await insertToken(h, s.admin.id);
      for (const [method, url] of [
        ["GET", "/users"],
        ["POST", "/dashboard/telemetry"],
        ["GET", "/account/tokens"],
      ] as const) {
        const res = await h.app.inject({
          method,
          url,
          headers: bearer(t.raw),
          ...(method === "POST" ? { payload: {} } : {}),
        });
        expect(res.statusCode, `${method} ${url}`).toBe(403);
        expect(res.json()).toMatchObject({ code: "session_required" });
      }
    });

    test("tRPC refuses scoped tokens (FORBIDDEN session_required, audited); legacy passes", async () => {
      const scoped = await insertToken(h, s.editor.id);
      await expect(trpc(scoped.raw).inbox.list.query({})).rejects.toMatchObject(
        { message: "session_required", data: { code: "FORBIDDEN" } },
      );
      expect(await deniedAudits(h, scoped.id)).toEqual([
        {
          actorId: s.editor.id,
          metadata: {
            reason: "session_required",
            method: "query",
            route: "/trpc/inbox.list",
          },
        },
      ]);

      const legacy = await insertToken(h, s.editor.id, { scopes: ["legacy"] });
      await expect(
        trpc(legacy.raw).inbox.list.query({}),
      ).resolves.toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // Project binding
  // -------------------------------------------------------------------------

  describe("project binding", () => {
    test("bound token: its project only (403 token_project_mismatch, audited)", async () => {
      const t = await insertToken(h, s.editor.id, { projectId: s.projectA });
      expect((await createBuild(t.raw, s.projectA)).statusCode).toBe(201);

      const other = await createBuild(t.raw, s.projectB);
      expect(other.statusCode).toBe(403);
      expect(other.json()).toMatchObject({ code: "token_project_mismatch" });
      expect(await deniedAudits(h, t.id)).toEqual([
        {
          actorId: s.editor.id,
          metadata: {
            reason: "project",
            method: "POST",
            route: "/projects/:id/builds",
          },
        },
      ]);

      const list = await h.app.inject({
        method: "GET",
        url: "/projects",
        headers: bearer(t.raw),
      });
      expect(list.json().map((p: { id: string }) => p.id)).toEqual([
        s.projectA,
      ]);
    });

    test("an unbound admin token has no membership bypass", async () => {
      const t = await insertToken(h, s.admin.id);
      expect((await createBuild(t.raw, s.projectA)).statusCode).toBe(201);
      const nonMember = await createBuild(t.raw, s.projectC);
      expect(nonMember.statusCode).toBe(403);
      expect(nonMember.json()).toMatchObject({ code: "not_a_project_member" });

      // Lists the admin's member projects (not session_required, not all).
      const list = await h.app.inject({
        method: "GET",
        url: "/projects",
        headers: bearer(t.raw),
      });
      expect(list.statusCode).toBe(200);
      expect(list.json().map((p: { id: string }) => p.id)).toEqual([
        s.projectA,
      ]);
    });

    test("an admin token bound to a non-member project works there, nowhere else", async () => {
      const t = await insertToken(h, s.admin.id, { projectId: s.projectC });
      expect((await createBuild(t.raw, s.projectC)).statusCode).toBe(201);
      expect((await createBuild(t.raw, s.projectA)).statusCode).toBe(403);
      const list = await h.app.inject({
        method: "GET",
        url: "/projects",
        headers: bearer(t.raw),
      });
      expect(list.json().map((p: { id: string }) => p.id)).toEqual([
        s.projectC,
      ]);
    });

    test("a legacy admin token keeps the step-A membership bypass", async () => {
      const t = await insertToken(h, s.admin.id, { scopes: ["legacy"] });
      expect((await createBuild(t.raw, s.projectC)).statusCode).toBe(201);
    });

    test("storage proxy: a bound token reads its project's keys, 404 elsewhere", async () => {
      const storage = createStorage();
      const bytesA = Buffer.concat([TINY_PNG, Buffer.from("scoped-a")]);
      const bytesB = Buffer.concat([TINY_PNG, Buffer.from("scoped-b")]);
      const keyA = objectKey(bytesA);
      const keyB = objectKey(bytesB);
      await storage.put(keyA, bytesA, "image/png");
      await storage.put(keyB, bytesB, "image/png");
      for (const [projectId, key] of [
        [s.projectA, keyA],
        [s.projectB, keyB],
      ] as const) {
        const [build] = await h.db
          .insert(builds)
          .values({ projectId, userId: s.editor.id })
          .returning({ id: builds.id });
        const [run] = await h.db
          .insert(testRuns)
          .values({
            projectId,
            buildId: build!.id,
            name: "proxy-run",
            branchName: "main",
            status: "passed",
            imageName: key,
          })
          .returning({ id: testRuns.id });
        expect(run).toBeDefined();
      }

      const t = await insertToken(h, s.editor.id, {
        scopes: ["read"],
        projectId: s.projectA,
      });
      const get = (key: string) =>
        h.app.inject({
          method: "GET",
          url: `/api/v1/storage/${key}`,
          headers: bearer(t.raw),
        });
      expect((await get(keyA)).statusCode).toBe(200);
      // The editor is a member of B, but the token is bound to A.
      expect((await get(keyB)).statusCode).toBe(404);

      // An unbound admin token: member projects only (A), no bypass.
      const admin = await insertToken(h, s.admin.id, { scopes: ["read"] });
      const adminGet = (key: string) =>
        h.app.inject({
          method: "GET",
          url: `/api/v1/storage/${key}`,
          headers: bearer(admin.raw),
        });
      expect((await adminGet(keyA)).statusCode).toBe(200);
      expect((await adminGet(keyB)).statusCode).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // Approve (saveNewTests)
  // -------------------------------------------------------------------------

  describe("POST /runs/:id/approve", () => {
    /** A reviewable run in project A with one `new` and one `unresolved` step. */
    let seq = 0;
    async function seedMixedRun(): Promise<{
      runId: string;
      newShot: string;
      changedShot: string;
    }> {
      const [build] = await h.db
        .insert(builds)
        .values({ projectId: s.projectA, userId: s.editor.id })
        .returning();
      const [run] = await h.db
        .insert(testRuns)
        .values({
          projectId: s.projectA,
          buildId: build!.id,
          name: "mixed",
          branchName: "main",
          status: "unresolved",
        })
        .returning({ id: testRuns.id });
      const n = ++seq;
      const shot = async (step: string, verdict: CheckpointVerdict) => {
        const name = `${step}-${n}`;
        const [variation] = await h.db
          .insert(testVariations)
          .values({ name, projectId: s.projectA, branchName: "main" })
          .returning();
        const [row] = await h.db
          .insert(screenshots)
          .values({
            runId: run!.id,
            projectId: s.projectA,
            testVariationId: variation!.id,
            name,
            viewport: "1280x720",
            browser: "chromium",
            imageKey: `${name}-${run!.id.slice(0, 8)}`,
            verdict,
            verdictAt: new Date(),
          })
          .returning({ id: screenshots.id });
        return row!.id;
      };
      return {
        runId: run!.id,
        newShot: await shot("mixed-new", "new"),
        changedShot: await shot("mixed-changed", "unresolved"),
      };
    }

    async function decided(runId: string): Promise<string[]> {
      const rows = await h.db
        .select({ screenshotId: checkpointDecisions.screenshotId })
        .from(checkpointDecisions)
        .where(eq(checkpointDecisions.runId, runId));
      return rows.map((r) => r.screenshotId).sort();
    }

    test("an sdk token accepts only the new checkpoint; the change stays pending", async () => {
      const r = await seedMixedRun();
      const t = await insertToken(h, s.editor.id);
      const res = await h.app.inject({
        method: "POST",
        url: `/runs/${r.runId}/approve`,
        headers: bearer(t.raw),
      });
      expect(res.statusCode).toBe(200);
      expect(await decided(r.runId)).toEqual([r.newShot]);
    });

    test("a session, or a legacy token, accepts every pending checkpoint", async () => {
      for (const auth of [
        s.editor.jwt,
        (await insertToken(h, s.editor.id, { scopes: ["legacy"] })).raw,
      ]) {
        const r = await seedMixedRun();
        const res = await h.app.inject({
          method: "POST",
          url: `/runs/${r.runId}/approve`,
          headers: bearer(auth),
        });
        expect(res.statusCode).toBe(200);
        expect(await decided(r.runId)).toEqual(
          [r.newShot, r.changedShot].sort(),
        );
      }
    });

    test("a read token can't approve", async () => {
      const r = await seedMixedRun();
      const t = await insertToken(h, s.editor.id, { scopes: ["read"] });
      const res = await h.app.inject({
        method: "POST",
        url: `/runs/${r.runId}/approve`,
        headers: bearer(t.raw),
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: "insufficient_scope" });
      expect(await decided(r.runId)).toEqual([]);
    });
  });
});
