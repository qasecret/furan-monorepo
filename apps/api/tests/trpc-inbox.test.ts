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
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { hashPassword } from "../src/lib/password.js";
import type { AppRouter } from "../src/trpc/v1/router.js";

import { createTestApp, type TestApp } from "./helpers.js";

const d = !process.env.DATABASE_URL ? describe.skip : describe;

d("trpc inbox.list", () => {
  let h: TestApp;
  let baseUrl: string;

  beforeAll(async () => {
    process.env.S3_ENDPOINT ??= "http://localhost:9000";
    process.env.S3_BUCKET ??= "furan-dev";
    process.env.S3_ACCESS_KEY ??= "furan";
    process.env.S3_SECRET_KEY ??= "devpw_must_be_long"; // gitleaks:allow

    h = await createTestApp();
    await h.app.listen({ host: "127.0.0.1", port: 0 });
    const addr = h.app.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await h.close();
  });

  /**
   * Wipe all tables in FK-safe order before each seed so tests don't bleed
   * into each other when run with --reporter=verbose.
   */
  async function wipe() {
    await h.db.delete(diffRegions);
    await h.db.delete(screenshots);
    await h.db.delete(testRuns);
    await h.db.delete(testVariations);
    await h.db.delete(builds);
    await h.db.delete(projectMembers);
    await h.db.delete(projects);
    await h.db.delete(users);
  }

  function makeClient(jwt: string) {
    return createTRPCClient<AppRouter>({
      links: [
        httpBatchLink({
          url: `${baseUrl}/trpc`,
          headers: { authorization: `Bearer ${jwt}` },
        }),
      ],
    });
  }

  test("returns runs from member projects with UNRESOLVED status", async () => {
    await wipe();

    // Seed a user with role=editor (non-admin so project-member path is tested).
    const [user] = await h.db
      .insert(users)
      .values({
        email: "inbox-editor@t.example",
        hashedPassword: await hashPassword("x"),
        firstName: "In",
        lastName: "Box",
        role: "editor",
        isActive: true,
      })
      .returning();
    if (!user) throw new Error("user not seeded");

    const jwt = h.app.jwt.sign({ sub: user.id, role: "editor" });

    const [project] = await h.db
      .insert(projects)
      .values({ name: "inbox-project-1" })
      .returning();
    if (!project) throw new Error("project not seeded");

    // Wire the user into the project.
    await h.db
      .insert(projectMembers)
      .values({ userId: user.id, projectId: project.id });

    const [build] = await h.db
      .insert(builds)
      .values({ projectId: project.id, branchName: "main" })
      .returning();
    if (!build) throw new Error("build not seeded");

    const [variation] = await h.db
      .insert(testVariations)
      .values({ projectId: project.id, name: "home-page" })
      .returning();
    if (!variation) throw new Error("variation not seeded");

    const [run] = await h.db
      .insert(testRuns)
      .values({
        projectId: project.id,
        buildId: build.id,
        testVariationId: variation.id,
        status: "unresolved",
      })
      .returning();
    if (!run) throw new Error("run not seeded");

    const caller = makeClient(jwt);
    const result = await caller.inbox.list.query({});

    expect(result.items.map((i) => i.runId)).toContain(run.id);
    expect(result.items[0]?.projectName).toBe(project.name);
    expect(result.items[0]?.variationName).toBe(variation.name);
    expect(result.nextCursor).toBeNull();
  });

  test("does not return runs from projects the user is not a member of", async () => {
    await wipe();

    const [user] = await h.db
      .insert(users)
      .values({
        email: "inbox-nomember@t.example",
        hashedPassword: await hashPassword("x"),
        firstName: "No",
        lastName: "Mem",
        role: "editor",
        isActive: true,
      })
      .returning();
    if (!user) throw new Error("user not seeded");

    const jwt = h.app.jwt.sign({ sub: user.id, role: "editor" });

    // Project with no member entry for `user`.
    const [project] = await h.db
      .insert(projects)
      .values({ name: "inbox-project-other" })
      .returning();
    if (!project) throw new Error("project not seeded");

    const [build] = await h.db
      .insert(builds)
      .values({ projectId: project.id, branchName: "main" })
      .returning();
    if (!build) throw new Error("build not seeded");

    const [variation] = await h.db
      .insert(testVariations)
      .values({ projectId: project.id, name: "checkout" })
      .returning();
    if (!variation) throw new Error("variation not seeded");

    await h.db.insert(testRuns).values({
      projectId: project.id,
      buildId: build.id,
      testVariationId: variation.id,
      status: "unresolved",
    });

    const caller = makeClient(jwt);
    const result = await caller.inbox.list.query({});

    // No member entry → zero items.
    expect(result.items).toHaveLength(0);
    expect(result.nextCursor).toBeNull();
  });

  test("admin sees runs across all projects regardless of membership", async () => {
    await wipe();

    const [admin] = await h.db
      .insert(users)
      .values({
        email: "inbox-admin@t.example",
        hashedPassword: await hashPassword("x"),
        firstName: "Ad",
        lastName: "Min",
        role: "admin",
        isActive: true,
      })
      .returning();
    if (!admin) throw new Error("admin not seeded");

    const adminJwt = h.app.jwt.sign({ sub: admin.id, role: "admin" });

    const [project] = await h.db
      .insert(projects)
      .values({ name: "inbox-project-admin" })
      .returning();
    if (!project) throw new Error("project not seeded");

    const [build] = await h.db
      .insert(builds)
      .values({ projectId: project.id, branchName: "main" })
      .returning();
    if (!build) throw new Error("build not seeded");

    const [variation] = await h.db
      .insert(testVariations)
      .values({ projectId: project.id, name: "landing" })
      .returning();
    if (!variation) throw new Error("variation not seeded");

    const [run] = await h.db
      .insert(testRuns)
      .values({
        projectId: project.id,
        buildId: build.id,
        testVariationId: variation.id,
        status: "failed",
      })
      .returning();
    if (!run) throw new Error("run not seeded");

    const caller = makeClient(adminJwt);
    // default status filter is "all-open" which covers both unresolved + failed.
    const result = await caller.inbox.list.query({});

    expect(result.items.map((i) => i.runId)).toContain(run.id);
  });

  test("returns empty items when user has no member projects", async () => {
    await wipe();

    const [user] = await h.db
      .insert(users)
      .values({
        email: "inbox-lonely@t.example",
        hashedPassword: await hashPassword("x"),
        firstName: "Lo",
        lastName: "Ne",
        role: "editor",
        isActive: true,
      })
      .returning();
    if (!user) throw new Error("user not seeded");

    const jwt = h.app.jwt.sign({ sub: user.id, role: "editor" });

    const caller = makeClient(jwt);
    const result = await caller.inbox.list.query({});

    expect(result.items).toHaveLength(0);
    expect(result.nextCursor).toBeNull();
  });

  test("status=unresolved excludes FAILED runs", async () => {
    await wipe();

    const [user] = await h.db
      .insert(users)
      .values({
        email: "inbox-unresolved-filter@t.example",
        hashedPassword: await hashPassword("x"),
        firstName: "Un",
        lastName: "Res",
        role: "editor",
        isActive: true,
      })
      .returning();
    if (!user) throw new Error("user not seeded");

    const jwt = h.app.jwt.sign({ sub: user.id, role: "editor" });

    const [project] = await h.db
      .insert(projects)
      .values({ name: "inbox-project-unresolved-filter" })
      .returning();
    if (!project) throw new Error("project not seeded");

    await h.db
      .insert(projectMembers)
      .values({ userId: user.id, projectId: project.id });

    const [build] = await h.db
      .insert(builds)
      .values({ projectId: project.id, branchName: "main" })
      .returning();
    if (!build) throw new Error("build not seeded");

    const [variation] = await h.db
      .insert(testVariations)
      .values({ projectId: project.id, name: "home-unresolved-filter" })
      .returning();
    if (!variation) throw new Error("variation not seeded");

    const [unresolvedRun] = await h.db
      .insert(testRuns)
      .values({
        projectId: project.id,
        buildId: build.id,
        testVariationId: variation.id,
        status: "unresolved",
      })
      .returning();
    if (!unresolvedRun) throw new Error("unresolved run not seeded");

    const [failedRun] = await h.db
      .insert(testRuns)
      .values({
        projectId: project.id,
        buildId: build.id,
        testVariationId: variation.id,
        status: "failed",
      })
      .returning();
    if (!failedRun) throw new Error("failed run not seeded");

    const caller = makeClient(jwt);
    const result = await caller.inbox.list.query({
      status: "unresolved",
      window: "all",
    });

    const ids = result.items.map((i) => i.runId);
    expect(ids).toContain(unresolvedRun.id);
    expect(ids).not.toContain(failedRun.id);
  });

  test("status=all-open includes UNRESOLVED and FAILED but not PASSED", async () => {
    await wipe();

    const [user] = await h.db
      .insert(users)
      .values({
        email: "inbox-all-open@t.example",
        hashedPassword: await hashPassword("x"),
        firstName: "All",
        lastName: "Open",
        role: "editor",
        isActive: true,
      })
      .returning();
    if (!user) throw new Error("user not seeded");

    const jwt = h.app.jwt.sign({ sub: user.id, role: "editor" });

    const [project] = await h.db
      .insert(projects)
      .values({ name: "inbox-project-all-open" })
      .returning();
    if (!project) throw new Error("project not seeded");

    await h.db
      .insert(projectMembers)
      .values({ userId: user.id, projectId: project.id });

    const [build] = await h.db
      .insert(builds)
      .values({ projectId: project.id, branchName: "main" })
      .returning();
    if (!build) throw new Error("build not seeded");

    const [variation] = await h.db
      .insert(testVariations)
      .values({ projectId: project.id, name: "home-all-open" })
      .returning();
    if (!variation) throw new Error("variation not seeded");

    const [unresolvedRun] = await h.db
      .insert(testRuns)
      .values({
        projectId: project.id,
        buildId: build.id,
        testVariationId: variation.id,
        status: "unresolved",
      })
      .returning();
    if (!unresolvedRun) throw new Error("unresolved run not seeded");

    const [failedRun] = await h.db
      .insert(testRuns)
      .values({
        projectId: project.id,
        buildId: build.id,
        testVariationId: variation.id,
        status: "failed",
      })
      .returning();
    if (!failedRun) throw new Error("failed run not seeded");

    const [passedRun] = await h.db
      .insert(testRuns)
      .values({
        projectId: project.id,
        buildId: build.id,
        testVariationId: variation.id,
        status: "passed",
      })
      .returning();
    if (!passedRun) throw new Error("passed run not seeded");

    const caller = makeClient(jwt);
    const result = await caller.inbox.list.query({
      status: "all-open",
      window: "all",
    });

    const ids = result.items.map((i) => i.runId);
    expect(ids).toContain(unresolvedRun.id);
    expect(ids).toContain(failedRun.id);
    expect(ids).not.toContain(passedRun.id);
  });

  test("paginates via cursor", async () => {
    await wipe();

    const [user] = await h.db
      .insert(users)
      .values({
        email: "inbox-pagination@t.example",
        hashedPassword: await hashPassword("x"),
        firstName: "Pa",
        lastName: "Gin",
        role: "editor",
        isActive: true,
      })
      .returning();
    if (!user) throw new Error("user not seeded");

    const jwt = h.app.jwt.sign({ sub: user.id, role: "editor" });

    const [project] = await h.db
      .insert(projects)
      .values({ name: "inbox-project-pagination" })
      .returning();
    if (!project) throw new Error("project not seeded");

    await h.db
      .insert(projectMembers)
      .values({ userId: user.id, projectId: project.id });

    const [build] = await h.db
      .insert(builds)
      .values({ projectId: project.id, branchName: "main" })
      .returning();
    if (!build) throw new Error("build not seeded");

    const [variation] = await h.db
      .insert(testVariations)
      .values({ projectId: project.id, name: "home-pagination" })
      .returning();
    if (!variation) throw new Error("variation not seeded");

    // Seed 7 unresolved runs.
    const seededIds: string[] = [];
    for (let i = 0; i < 7; i++) {
      const [run] = await h.db
        .insert(testRuns)
        .values({
          projectId: project.id,
          buildId: build.id,
          testVariationId: variation.id,
          status: "unresolved",
        })
        .returning();
      if (!run) throw new Error(`run ${i} not seeded`);
      seededIds.push(run.id);
    }

    const caller = makeClient(jwt);

    // Page 1: 3 items, nextCursor must be non-null.
    const page1 = await caller.inbox.list.query({
      status: "unresolved",
      window: "all",
      limit: 3,
    });
    expect(page1.items).toHaveLength(3);
    expect(page1.nextCursor).not.toBeNull();

    // Page 2: next 3 items, nextCursor must be non-null.
    const page2 = await caller.inbox.list.query({
      status: "unresolved",
      window: "all",
      limit: 3,
      cursor: page1.nextCursor,
    });
    expect(page2.items).toHaveLength(3);
    expect(page2.nextCursor).not.toBeNull();

    // Page 3: remaining 1 item, nextCursor must be null.
    const page3 = await caller.inbox.list.query({
      status: "unresolved",
      window: "all",
      limit: 3,
      cursor: page2.nextCursor,
    });
    expect(page3.items).toHaveLength(1);
    expect(page3.nextCursor).toBeNull();

    // No overlap: the union of all returned ids must have exactly 7 distinct entries.
    const allReturnedIds = [
      ...page1.items.map((i) => i.runId),
      ...page2.items.map((i) => i.runId),
      ...page3.items.map((i) => i.runId),
    ];
    expect(new Set(allReturnedIds).size).toBe(7);
  });
});
