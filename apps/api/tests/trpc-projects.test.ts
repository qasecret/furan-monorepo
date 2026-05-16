import type { AddressInfo } from "node:net";

import {
  baselines,
  builds,
  diffRegions,
  eq,
  projectMembers,
  projects,
  screenshots,
  testRuns,
  testVariations,
  users,
} from "@furan/db";
import { createTRPCClient, httpBatchLink, TRPCClientError } from "@trpc/client";
import {
  afterAll,
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
  editorMemberId: string;
  editorMemberJwt: string;
  editorOutsiderId: string;
  editorOutsiderJwt: string;
  projectId: string;
}

async function seed(h: TestApp): Promise<Seeded> {
  // FK-order: dependents before parents (matches trpc-members.test.ts).
  await h.db.delete(diffRegions);
  await h.db.delete(screenshots);
  await h.db.delete(baselines);
  await h.db.delete(testRuns);
  await h.db.delete(testVariations);
  await h.db.delete(builds);
  await h.db.delete(projectMembers);
  await h.db.delete(projects);
  await h.db.delete(users);

  const [admin] = await h.db
    .insert(users)
    .values({
      email: "admin@t.example",
      hashedPassword: await hashPassword("x"),
      firstName: "Ad",
      lastName: "Min",
      role: "admin",
      isActive: true,
    })
    .returning();
  const [editorMember] = await h.db
    .insert(users)
    .values({
      email: "editor-member@t.example",
      hashedPassword: await hashPassword("x"),
      firstName: "Ed",
      lastName: "Mem",
      role: "editor",
      isActive: true,
    })
    .returning();
  const [editorOutsider] = await h.db
    .insert(users)
    .values({
      email: "editor-outsider@t.example",
      hashedPassword: await hashPassword("x"),
      firstName: "Ed",
      lastName: "Out",
      role: "editor",
      isActive: true,
    })
    .returning();

  const [project] = await h.db
    .insert(projects)
    .values({ name: "alpha" })
    .returning();

  await h.db
    .insert(projectMembers)
    .values({ userId: editorMember.id, projectId: project.id });

  return {
    adminId: admin.id,
    adminJwt: h.app.jwt.sign({ sub: admin.id, role: "admin" }),
    editorMemberId: editorMember.id,
    editorMemberJwt: h.app.jwt.sign({
      sub: editorMember.id,
      role: "editor",
    }),
    editorOutsiderId: editorOutsider.id,
    editorOutsiderJwt: h.app.jwt.sign({
      sub: editorOutsider.id,
      role: "editor",
    }),
    projectId: project.id,
  };
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

d("tRPC projects router", () => {
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

  test("getById: project-member editor receives the project row", async () => {
    const client = makeClient(baseUrl, s.editorMemberJwt);
    const project = await client.projects.getById.query({
      projectId: s.projectId,
    });
    expect(project.id).toBe(s.projectId);
    expect(project.name).toBe("alpha");
    // sanity-check a couple of defaulted columns exist on the returned row
    expect(typeof project.l2Enabled).toBe("boolean");
    expect(typeof project.diffThreshold).toBe("number");
  });

  test("getById: non-member editor receives FORBIDDEN", async () => {
    const client = makeClient(baseUrl, s.editorOutsiderJwt);
    let err: TRPCClientError<AppRouter> | undefined;
    try {
      await client.projects.getById.query({ projectId: s.projectId });
    } catch (e) {
      err = e as TRPCClientError<AppRouter>;
    }
    expect(err).toBeDefined();
    expect(err?.data?.code).toBe("FORBIDDEN");
  });

  test("getById: admin caller (admin-bypass) for nonexistent project returns NOT_FOUND", async () => {
    const client = makeClient(baseUrl, s.adminJwt);
    let err: TRPCClientError<AppRouter> | undefined;
    try {
      await client.projects.getById.query({
        projectId: "00000000-0000-0000-0000-000000000000",
      });
    } catch (e) {
      err = e as TRPCClientError<AppRouter>;
    }
    expect(err).toBeDefined();
    expect(err?.data?.code).toBe("NOT_FOUND");
  });

  test("update: project-member editor flips l2Enabled and the change persists", async () => {
    const client = makeClient(baseUrl, s.editorMemberJwt);
    const updated = await client.projects.update.mutate({
      projectId: s.projectId,
      l2Enabled: false,
    });
    expect(updated.l2Enabled).toBe(false);

    // DB-level confirmation.
    const rows = await h.db
      .select({ l2Enabled: projects.l2Enabled })
      .from(projects)
      .where(eq(projects.id, s.projectId));
    expect(rows[0]?.l2Enabled).toBe(false);
  });

  test("update: non-member editor receives FORBIDDEN; admin bypass succeeds", async () => {
    // Non-member is rejected.
    const outsider = makeClient(baseUrl, s.editorOutsiderJwt);
    let err: TRPCClientError<AppRouter> | undefined;
    try {
      await outsider.projects.update.mutate({
        projectId: s.projectId,
        name: "should-fail",
      });
    } catch (e) {
      err = e as TRPCClientError<AppRouter>;
    }
    expect(err).toBeDefined();
    expect(err?.data?.code).toBe("FORBIDDEN");

    // Admin (non-member, admin-bypass) succeeds.
    const adminClient = makeClient(baseUrl, s.adminJwt);
    const updated = await adminClient.projects.update.mutate({
      projectId: s.projectId,
      name: "alpha-renamed",
    });
    expect(updated.name).toBe("alpha-renamed");
  });

  test("update: diffThreshold outside 0..1 rejected as BAD_REQUEST", async () => {
    const client = makeClient(baseUrl, s.editorMemberJwt);
    let err: TRPCClientError<AppRouter> | undefined;
    try {
      await client.projects.update.mutate({
        projectId: s.projectId,
        diffThreshold: 1.5,
      });
    } catch (e) {
      err = e as TRPCClientError<AppRouter>;
    }
    expect(err).toBeDefined();
    expect(err?.data?.code).toBe("BAD_REQUEST");
  });
});
