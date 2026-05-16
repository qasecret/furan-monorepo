import type { AddressInfo } from "node:net";

import {
  baselines,
  builds,
  diffRegions,
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
  memberId: string;
  memberJwt: string;
  nonMemberId: string;
  nonMemberJwt: string;
  projectId: string;
  variationId: string;
  buildId: string;
  /** Run IDs in INSERTION order (oldest createdAt first). */
  runIdsAsc: string[];
}

/**
 * Seed 26 test_runs with strictly monotonic `created_at` (1s apart so the
 * desc(createdAt) ordering is deterministic). 24 are on `main`+status="new",
 * 1 is on `feature/x`+status="passed", 1 is on `feature/x`+status="failed".
 */
async function seed(h: TestApp): Promise<Seeded> {
  // FK-order: dependents before parents.
  await h.db.delete(diffRegions);
  await h.db.delete(screenshots);
  await h.db.delete(baselines);
  await h.db.delete(testRuns);
  await h.db.delete(testVariations);
  await h.db.delete(builds);
  await h.db.delete(projectMembers);
  await h.db.delete(projects);
  await h.db.delete(users);

  const [member] = await h.db
    .insert(users)
    .values({
      email: "member@t.example",
      hashedPassword: await hashPassword("x"),
      firstName: "Mem",
      lastName: "Ber",
      role: "editor",
      isActive: true,
    })
    .returning();
  const [nonMember] = await h.db
    .insert(users)
    .values({
      email: "nonmember@t.example",
      hashedPassword: await hashPassword("x"),
      firstName: "Non",
      lastName: "Mem",
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
    .values({ userId: member.id, projectId: project.id });

  const [build] = await h.db
    .insert(builds)
    .values({ projectId: project.id, userId: member.id, isRunning: true })
    .returning();

  const [variation] = await h.db
    .insert(testVariations)
    .values({ name: "home", projectId: project.id })
    .returning();

  // 26 runs total. Index 0 is the OLDEST, index 25 the NEWEST.
  // 24 base runs on `main` with status="new", then 2 distinguished runs on
  // `feature/x` (one passed, one failed) at the most-recent timestamps so
  // they come out at the top of the default desc(createdAt) listing.
  const now = Date.now();
  const total = 26;
  const runIdsAsc: string[] = [];
  for (let i = 0; i < total; i += 1) {
    // i=0 → oldest (now - 25_000ms); i=25 → newest (now).
    const createdAt = new Date(now - (total - 1 - i) * 1000);
    let branchName = "main";
    let status: string = "new";
    if (i === total - 2) {
      // 2nd newest: feature/x + passed
      branchName = "feature/x";
      status = "passed";
    } else if (i === total - 1) {
      // newest: feature/x + failed
      branchName = "feature/x";
      status = "failed";
    }
    const [row] = await h.db
      .insert(testRuns)
      .values({
        buildId: build.id,
        projectId: project.id,
        testVariationId: variation.id,
        status,
        branchName,
        name: `run-${i}`,
        createdAt,
        updatedAt: createdAt,
      })
      .returning();
    runIdsAsc.push(row.id);
  }

  return {
    memberId: member.id,
    memberJwt: h.app.jwt.sign({ sub: member.id, role: "editor" }),
    nonMemberId: nonMember.id,
    nonMemberJwt: h.app.jwt.sign({ sub: nonMember.id, role: "editor" }),
    projectId: project.id,
    variationId: variation.id,
    buildId: build.id,
    runIdsAsc,
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

d("tRPC runs.list", () => {
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

  test("list: returns 25 items + nextCursor when 26 runs exist (default page size)", async () => {
    const client = makeClient(baseUrl, s.memberJwt);
    const page = await client.runs.list.query({ projectId: s.projectId });
    expect(page.items).toHaveLength(25);
    expect(page.nextCursor).not.toBeNull();
    // Newest first: the failed feature/x run is the very first.
    expect(page.items[0]?.id).toBe(s.runIdsAsc[s.runIdsAsc.length - 1]);
    // The 25th item (index 24) of the desc-sorted list is runIdsAsc[1].
    expect(page.items[24]?.id).toBe(s.runIdsAsc[1]);
  });

  test("list: second page via cursor returns the 26th item with nextCursor=null", async () => {
    const client = makeClient(baseUrl, s.memberJwt);
    const first = await client.runs.list.query({ projectId: s.projectId });
    expect(first.nextCursor).toBeTruthy();
    const second = await client.runs.list.query({
      projectId: s.projectId,
      cursor: first.nextCursor!,
    });
    expect(second.items).toHaveLength(1);
    expect(second.items[0]?.id).toBe(s.runIdsAsc[0]); // oldest
    expect(second.nextCursor).toBeNull();
  });

  test("list: filters by branch (exact match)", async () => {
    const client = makeClient(baseUrl, s.memberJwt);
    const page = await client.runs.list.query({
      projectId: s.projectId,
      branch: "feature/x",
    });
    expect(page.items).toHaveLength(2);
    expect(page.items.every((r) => r.branchName === "feature/x")).toBe(true);
    expect(page.nextCursor).toBeNull();
  });

  test("list: filters by status enum", async () => {
    const client = makeClient(baseUrl, s.memberJwt);
    const page = await client.runs.list.query({
      projectId: s.projectId,
      status: "passed",
    });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.status).toBe("passed");
    expect(page.items[0]?.branchName).toBe("feature/x");
    expect(page.nextCursor).toBeNull();
  });

  test("list: non-member editor receives FORBIDDEN", async () => {
    const client = makeClient(baseUrl, s.nonMemberJwt);
    let err: TRPCClientError<AppRouter> | undefined;
    try {
      await client.runs.list.query({ projectId: s.projectId });
    } catch (e) {
      err = e as TRPCClientError<AppRouter>;
    }
    expect(err).toBeDefined();
    expect(err?.data?.code).toBe("FORBIDDEN");
  });
});
