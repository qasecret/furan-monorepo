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
  editorCandidateId: string;
  editorCandidateEmail: string;
  guestCandidateId: string;
  guestCandidateEmail: string;
  projectId: string;
}

async function seed(h: TestApp): Promise<Seeded> {
  // FK-order: dependents before parents. Same pattern used by trpc-runs.test.ts.
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
  const [editorCandidate] = await h.db
    .insert(users)
    .values({
      email: "editor-candidate@t.example",
      hashedPassword: await hashPassword("x"),
      firstName: "Ed",
      lastName: "Cand",
      role: "editor",
      isActive: true,
    })
    .returning();
  const [guestCandidate] = await h.db
    .insert(users)
    .values({
      email: "guest-candidate@t.example",
      hashedPassword: await hashPassword("x"),
      firstName: "Gu",
      lastName: "Cand",
      role: "guest",
      isActive: true,
    })
    .returning();

  const [project] = await h.db
    .insert(projects)
    .values({ name: "alpha" })
    .returning();

  // editorMember is a project_members row; admin is implicitly granted via
  // admin-bypass in projectMember middleware; editorOutsider is NOT a member.
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
    editorCandidateId: editorCandidate.id,
    editorCandidateEmail: editorCandidate.email,
    guestCandidateId: guestCandidate.id,
    guestCandidateEmail: guestCandidate.email,
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

d("tRPC members router", () => {
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

  test("list: admin caller (admin-bypass) receives rows for any project", async () => {
    const client = makeClient(baseUrl, s.adminJwt);
    const rows = await client.members.list.query({ projectId: s.projectId });
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe(s.editorMemberId);
    expect(rows[0]?.email).toBe("editor-member@t.example");
    expect(rows[0]?.role).toBe("editor");
  });

  test("list: project-member editor receives rows", async () => {
    const client = makeClient(baseUrl, s.editorMemberJwt);
    const rows = await client.members.list.query({ projectId: s.projectId });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe(s.editorMemberId);
  });

  test("list: non-member editor receives FORBIDDEN", async () => {
    const client = makeClient(baseUrl, s.editorOutsiderJwt);
    let err: TRPCClientError<AppRouter> | undefined;
    try {
      await client.members.list.query({ projectId: s.projectId });
    } catch (e) {
      err = e as TRPCClientError<AppRouter>;
    }
    expect(err).toBeDefined();
    expect(err?.data?.code).toBe("FORBIDDEN");
  });

  test("add: admin appends an editor; list reflects the new membership", async () => {
    const adminClient = makeClient(baseUrl, s.adminJwt);
    const res = await adminClient.members.add.mutate({
      projectId: s.projectId,
      email: s.editorCandidateEmail,
    });
    expect(res).toEqual({ added: true });

    const rows = await adminClient.members.list.query({
      projectId: s.projectId,
    });
    expect(rows).toHaveLength(2);
    const ids = rows.map((r) => r.userId).sort();
    expect(ids).toEqual([s.editorMemberId, s.editorCandidateId].sort());
  });

  test("add: non-admin (editor) caller receives FORBIDDEN", async () => {
    const client = makeClient(baseUrl, s.editorMemberJwt);
    let err: TRPCClientError<AppRouter> | undefined;
    try {
      await client.members.add.mutate({
        projectId: s.projectId,
        email: s.editorCandidateEmail,
      });
    } catch (e) {
      err = e as TRPCClientError<AppRouter>;
    }
    expect(err).toBeDefined();
    expect(err?.data?.code).toBe("FORBIDDEN");
  });

  test("add: target user with guest role rejected as BAD_REQUEST", async () => {
    const client = makeClient(baseUrl, s.adminJwt);
    let err: TRPCClientError<AppRouter> | undefined;
    try {
      await client.members.add.mutate({
        projectId: s.projectId,
        email: s.guestCandidateEmail,
      });
    } catch (e) {
      err = e as TRPCClientError<AppRouter>;
    }
    expect(err).toBeDefined();
    expect(err?.data?.code).toBe("BAD_REQUEST");
    expect(err?.message).toMatch(/user_must_be_editor_role/);
  });

  test("add: duplicate membership rejected as CONFLICT", async () => {
    const client = makeClient(baseUrl, s.adminJwt);
    // editorMember is already on the project (seeded directly into project_members).
    let err: TRPCClientError<AppRouter> | undefined;
    try {
      await client.members.add.mutate({
        projectId: s.projectId,
        email: "editor-member@t.example",
      });
    } catch (e) {
      err = e as TRPCClientError<AppRouter>;
    }
    expect(err).toBeDefined();
    expect(err?.data?.code).toBe("CONFLICT");
    expect(err?.message).toMatch(/already_a_member/);
  });

  test("remove: deletes the join row; the removed editor can no longer list", async () => {
    const adminClient = makeClient(baseUrl, s.adminJwt);
    const res = await adminClient.members.remove.mutate({
      projectId: s.projectId,
      userId: s.editorMemberId,
    });
    expect(res).toEqual({ removed: true });

    // DB-level confirmation.
    const remaining = await h.db
      .select({ id: projectMembers.id })
      .from(projectMembers)
      .where(eq(projectMembers.projectId, s.projectId));
    expect(remaining).toHaveLength(0);

    // The removed editor now hits FORBIDDEN on list.
    const editorClient = makeClient(baseUrl, s.editorMemberJwt);
    let err: TRPCClientError<AppRouter> | undefined;
    try {
      await editorClient.members.list.query({ projectId: s.projectId });
    } catch (e) {
      err = e as TRPCClientError<AppRouter>;
    }
    expect(err).toBeDefined();
    expect(err?.data?.code).toBe("FORBIDDEN");
  });
});
