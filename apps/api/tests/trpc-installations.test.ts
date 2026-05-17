/**
 * tRPC `installations.{list,update}` (admin-only). Covers the surface that
 * backs the `/admin/installations` dashboard page (D6(f)) — replacement for
 * the manual `UPDATE installations SET project_id = ...` step previously
 * documented in `docs/integrations/github-actions.md` §2.
 *
 * Cleanup is per-test scoped (single project + single installation) so
 * concurrent suites against the shared dev Postgres don't trample each
 * other (guardrail: NO broad `db.delete(table)` here).
 */
import type { AddressInfo } from "node:net";

import { eq, installations, projects, users } from "@furan/db";
import { createTRPCClient, httpBatchLink, TRPCClientError } from "@trpc/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";

import { hashPassword } from "../src/lib/password.js";
import type { AppRouter } from "../src/trpc/v1/router.js";

import { createTestApp, type TestApp } from "./helpers.js";

const skip = !process.env.DATABASE_URL;
const d = skip ? describe.skip : describe;

interface Seeded {
  adminId: string;
  adminJwt: string;
  editorId: string;
  editorJwt: string;
  projectId: string;
  installationRowId: string;
  installationNumericId: number;
}

// Unique numeric installation_id per-test so the
// `installations_installation_id_unique` index never collides with other
// suites running in the same DB. Math.floor(Date.now()) gives plenty of
// headroom; we mod by an int range for safety.
function uniqueInstallationId(): number {
  return (
    Math.floor(Date.now() % 2_000_000_000) + Math.floor(Math.random() * 1000)
  );
}

async function seed(h: TestApp): Promise<Seeded> {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const [admin] = await h.db
    .insert(users)
    .values({
      email: `admin-inst-${suffix}@t.example`,
      hashedPassword: await hashPassword("x"),
      firstName: "Ad",
      lastName: "Min",
      role: "admin",
      isActive: true,
    })
    .returning();
  const [editor] = await h.db
    .insert(users)
    .values({
      email: `editor-inst-${suffix}@t.example`,
      hashedPassword: await hashPassword("x"),
      firstName: "Ed",
      lastName: "It",
      role: "editor",
      isActive: true,
    })
    .returning();

  const [project] = await h.db
    .insert(projects)
    .values({ name: `inst-test-${suffix}` })
    .returning();

  const installationNumericId = uniqueInstallationId();
  const [installation] = await h.db
    .insert(installations)
    .values({
      installationId: installationNumericId,
      accountLogin: `org-${suffix}`,
      repositoryIds: [101, 102, 103],
    })
    .returning();

  return {
    adminId: admin.id,
    adminJwt: h.app.jwt.sign({ sub: admin.id, role: "admin" }),
    editorId: editor.id,
    editorJwt: h.app.jwt.sign({ sub: editor.id, role: "editor" }),
    projectId: project.id,
    installationRowId: installation.id,
    installationNumericId,
  };
}

async function cleanup(h: TestApp, s: Seeded) {
  // Installations cascade on projects but we may have set project_id=NULL
  // (or the project may have been deleted first). Delete the installation
  // explicitly by installation_id so we don't leak rows across tests.
  await h.db
    .delete(installations)
    .where(eq(installations.installationId, s.installationNumericId));
  // Project cascade-deletes any joined rows (project_members, etc.).
  await h.db.delete(projects).where(eq(projects.id, s.projectId));
  // Users have no cascade to projects so delete by id.
  await h.db.delete(users).where(eq(users.id, s.adminId));
  await h.db.delete(users).where(eq(users.id, s.editorId));
}

function makeClient(baseUrl: string, jwt?: string) {
  return createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: `${baseUrl}/trpc`,
        headers: jwt ? { authorization: `Bearer ${jwt}` } : {},
      }),
    ],
  });
}

