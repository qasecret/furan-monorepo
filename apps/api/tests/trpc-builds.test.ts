import type { AddressInfo } from "node:net";

import {
  builds,
  diffRegions,
  projectMembers,
  projects,
  screenshots,
  testRuns,
  testVariations,
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

import { hashPassword } from "../src/lib/password.js";
import type { AppRouter } from "../src/trpc/v1/router.js";

import { createTestApp, type TestApp } from "./helpers.js";

const skip = !process.env.DATABASE_URL;
const d = skip ? describe.skip : describe;

interface Seeded {
  editorId: string;
  editorJwt: string;
  projectId: string;
}

async function seed(h: TestApp): Promise<Seeded> {
  // FK-order: dependents before parents.
  await h.db.delete(diffRegions);
  await h.db.delete(screenshots);
  await h.db.delete(testRuns);
  await h.db.delete(testVariations);
  await h.db.delete(builds);
  await h.db.delete(projectMembers);
  await h.db.delete(projects);
  await h.db.delete(users);

  const [editor] = await h.db
    .insert(users)
    .values({
      email: "ed@t.example",
      hashedPassword: await hashPassword("x"),
      firstName: "Ed",
      lastName: "X",
      role: "editor",
      isActive: true,
    })
    .returning();
  if (!editor) throw new Error("editor not seeded");

  const [proj] = await h.db
    .insert(projects)
    .values({ name: "p1", mainBranchName: "main" })
    .returning();
  if (!proj) throw new Error("project not seeded");

  await h.db
    .insert(projectMembers)
    .values({ projectId: proj.id, userId: editor.id });

  return {
    editorId: editor.id,
    editorJwt: h.app.jwt.sign({ sub: editor.id, role: "editor" }),
    projectId: proj.id,
  };
}

function mkClient(h: TestApp, jwt: string) {
  const addr = h.app.server.address() as AddressInfo;
  return createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: `http://127.0.0.1:${addr.port}/trpc`,
        headers: () => ({ authorization: `Bearer ${jwt}` }),
      }),
    ],
  });
}

