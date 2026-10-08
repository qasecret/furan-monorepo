import type { AddressInfo } from "node:net";

import {
  builds,
  eq,
  projectMembers,
  projects,
  screenshots,
  testRuns,
  tokens,
  users,
} from "@furan/db";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";

import { requireRole } from "../src/hooks/require-role.js";
import { hashPassword } from "../src/lib/password.js";
import { generateRawToken } from "../src/lib/token.js";
import type { AppRouter } from "../src/trpc/v1/router.js";

import { createTestApp, type TestApp } from "./helpers.js";

/**
 * ADR-064 step A — API tokens (`furan_pat_*`) are session-subordinate:
 *   - token management (`/account/tokens`) is session-only;
 *   - admin surfaces (requireRole ≥ admin, tRPC requireAdmin, analytics, the
 *     all-projects inbox / project list) are session-only, even for an
 *     admin's or owner's token → 403 `session_required` / tRPC FORBIDDEN;
 *   - the admin project-MEMBERSHIP bypass is deliberately kept, so an admin's
 *     SDK token still uploads to projects the admin manages but isn't a member
 *     of; non-admin token behavior is unchanged.
 */

const d = !process.env.DATABASE_URL ? describe.skip : describe;
// The SDK upload flow round-trips bytes through storage (same gate as
// sdk-routes.test.ts).
const dSdk =
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

type Role = "owner" | "admin" | "editor";

interface Principal {
  id: string;
  jwt: string;
  pat: string;
  patId: string;
}

interface Seeded {
  owner: Principal;
  admin: Principal;
  editor: Principal;
  /** The editor is a member; the admin and owner are NOT. */
  projectId: string;
}

async function seedPrincipal(h: TestApp, role: Role): Promise<Principal> {
  const [user] = await h.db
    .insert(users)
    .values({
      email: `pat-${role}@t.example`,
      hashedPassword: await hashPassword("x"),
      firstName: "Pat",
      lastName: role,
      role,
      isActive: true,
    })
    .returning();
  if (!user) throw new Error(`${role} not seeded`);
  // Insert the PAT directly (same raw/hash pair the mint route produces) so
  // the mint route's per-instance rate limit doesn't couple these tests.
  const { raw, hash } = generateRawToken();
  const [token] = await h.db
    .insert(tokens)
    .values({ userId: user.id, label: `${role}-ci`, hash })
    .returning({ id: tokens.id });
  if (!token) throw new Error(`${role} token not seeded`);
  return {
    id: user.id,
    jwt: h.app.jwt.sign({ sub: user.id, role }),
    pat: raw,
    patId: token.id,
  };
}