d("tRPC installations router", () => {
  let h: TestApp;
  let baseUrl: string;
  let s: Seeded;

  beforeAll(async () => {
    h = await createTestApp();
    await h.app.listen({ port: 0, host: "127.0.0.1" });
    const addr = h.app.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    s = await seed(h);
  });
  afterEach(async () => {
    await cleanup(h, s);
  });

  test("list: admin caller receives { installations, projects } shape", async () => {
    const client = makeClient(baseUrl, s.adminJwt);
    const out = await client.installations.list.query();
    expect(Array.isArray(out.installations)).toBe(true);
    expect(Array.isArray(out.projects)).toBe(true);

    // The seeded row is present (other suites may have added rows; we only
    // assert ours, sliced out by id).
    const ours = out.installations.find((i) => i.id === s.installationRowId);
    expect(ours).toBeDefined();
    expect(ours?.installationId).toBe(s.installationNumericId);
    expect(ours?.accountLogin).toMatch(/^org-/);
    expect(ours?.repositoryIds).toEqual([101, 102, 103]);
    expect(ours?.projectId).toBeNull();

    const ourProject = out.projects.find((p) => p.id === s.projectId);
    expect(ourProject?.name).toMatch(/^inst-test-/);
  });

  test("list: non-admin (editor) caller receives FORBIDDEN", async () => {
    const client = makeClient(baseUrl, s.editorJwt);
    let err: TRPCClientError<AppRouter> | undefined;
    try {
      await client.installations.list.query();
    } catch (e) {
      err = e as TRPCClientError<AppRouter>;
    }
    expect(err).toBeDefined();
    expect(err?.data?.code).toBe("FORBIDDEN");
  });

  test("update: admin with valid projectId sets the link; returns { ok: true }", async () => {
    const client = makeClient(baseUrl, s.adminJwt);
    const res = await client.installations.update.mutate({
      id: s.installationRowId,
      projectId: s.projectId,
    });
    expect(res).toEqual({ ok: true });

    // DB-level confirmation.
    const rows = await h.db
      .select({ projectId: installations.projectId })
      .from(installations)
      .where(eq(installations.id, s.installationRowId));
    expect(rows[0]?.projectId).toBe(s.projectId);
  });

  test("update: admin with projectId=null clears a previously-set link", async () => {
    // Pre-set the link so we have something to clear.
    await h.db
      .update(installations)
      .set({ projectId: s.projectId })
      .where(eq(installations.id, s.installationRowId));

    const client = makeClient(baseUrl, s.adminJwt);
    const res = await client.installations.update.mutate({
      id: s.installationRowId,
      projectId: null,
    });
    expect(res).toEqual({ ok: true });

    const rows = await h.db
      .select({ projectId: installations.projectId })
      .from(installations)
      .where(eq(installations.id, s.installationRowId));
    expect(rows[0]?.projectId).toBeNull();
  });

  test("update: nonexistent id rejected as NOT_FOUND with installation_not_found", async () => {
    const client = makeClient(baseUrl, s.adminJwt);
    let err: TRPCClientError<AppRouter> | undefined;
    try {
      await client.installations.update.mutate({
        id: "00000000-0000-4000-8000-000000000000",
        projectId: s.projectId,
      });
    } catch (e) {
      err = e as TRPCClientError<AppRouter>;
    }
    expect(err).toBeDefined();
    expect(err?.data?.code).toBe("NOT_FOUND");
    expect(err?.message).toMatch(/installation_not_found/);
  });

  test("update: non-admin (editor) caller receives FORBIDDEN", async () => {
    const client = makeClient(baseUrl, s.editorJwt);
    let err: TRPCClientError<AppRouter> | undefined;
    try {
      await client.installations.update.mutate({
        id: s.installationRowId,
        projectId: s.projectId,
      });
    } catch (e) {
      err = e as TRPCClientError<AppRouter>;
    }
    expect(err).toBeDefined();
    expect(err?.data?.code).toBe("FORBIDDEN");
  });
});