d("tRPC builds router", () => {
  let h: TestApp;
  let s: Seeded;

  beforeAll(async () => {
    process.env.S3_ENDPOINT ??= "http://localhost:9000";
    process.env.S3_BUCKET ??= "furan-dev";
    process.env.S3_ACCESS_KEY ??= "furan";
    process.env.S3_SECRET_KEY ??= "devpw_must_be_long"; // gitleaks:allow
    h = await createTestApp();
    await h.app.listen({ host: "127.0.0.1", port: 0 });
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    s = await seed(h);
  });

  test("list returns builds ordered desc with empty aggregate", async () => {
    await h.db.insert(builds).values([
      { projectId: s.projectId, ciBuildId: "a", branchName: "main" },
      { projectId: s.projectId, ciBuildId: "b", branchName: "main" },
    ]);
    const client = mkClient(h, s.editorJwt);
    const res = await client.builds.list.query({ projectId: s.projectId });
    expect(res.items).toHaveLength(2);
    expect(res.items[0]?.aggregateStatus).toBe("empty");
  });

  test("aggregate_status reflects run statuses (unresolved > failed > passed)", async () => {
    const [b] = await h.db
      .insert(builds)
      .values({ projectId: s.projectId, ciBuildId: "z" })
      .returning();
    if (!b) throw new Error("build not seeded");
    const [v] = await h.db
      .insert(testVariations)
      .values({ projectId: s.projectId, name: "test1" })
      .returning();
    if (!v) throw new Error("variation not seeded");
    await h.db.insert(testRuns).values([
      {
        projectId: s.projectId,
        buildId: b.id,
        name: "test1",
        branchName: "main",
        status: "passed",
      },
      {
        projectId: s.projectId,
        buildId: b.id,
        name: "test2",
        branchName: "main",
        status: "unresolved",
      },
      {
        projectId: s.projectId,
        buildId: b.id,
        name: "test3",
        branchName: "main",
        status: "failed",
      },
    ]);
    const client = mkClient(h, s.editorJwt);
    const res = await client.builds.list.query({ projectId: s.projectId });
    expect(res.items[0]?.aggregateStatus).toBe("unresolved");
    expect(res.items[0]?.unresolvedCount).toBe(1);
    expect(res.items[0]?.failedCount).toBe(1);
    expect(res.items[0]?.passedCount).toBe(1);
    expect(res.items[0]?.runCount).toBe(3);
  });

  test("list filters by property", async () => {
    await h.db.insert(builds).values([
      {
        projectId: s.projectId,
        ciBuildId: "p1",
        properties: { region: "us-east-1", shard: "1" },
      },
      {
        projectId: s.projectId,
        ciBuildId: "p2",
        properties: { region: "us-west-2", shard: "1" },
      },
      {
        projectId: s.projectId,
        ciBuildId: "p3",
        properties: { region: "us-east-1", shard: "2" },
      },
    ]);
    const client = mkClient(h, s.editorJwt);
    const res = await client.builds.list.query({
      projectId: s.projectId,
      properties: { region: "us-east-1" },
    });
    expect(res.items.map((b) => b.ciBuildId).sort()).toEqual(["p1", "p3"]);
  });

  test("list AND-joins multiple property filters", async () => {
    await h.db.insert(builds).values([
      {
        projectId: s.projectId,
        ciBuildId: "p1",
        properties: { region: "us-east-1", shard: "1" },
      },
      {
        projectId: s.projectId,
        ciBuildId: "p2",
        properties: { region: "us-east-1", shard: "2" },
      },
    ]);
    const client = mkClient(h, s.editorJwt);
    const res = await client.builds.list.query({
      projectId: s.projectId,
      properties: { region: "us-east-1", shard: "1" },
    });
    expect(res.items.map((b) => b.ciBuildId)).toEqual(["p1"]);
  });

  test("get returns single build", async () => {
    const [b] = await h.db
      .insert(builds)
      .values({ projectId: s.projectId, ciBuildId: "single", name: "nice" })
      .returning();
    if (!b) throw new Error("build not seeded");
    const client = mkClient(h, s.editorJwt);
    const res = await client.builds.get.query({
      projectId: s.projectId,
      buildId: b.id,
    });
    expect(res.name).toBe("nice");
    expect(res.ciBuildId).toBe("single");
  });

  test("listProperties returns distinct keys + values", async () => {
    await h.db.insert(builds).values([
      {
        projectId: s.projectId,
        ciBuildId: "k1",
        properties: { region: "us-east-1", shard: "1" },
      },
      {
        projectId: s.projectId,
        ciBuildId: "k2",
        properties: { region: "us-west-2", shard: "1" },
      },
    ]);
    const client = mkClient(h, s.editorJwt);
    const res = await client.builds.listProperties.query({
      projectId: s.projectId,
    });
    const byKey: Record<string, string[]> = {};
    for (const { key, values } of res) byKey[key] = values;
    expect(byKey.region?.sort()).toEqual(["us-east-1", "us-west-2"]);
    expect(byKey.shard).toEqual(["1"]);
  });

  test("non-member is rejected with FORBIDDEN", async () => {
    const [other] = await h.db
      .insert(users)
      .values({
        email: "other@t.example",
        hashedPassword: await hashPassword("x"),
        firstName: "O",
        lastName: "X",
        role: "editor",
        isActive: true,
      })
      .returning();
    if (!other) throw new Error("other user not seeded");
    const otherJwt = h.app.jwt.sign({ sub: other.id, role: "editor" });
    const client = mkClient(h, otherJwt);
    await expect(
      client.builds.list.query({ projectId: s.projectId }),
    ).rejects.toThrow(/FORBIDDEN/);
  });
});