async function seed(h: TestApp): Promise<Seeded> {
  // FK-order: dependents before parents (tokens cascade with users).
  await h.db.delete(screenshots);
  await h.db.delete(testRuns);
  await h.db.delete(builds);
  await h.db.delete(projectMembers);
  await h.db.delete(projects);
  await h.db.delete(users);

  const owner = await seedPrincipal(h, "owner");
  const admin = await seedPrincipal(h, "admin");
  const editor = await seedPrincipal(h, "editor");
  const [project] = await h.db
    .insert(projects)
    .values({ name: "pat-proj" })
    .returning();
  if (!project) throw new Error("project not seeded");
  await h.db
    .insert(projectMembers)
    .values({ projectId: project.id, userId: editor.id });
  return { owner, admin, editor, projectId: project.id };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

d("API tokens are session-subordinate (ADR-064 step A)", () => {
  let h: TestApp;
  let baseUrl: string;
  let s: Seeded;

  beforeAll(async () => {
    h = await createTestApp({ skipReady: true });
    // Probe route: a requireRole gate BELOW admin rank is not an admin
    // surface, so a PAT must keep passing it.
    h.app.get(
      "/_test/editor-gate",
      { preHandler: [h.app.authenticate, requireRole("editor")] },
      async () => ({ ok: true }),
    );
    await h.app.listen({ host: "127.0.0.1", port: 0 });
    const addr = h.app.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    s = await seed(h);
  });

  function trpc(token: string) {
    return createTRPCClient<AppRouter>({
      links: [
        httpBatchLink({ url: `${baseUrl}/trpc`, headers: bearer(token) }),
      ],
    });
  }

  const SESSION_REQUIRED = {
    code: "session_required",
    statusCode: 403,
    message: expect.any(String),
  };
  const TRPC_SESSION_REQUIRED = {
    message: "session_required",
    data: { code: "FORBIDDEN" },
  };

  // -------------------------------------------------------------------------
  // Token management is session-only
  // -------------------------------------------------------------------------

  describe("/account/tokens", () => {
    test.each(["owner", "admin", "editor"] as const)(
      "%s PAT → 403 session_required on GET / POST / DELETE",
      async (role) => {
        const p = s[role];

        const list = await h.app.inject({
          method: "GET",
          url: "/account/tokens",
          headers: bearer(p.pat),
        });
        expect(list.statusCode).toBe(403);
        expect(list.json()).toEqual(SESSION_REQUIRED);

        const mint = await h.app.inject({
          method: "POST",
          url: "/account/tokens",
          headers: bearer(p.pat),
          payload: { label: "minted-by-a-token" },
        });
        expect(mint.statusCode).toBe(403);
        expect(mint.json()).toEqual(SESSION_REQUIRED);

        const revoke = await h.app.inject({
          method: "DELETE",
          url: `/account/tokens/${p.patId}`,
          headers: bearer(p.pat),
        });
        expect(revoke.statusCode).toBe(403);
        expect(revoke.json()).toEqual(SESSION_REQUIRED);

        // Nothing minted, nothing revoked.
        const rows = await h.db
          .select({ id: tokens.id })
          .from(tokens)
          .where(eq(tokens.userId, p.id));
        expect(rows).toEqual([{ id: p.patId }]);
      },
    );

    test("legacy apiKey: <pat> header is a PAT too → 403 session_required", async () => {
      const res = await h.app.inject({
        method: "POST",
        url: "/account/tokens",
        headers: { apiKey: s.admin.pat },
        payload: { label: "legacy-mint" },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual(SESSION_REQUIRED);
    });

    test("session JWT is unchanged: list, mint, revoke", async () => {
      const list = await h.app.inject({
        method: "GET",
        url: "/account/tokens",
        headers: bearer(s.admin.jwt),
      });
      expect(list.statusCode).toBe(200);
      expect((list.json() as Array<{ id: string }>).map((t) => t.id)).toEqual([
        s.admin.patId,
      ]);

      const mint = await h.app.inject({
        method: "POST",
        url: "/account/tokens",
        headers: bearer(s.admin.jwt),
        payload: { label: "minted-by-a-session" },
      });
      expect(mint.statusCode).toBe(201);

      const revoke = await h.app.inject({
        method: "DELETE",
        url: `/account/tokens/${s.admin.patId}`,
        headers: bearer(s.admin.jwt),
      });
      expect(revoke.statusCode).toBe(204);
    });
  });

  // -------------------------------------------------------------------------
  // Admin surfaces are session-only (REST)
  // -------------------------------------------------------------------------

  describe("REST admin surfaces", () => {
    test.each(["owner", "admin"] as const)(
      "%s PAT → 403 session_required on requireRole('admin') routes + the project list",
      async (role) => {
        const pat = s[role].pat;

        const listUsers = await h.app.inject({
          method: "GET",
          url: "/users",
          headers: bearer(pat),
        });
        expect(listUsers.statusCode).toBe(403);
        expect(listUsers.json()).toEqual(SESSION_REQUIRED);

        const createProject = await h.app.inject({
          method: "POST",
          url: "/projects",
          headers: bearer(pat),
          payload: { name: `created-by-${role}-token` },
        });
        expect(createProject.statusCode).toBe(403);
        expect(createProject.json()).toEqual(SESSION_REQUIRED);
        const created = await h.db
          .select({ id: projects.id })
          .from(projects)
          .where(eq(projects.name, `created-by-${role}-token`));
        expect(created).toEqual([]);

        const addMember = await h.app.inject({
          method: "POST",
          url: `/projects/${s.projectId}/members`,
          headers: bearer(pat),
          payload: { userId: s[role].id },
        });
        expect(addMember.statusCode).toBe(403);
        expect(addMember.json()).toEqual(SESSION_REQUIRED);

        // Listing EVERY project is the admin view → session-only too.
        const listProjects = await h.app.inject({
          method: "GET",
          url: "/projects",
          headers: bearer(pat),
        });
        expect(listProjects.statusCode).toBe(403);
        expect(listProjects.json()).toEqual(SESSION_REQUIRED);
      },
    );

    test("admin session JWT is unchanged", async () => {
      const listUsers = await h.app.inject({
        method: "GET",
        url: "/users",
        headers: bearer(s.admin.jwt),
      });
      expect(listUsers.statusCode).toBe(200);

      const listProjects = await h.app.inject({
        method: "GET",
        url: "/projects",
        headers: bearer(s.admin.jwt),
      });
      expect(listProjects.statusCode).toBe(200);
      // The admin is not a member of pat-proj but still lists it.
      expect(
        (listProjects.json() as Array<{ id: string }>).map((p) => p.id),
      ).toEqual([s.projectId]);

      const createProject = await h.app.inject({
        method: "POST",
        url: "/projects",
        headers: bearer(s.admin.jwt),
        payload: { name: "created-by-admin-session" },
      });
      expect(createProject.statusCode).toBe(201);
    });

    test("editor PAT: non-admin behavior unchanged (plain forbidden, member list, sub-admin gates)", async () => {
      // Not an admin — a session wouldn't help, so the code stays `forbidden`.
      const listUsers = await h.app.inject({
        method: "GET",
        url: "/users",
        headers: bearer(s.editor.pat),
      });
      expect(listUsers.statusCode).toBe(403);
      expect(listUsers.json()).toMatchObject({ code: "forbidden" });

      const listProjects = await h.app.inject({
        method: "GET",
        url: "/projects",
        headers: bearer(s.editor.pat),
      });
      expect(listProjects.statusCode).toBe(200);
      expect(
        (listProjects.json() as Array<{ id: string }>).map((p) => p.id),
      ).toEqual([s.projectId]);

      const editorGate = await h.app.inject({
        method: "GET",
        url: "/_test/editor-gate",
        headers: bearer(s.editor.pat),
      });
      expect(editorGate.statusCode).toBe(200);
    });

    test("a requireRole gate below admin rank is not an admin surface: admin PAT passes", async () => {
      const res = await h.app.inject({
        method: "GET",
        url: "/_test/editor-gate",
        headers: bearer(s.admin.pat),
      });
      expect(res.statusCode).toBe(200);
    });

    test("PATs still authenticate non-admin account reads (GET /users/me)", async () => {
      const res = await h.app.inject({
        method: "GET",
        url: "/users/me",
        headers: bearer(s.owner.pat),
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { id: string }).id).toBe(s.owner.id);
    });
  });

  // -------------------------------------------------------------------------
  // Admin surfaces are session-only (tRPC)
  // -------------------------------------------------------------------------

  describe("tRPC admin surfaces", () => {
    test.each(["owner", "admin"] as const)(
      "%s PAT → FORBIDDEN session_required on requireAdmin, analytics, all-projects inbox",
      async (role) => {
        const caller = trpc(s[role].pat);
        await expect(caller.auditLog.list.query({})).rejects.toMatchObject(
          TRPC_SESSION_REQUIRED,
        );
        await expect(
          caller.members.listUserProjects.query({ userId: s.editor.id }),
        ).rejects.toMatchObject(TRPC_SESSION_REQUIRED);
        await expect(
          caller.analytics.summary.query({ days: 7 }),
        ).rejects.toMatchObject(TRPC_SESSION_REQUIRED);
        await expect(caller.inbox.list.query({})).rejects.toMatchObject(
          TRPC_SESSION_REQUIRED,
        );
        await expect(caller.inbox.count.query({})).rejects.toMatchObject(
          TRPC_SESSION_REQUIRED,
        );
      },
    );

    test("admin session JWT is unchanged", async () => {
      const caller = trpc(s.admin.jwt);
      await expect(caller.auditLog.list.query({})).resolves.toBeDefined();
      await expect(
        caller.members.listUserProjects.query({ userId: s.editor.id }),
      ).resolves.toEqual([s.projectId]);
      await expect(
        caller.analytics.summary.query({ days: 7 }),
      ).resolves.toBeDefined();
      await expect(caller.inbox.list.query({})).resolves.toMatchObject({
        items: [],
      });
    });

    test("editor PAT: member inbox works; admin procedures stay plain FORBIDDEN", async () => {
      const caller = trpc(s.editor.pat);
      await expect(caller.inbox.list.query({})).resolves.toMatchObject({
        items: [],
      });
      await expect(caller.inbox.count.query({})).resolves.toEqual({
        total: 0,
      });
      const err = await caller.auditLog.list.query({}).catch((e: unknown) => e);
      expect(err).toMatchObject({ data: { code: "FORBIDDEN" } });
      expect(err).not.toMatchObject({ message: "session_required" });
    });

    // ADR-060's admin-only Visual-AI provider settings (provider / baseUrl /
    // apiKey) are an admin surface too: an admin's token can't repoint the
    // provider or swap the key, while ordinary settings stay writable.
    test.each(["owner", "admin"] as const)(
      "%s PAT → FORBIDDEN session_required on a Visual-AI provider change",
      async (role) => {
        await expect(
          trpc(s[role].pat).projects.update.mutate({
            projectId: s.projectId,
            imageComparisonConfig: JSON.stringify({ provider: "gemini" }),
          }),
        ).rejects.toMatchObject(TRPC_SESSION_REQUIRED);
      },
    );

    test("admin PAT can still change non-provider project settings", async () => {
      const p = await trpc(s.admin.pat).projects.update.mutate({
        projectId: s.projectId,
        retentionDays: 30,
      });
      expect(p.retentionDays).toBe(30);
    });

    test("admin session can change the Visual-AI provider; editor PAT keeps the ADR-060 message", async () => {
      await expect(
        trpc(s.admin.jwt).projects.update.mutate({
          projectId: s.projectId,
          imageComparisonConfig: JSON.stringify({ provider: "gemini" }),
        }),
      ).resolves.toBeDefined();
      await expect(
        trpc(s.editor.pat).projects.update.mutate({
          projectId: s.projectId,
          imageComparisonConfig: JSON.stringify({ provider: "anthropic" }),
        }),
      ).rejects.toMatchObject({
        message: "vlm_provider_settings_admin_only",
        data: { code: "FORBIDDEN" },
      });
    });

    test("admin PAT keeps the project-membership bypass on project-scoped procedures", async () => {
      // The admin is NOT a member of pat-proj.
      const project = await trpc(s.admin.pat).projects.getById.query({
        projectId: s.projectId,
      });
      expect(project.id).toBe(s.projectId);
    });
  });
});

// ---------------------------------------------------------------------------
// The SDK upload flow is untouched for PATs
// ---------------------------------------------------------------------------

dSdk("SDK upload flow with a PAT (ADR-064 step A)", () => {
  let h: TestApp;
  let baseUrl: string;
  let s: Seeded;

  beforeAll(async () => {
    h = await createTestApp();
    await h.app.listen({ host: "127.0.0.1", port: 0 });
    const addr = h.app.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    s = await seed(h);
  });

  /**
   * The Kotlin SDK's calls, in order: create build → open run → multipart
   * screenshot → complete → poll the run. Plus the storage proxy read the
   * diff viewer does for the uploaded image.
   */
  async function sdkFlow(pat: string, projectId: string) {
    const build = await h.app.inject({
      method: "POST",
      url: `/projects/${projectId}/builds`,
      headers: bearer(pat),
      payload: { branchName: "main", ciBuildId: `ci-${Date.now()}` },
    });
    expect(build.statusCode).toBeGreaterThanOrEqual(200);
    expect(build.statusCode).toBeLessThan(300);
    const buildId = (build.json() as { id: string }).id;

    const run = await h.app.inject({
      method: "POST",
      url: "/runs",
      headers: bearer(pat),
      payload: { projectId, buildId, branchName: "main", name: "home" },
    });
    expect(run.statusCode).toBe(201);
    const runId = (run.json() as { runId: string }).runId;

    const form = new FormData();
    form.append("name", "home");
    form.append("viewport", "1280x720");
    form.append("browser", "chromium");
    form.append(
      "pngBytes",
      new Blob([TINY_PNG], { type: "image/png" }),
      "home.png",
    );
    const upload = await fetch(`${baseUrl}/runs/${runId}/screenshots`, {
      method: "POST",
      headers: { Authorization: `Bearer ${pat}` },
      body: form,
    });
    expect(upload.status).toBe(200);
    const { imageKey } = (await upload.json()) as { imageKey: string };

    const complete = await h.app.inject({
      method: "POST",
      url: `/runs/${runId}/complete`,
      headers: bearer(pat),
    });
    expect(complete.statusCode).toBe(200);

    const poll = await h.app.inject({
      method: "GET",
      url: `/runs/${runId}`,
      headers: bearer(pat),
    });
    expect(poll.statusCode).toBe(200);

    const image = await h.app.inject({
      method: "GET",
      url: `/api/v1/storage/${imageKey}`,
      headers: bearer(pat),
    });
    expect(image.statusCode).toBe(200);
  }

  test("admin PAT uploads to a project the admin is NOT a member of", async () => {
    await sdkFlow(s.admin.pat, s.projectId);
  });

  test("owner PAT uploads to a project the owner is NOT a member of", async () => {
    await sdkFlow(s.owner.pat, s.projectId);
  });

  test("editor PAT uploads to a member project (unchanged)", async () => {
    await sdkFlow(s.editor.pat, s.projectId);
  });
});
