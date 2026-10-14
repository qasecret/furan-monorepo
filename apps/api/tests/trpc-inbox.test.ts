import type { AddressInfo } from "node:net";

import {
  and,
  auditLog,
  builds,
  checkpointDecisions,
  diffRegions,
  eq,
  inArray,
  projectMembers,
  projects,
  runReviewerDecisions,
  screenshots,
  sql,
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
    await h.db.delete(runReviewerDecisions);
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
        name: variation.name,
        branchName: "main",
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

  test("a rejected run leaves the open inbox queue and count (F1)", async () => {
    await wipe();

    const [user] = await h.db
      .insert(users)
      .values({
        email: "inbox-reject@t.example",
        hashedPassword: await hashPassword("x"),
        firstName: "Re",
        lastName: "Ject",
        role: "editor",
        isActive: true,
      })
      .returning();
    if (!user) throw new Error("user not seeded");
    const jwt = h.app.jwt.sign({ sub: user.id, role: "editor" });

    const [project] = await h.db
      .insert(projects)
      .values({ name: "inbox-reject-project" })
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

    const [run] = await h.db
      .insert(testRuns)
      .values({
        projectId: project.id,
        buildId: build.id,
        name: "home-page",
        branchName: "main",
        status: "unresolved",
      })
      .returning();
    if (!run) throw new Error("run not seeded");

    const caller = makeClient(jwt);

    // Before: the unresolved run is in the open queue + counted.
    const before = await caller.inbox.list.query({});
    expect(before.items.map((i) => i.runId)).toContain(run.id);
    expect((await caller.inbox.count.query({})).total).toBe(1);

    // Reject it — this is a reviewer decision.
    await caller.inbox.reject.mutate({ runId: run.id });

    // After: the run must disappear from the open queue (visible feedback),
    // and the badge count must drop it too (list/count stay consistent).
    const after = await caller.inbox.list.query({});
    expect(after.items.map((i) => i.runId)).not.toContain(run.id);
    expect((await caller.inbox.count.query({})).total).toBe(0);
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
      name: variation.name,
      branchName: "main",
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
        name: variation.name,
        branchName: "main",
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
        name: variation.name,
        branchName: "main",
        status: "unresolved",
      })
      .returning();
    if (!unresolvedRun) throw new Error("unresolved run not seeded");

    const [failedRun] = await h.db
      .insert(testRuns)
      .values({
        projectId: project.id,
        buildId: build.id,
        name: variation.name,
        branchName: "main",
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
        name: variation.name,
        branchName: "main",
        status: "unresolved",
      })
      .returning();
    if (!unresolvedRun) throw new Error("unresolved run not seeded");

    const [failedRun] = await h.db
      .insert(testRuns)
      .values({
        projectId: project.id,
        buildId: build.id,
        name: variation.name,
        branchName: "main",
        status: "failed",
      })
      .returning();
    if (!failedRun) throw new Error("failed run not seeded");

    const [passedRun] = await h.db
      .insert(testRuns)
      .values({
        projectId: project.id,
        buildId: build.id,
        name: variation.name,
        branchName: "main",
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

  test("count returns the total of unresolved + failed across member projects", async () => {
    await wipe();

    // Seed an admin so project-member path is bypassed, keeping setup minimal.
    const [user] = await h.db
      .insert(users)
      .values({
        email: "inbox-count@t.example",
        hashedPassword: await hashPassword("x"),
        firstName: "Co",
        lastName: "Unt",
        role: "editor",
        isActive: true,
      })
      .returning();
    if (!user) throw new Error("user not seeded");

    const jwt = h.app.jwt.sign({ sub: user.id, role: "editor" });

    const [project] = await h.db
      .insert(projects)
      .values({ name: "inbox-project-count" })
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
      .values({ projectId: project.id, name: "home-count" })
      .returning();
    if (!variation) throw new Error("variation not seeded");

    // 1 unresolved + 1 failed + 1 passed.
    await h.db.insert(testRuns).values({
      projectId: project.id,
      buildId: build.id,
      name: variation.name,
      branchName: "main",
      status: "unresolved",
    });
    await h.db.insert(testRuns).values({
      projectId: project.id,
      buildId: build.id,
      name: variation.name,
      branchName: "main",
      status: "failed",
    });
    await h.db.insert(testRuns).values({
      projectId: project.id,
      buildId: build.id,
      name: variation.name,
      branchName: "main",
      status: "passed",
    });

    const caller = makeClient(jwt);
    const result = await caller.inbox.count.query({ window: "all" });

    // Exactly 2: unresolved + failed; passed must NOT be counted.
    expect(result.total).toBe(2);
  });

  test("approve transitions an UNRESOLVED run to PASSED via the existing approval path", async () => {
    await wipe();

    const [user] = await h.db
      .insert(users)
      .values({
        email: "inbox-approve@t.example",
        hashedPassword: await hashPassword("x"),
        firstName: "Ap",
        lastName: "Prove",
        role: "editor",
        isActive: true,
      })
      .returning();
    if (!user) throw new Error("user not seeded");

    const jwt = h.app.jwt.sign({ sub: user.id, role: "editor" });

    const [project] = await h.db
      .insert(projects)
      .values({ name: "inbox-project-approve" })
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
      .values({ projectId: project.id, name: "home-approve" })
      .returning();
    if (!variation) throw new Error("variation not seeded");

    const [run] = await h.db
      .insert(testRuns)
      .values({
        projectId: project.id,
        buildId: build.id,
        name: variation.name,
        branchName: "main",
        status: "unresolved",
      })
      .returning();
    if (!run) throw new Error("run not seeded");

    // The diff found a change on the run's one checkpoint (spec §5.4: only a
    // diffed `new` / `unresolved` checkpoint is pending).
    const [shot] = await h.db
      .insert(screenshots)
      .values({
        runId: run.id,
        projectId: project.id,
        testVariationId: variation.id,
        name: variation.name,
        viewport: "1280x720",
        browser: "chromium",
        imageKey: "inbox-approve-img",
        verdict: "unresolved",
      })
      .returning();
    if (!shot) throw new Error("screenshot not seeded");

    const caller = makeClient(jwt);
    const result = await caller.inbox.approve.mutate({ runId: run.id });

    expect(result.runId).toBe(run.id);
    expect(result.approved).toBe(true);

    // Verify the DB row was updated to 'passed'.
    const [updated] = await h.db
      .select({ status: testRuns.status })
      .from(testRuns)
      .where(eq(testRuns.id, run.id));
    expect(updated?.status).toBe("passed");

    // Through the decision core, tagged as the inbox's.
    const decisions = await h.db
      .select()
      .from(checkpointDecisions)
      .where(eq(checkpointDecisions.runId, run.id));
    expect(
      decisions.map((d) => [d.screenshotId, d.decision, d.source, d.actorId]),
    ).toEqual([[shot.id, "approved", "inbox", user.id]]);
  });

  test("reject inserts a runReviewerDecisions row and does NOT change run.status", async () => {
    await wipe();

    const [admin] = await h.db
      .insert(users)
      .values({
        email: "inbox-reject-basic@t.example",
        hashedPassword: await hashPassword("x"),
        firstName: "Re",
        lastName: "Ject",
        role: "admin",
        isActive: true,
      })
      .returning();
    if (!admin) throw new Error("admin not seeded");

    const adminJwt = h.app.jwt.sign({ sub: admin.id, role: "admin" });

    const [project] = await h.db
      .insert(projects)
      .values({ name: "inbox-project-reject-basic" })
      .returning();
    if (!project) throw new Error("project not seeded");

    const [build] = await h.db
      .insert(builds)
      .values({ projectId: project.id, branchName: "main" })
      .returning();
    if (!build) throw new Error("build not seeded");

    const [variation] = await h.db
      .insert(testVariations)
      .values({ projectId: project.id, name: "home-reject-basic" })
      .returning();
    if (!variation) throw new Error("variation not seeded");

    const [run] = await h.db
      .insert(testRuns)
      .values({
        projectId: project.id,
        buildId: build.id,
        name: variation.name,
        branchName: "main",
        status: "unresolved",
      })
      .returning();
    if (!run) throw new Error("run not seeded");

    const caller = makeClient(adminJwt);
    const result = await caller.inbox.reject.mutate({
      runId: run.id,
      reason: "real regression",
    });

    expect(result.ok).toBe(true);

    // Assert: 1 row in runReviewerDecisions with correct fields.
    const decisions = await h.db
      .select()
      .from(runReviewerDecisions)
      .where(eq(runReviewerDecisions.runId, run.id));

    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.runId).toBe(run.id);
    expect(decisions[0]?.userId).toBe(admin.id);
    expect(decisions[0]?.decision).toBe("rejected");
    expect(decisions[0]?.reason).toBe("real regression");

    // Assert: run.status is still 'unresolved' — NOT changed.
    const [updated] = await h.db
      .select({ status: testRuns.status })
      .from(testRuns)
      .where(eq(testRuns.id, run.id));
    expect(updated?.status).toBe("unresolved");
  });

  test("reject is idempotent on (runId, userId) — second call updates reason", async () => {
    await wipe();

    const [admin] = await h.db
      .insert(users)
      .values({
        email: "inbox-reject-idempotent@t.example",
        hashedPassword: await hashPassword("x"),
        firstName: "Re",
        lastName: "Ject2",
        role: "admin",
        isActive: true,
      })
      .returning();
    if (!admin) throw new Error("admin not seeded");

    const adminJwt = h.app.jwt.sign({ sub: admin.id, role: "admin" });

    const [project] = await h.db
      .insert(projects)
      .values({ name: "inbox-project-reject-idempotent" })
      .returning();
    if (!project) throw new Error("project not seeded");

    const [build] = await h.db
      .insert(builds)
      .values({ projectId: project.id, branchName: "main" })
      .returning();
    if (!build) throw new Error("build not seeded");

    const [variation] = await h.db
      .insert(testVariations)
      .values({ projectId: project.id, name: "home-reject-idempotent" })
      .returning();
    if (!variation) throw new Error("variation not seeded");

    const [run] = await h.db
      .insert(testRuns)
      .values({
        projectId: project.id,
        buildId: build.id,
        name: variation.name,
        branchName: "main",
        status: "unresolved",
      })
      .returning();
    if (!run) throw new Error("run not seeded");

    const caller = makeClient(adminJwt);

    // First call.
    await caller.inbox.reject.mutate({ runId: run.id, reason: "first reason" });

    // Second call with a different reason.
    await caller.inbox.reject.mutate({
      runId: run.id,
      reason: "updated reason",
    });

    // Assert: still only 1 row in runReviewerDecisions.
    const decisions = await h.db
      .select()
      .from(runReviewerDecisions)
      .where(eq(runReviewerDecisions.runId, run.id));

    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.reason).toBe("updated reason");
  });

  test("inbox.list returns buildId (flat mode)", async () => {
    await wipe();

    const [user] = await h.db
      .insert(users)
      .values({
        email: "inbox-buildid-flat@t.example",
        hashedPassword: await hashPassword("x"),
        firstName: "Bld",
        lastName: "Id",
        role: "editor",
        isActive: true,
      })
      .returning();
    if (!user) throw new Error("user not seeded");

    const jwt = h.app.jwt.sign({ sub: user.id, role: "editor" });

    const [project] = await h.db
      .insert(projects)
      .values({ name: "inbox-buildid-flat-project" })
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
      .values({ projectId: project.id, name: "home-buildid-flat" })
      .returning();
    if (!variation) throw new Error("variation not seeded");

    await h.db.insert(testRuns).values({
      projectId: project.id,
      buildId: build.id,
      name: variation.name,
      branchName: "main",
      status: "unresolved",
    });

    const caller = makeClient(jwt);
    const res = await caller.inbox.list.query({
      status: "all-open",
      window: "7d",
    });

    expect(res.items[0]?.buildId).toBe(build.id);
  });

  test("inbox.count with projectIds scopes to that project only", async () => {
    await wipe();
    const [user] = await h.db
      .insert(users)
      .values({
        email: "count-admin@t.example",
        hashedPassword: await hashPassword("x"),
        firstName: "C",
        lastName: "Nt",
        role: "admin",
        isActive: true,
      })
      .returning();
    if (!user) throw new Error("user");
    const jwt = h.app.jwt.sign({ sub: user.id, role: "admin" });
    const [p1] = await h.db
      .insert(projects)
      .values({ name: "count-p1" })
      .returning();
    const [p2] = await h.db
      .insert(projects)
      .values({ name: "count-p2" })
      .returning();
    if (!p1 || !p2) throw new Error("projects");
    const [b1] = await h.db
      .insert(builds)
      .values({ projectId: p1.id, branchName: "main" })
      .returning();
    const [b2] = await h.db
      .insert(builds)
      .values({ projectId: p2.id, branchName: "main" })
      .returning();
    if (!b1 || !b2) throw new Error("builds");
    await h.db.insert(testRuns).values([
      {
        projectId: p1.id,
        buildId: b1.id,
        name: "a",
        branchName: "main",
        status: "unresolved",
      },
      {
        projectId: p2.id,
        buildId: b2.id,
        name: "b",
        branchName: "main",
        status: "unresolved",
      },
    ]);

    const all = await makeClient(jwt).inbox.count.query({});
    expect(all.total).toBe(2);
    const scoped = await makeClient(jwt).inbox.count.query({
      projectIds: [p1.id],
    });
    expect(scoped.total).toBe(1);
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
          name: `${variation.name}-${i}`,
          branchName: "main",
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

  test("paginates runs created within the same millisecond without skipping any", async () => {
    await wipe();

    const [user] = await h.db
      .insert(users)
      .values({
        email: "inbox-same-ms@t.example",
        hashedPassword: await hashPassword("x"),
        firstName: "Sa",
        lastName: "Me",
        role: "editor",
        isActive: true,
      })
      .returning();
    if (!user) throw new Error("user not seeded");
    const jwt = h.app.jwt.sign({ sub: user.id, role: "editor" });

    const [project] = await h.db
      .insert(projects)
      .values({ name: "inbox-project-same-ms" })
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

    // created_at is microsecond-precision; a JS Date is not. Six runs share
    // the millisecond .123 at different µs (two share one exact instant, one
    // sits on the ms boundary), bracketed by a run in the next and previous
    // ms. Ids are chosen so id order disagrees with time order.
    const id = (n: number) =>
      `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const seeds: { id: string; at: string }[] = [
      { id: id(7), at: "2026-01-01T00:00:00.124100Z" },
      { id: id(1), at: "2026-01-01T00:00:00.123900Z" },
      { id: id(5), at: "2026-01-01T00:00:00.123700Z" },
      { id: id(4), at: "2026-01-01T00:00:00.123500Z" },
      { id: id(3), at: "2026-01-01T00:00:00.123500Z" },
      { id: id(6), at: "2026-01-01T00:00:00.123300Z" },
      { id: id(2), at: "2026-01-01T00:00:00.123000Z" },
      { id: id(8), at: "2026-01-01T00:00:00.122999Z" },
    ];
    for (const s of seeds) {
      await h.db.insert(testRuns).values({
        id: s.id,
        projectId: project.id,
        buildId: build.id,
        name: `same-ms-${s.id.slice(-1)}`,
        branchName: "main",
        status: "unresolved",
        createdAt: sql`${s.at}::timestamptz`,
      });
    }
    // Newest first, id DESC on an exact tie.
    const expected = seeds.map((s) => s.id);

    const caller = makeClient(jwt);
    for (const limit of [1, 2, 3]) {
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const page: Awaited<ReturnType<typeof caller.inbox.list.query>> =
          await caller.inbox.list.query({
            status: "unresolved",
            window: "all",
            limit,
            cursor,
          });
        expect(page.items.length).toBeGreaterThan(0);
        expect(page.items.length).toBeLessThanOrEqual(limit);
        seen.push(...page.items.map((i) => i.runId));
        cursor = page.nextCursor;
        pages++;
      } while (cursor && pages <= seeds.length);
      expect(seen, `limit=${limit}`).toEqual(expected);
      expect(pages, `limit=${limit}`).toBe(Math.ceil(seeds.length / limit));
    }
  });
});

d("inbox.list similarity mode", () => {
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

  async function wipe() {
    await h.db.delete(diffRegions);
    await h.db.delete(screenshots);
    await h.db.delete(runReviewerDecisions);
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

  test("annotates clusters and orders biggest-first across builds", async () => {
    await wipe();

    const [user] = await h.db
      .insert(users)
      .values({
        email: "sim-cluster@t.example",
        hashedPassword: await hashPassword("x"),
        firstName: "Sim",
        lastName: "Cluster",
        role: "editor",
        isActive: true,
      })
      .returning();
    if (!user) throw new Error("user not seeded");

    const jwt = h.app.jwt.sign({ sub: user.id, role: "editor" });

    const [project] = await h.db
      .insert(projects)
      .values({ name: "sim-cluster-project" })
      .returning();
    if (!project) throw new Error("project not seeded");

    await h.db
      .insert(projectMembers)
      .values({ userId: user.id, projectId: project.id });

    // 3 distinct builds for the shared-signature cluster.
    const builds3 = await h.db
      .insert(builds)
      .values([
        { projectId: project.id, branchName: "main" },
        { projectId: project.id, branchName: "main" },
        { projectId: project.id, branchName: "main" },
        { projectId: project.id, branchName: "main" }, // for unique + null runs
      ])
      .returning();
    if (builds3.length < 4) throw new Error("builds not seeded");
    const [b1, b2, b3, b4] = builds3 as [
      (typeof builds3)[0],
      (typeof builds3)[0],
      (typeof builds3)[0],
      (typeof builds3)[0],
    ];

    // 3 runs with primary_signature = "v1:shared" across 3 different builds.
    const sharedRuns = await h.db
      .insert(testRuns)
      .values([
        {
          projectId: project.id,
          buildId: b1.id,
          name: "shared-1",
          branchName: "main",
          status: "unresolved",
          primarySignature: "v1:shared",
        },
        {
          projectId: project.id,
          buildId: b2.id,
          name: "shared-2",
          branchName: "main",
          status: "unresolved",
          primarySignature: "v1:shared",
        },
        {
          projectId: project.id,
          buildId: b3.id,
          name: "shared-3",
          branchName: "main",
          status: "unresolved",
          primarySignature: "v1:shared",
        },
      ])
      .returning();
    if (sharedRuns.length !== 3) throw new Error("shared runs not seeded");

    // 1 run with primary_signature = "v1:unique".
    const [uniqueRun] = await h.db
      .insert(testRuns)
      .values({
        projectId: project.id,
        buildId: b4.id,
        name: "unique-1",
        branchName: "main",
        status: "unresolved",
        primarySignature: "v1:unique",
      })
      .returning();
    if (!uniqueRun) throw new Error("unique run not seeded");

    // 1 run with primary_signature = NULL.
    const [nullRun] = await h.db
      .insert(testRuns)
      .values({
        projectId: project.id,
        buildId: b4.id,
        name: "null-sig",
        branchName: "main",
        status: "unresolved",
        primarySignature: null,
      })
      .returning();
    if (!nullRun) throw new Error("null-sig run not seeded");

    const caller = makeClient(jwt);
    const res = await caller.inbox.list.query({
      group: "similarity",
      window: "all",
      limit: 50,
    });

    const sharedItems = res.items.filter(
      (i) => i.primarySignature === "v1:shared",
    );
    expect(sharedItems).toHaveLength(3);
    expect(sharedItems[0]!.clusterRunCount).toBe(3);
    expect(sharedItems[0]!.clusterBuildCount).toBe(3); // COUNT(DISTINCT build_id)

    // Biggest cluster first.
    expect(res.items[0]!.primarySignature).toBe("v1:shared");

    // NULL-primary run is a singleton, NOT collapsed with the unique one.
    const nullRow = res.items.find((i) => i.primarySignature == null);
    expect(nullRow).toBeDefined();
    expect(nullRow!.clusterRunCount).toBe(1);

    const uniqueRow = res.items.find((i) => i.primarySignature === "v1:unique");
    expect(uniqueRow).toBeDefined();
    expect(uniqueRow!.clusterRunCount).toBe(1);
  });

  test("inbox.list returns buildId (similarity mode)", async () => {
    await wipe();

    const [user] = await h.db
      .insert(users)
      .values({
        email: "inbox-buildid-sim@t.example",
        hashedPassword: await hashPassword("x"),
        firstName: "Sim",
        lastName: "BldId",
        role: "editor",
        isActive: true,
      })
      .returning();
    if (!user) throw new Error("user not seeded");

    const jwt = h.app.jwt.sign({ sub: user.id, role: "editor" });

    const [project] = await h.db
      .insert(projects)
      .values({ name: "inbox-buildid-sim-project" })
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

    await h.db.insert(testRuns).values({
      projectId: project.id,
      buildId: build.id,
      name: "sim-buildid-run",
      branchName: "main",
      status: "unresolved",
      primarySignature: "v1:sim-buildid",
    });

    const caller = makeClient(jwt);
    const res = await caller.inbox.list.query({
      status: "all-open",
      window: "7d",
      group: "similarity",
    });

    expect(res.items[0]?.buildId).toBe(build.id);
  });

  test("paginates the grouped view without overlap or gaps", async () => {
    await wipe();

    const [user] = await h.db
      .insert(users)
      .values({
        email: "sim-paginate@t.example",
        hashedPassword: await hashPassword("x"),
        firstName: "Sim",
        lastName: "Paginate",
        role: "editor",
        isActive: true,
      })
      .returning();
    if (!user) throw new Error("user not seeded");

    const jwt = h.app.jwt.sign({ sub: user.id, role: "editor" });

    const [project] = await h.db
      .insert(projects)
      .values({ name: "sim-paginate-project" })
      .returning();
    if (!project) throw new Error("project not seeded");

    await h.db
      .insert(projectMembers)
      .values({ userId: user.id, projectId: project.id });

    // 2 builds.
    const [buildA, buildB] = (await h.db
      .insert(builds)
      .values([
        { projectId: project.id, branchName: "main" },
        { projectId: project.id, branchName: "main" },
      ])
      .returning()) as [(typeof builds)[0], (typeof builds)[0]];

    // Cluster A: 3 runs with "v1:alpha" across both builds.
    // Cluster B: 2 runs with "v1:beta" across buildA.
    // Total: 5 runs. Page size 2 → tests pagination across cluster boundary.
    await h.db.insert(testRuns).values([
      {
        projectId: project.id,
        buildId: buildA.id,
        name: "alpha-1",
        branchName: "main",
        status: "unresolved",
        primarySignature: "v1:alpha",
      },
      {
        projectId: project.id,
        buildId: buildB.id,
        name: "alpha-2",
        branchName: "main",
        status: "unresolved",
        primarySignature: "v1:alpha",
      },
      {
        projectId: project.id,
        buildId: buildA.id,
        name: "alpha-3",
        branchName: "main",
        status: "unresolved",
        primarySignature: "v1:alpha",
      },
      {
        projectId: project.id,
        buildId: buildA.id,
        name: "beta-1",
        branchName: "main",
        status: "unresolved",
        primarySignature: "v1:beta",
      },
      {
        projectId: project.id,
        buildId: buildB.id,
        name: "beta-2",
        branchName: "main",
        status: "unresolved",
        primarySignature: "v1:beta",
      },
    ]);

    const caller = makeClient(jwt);
    const page1 = await caller.inbox.list.query({
      group: "similarity",
      window: "all",
      limit: 2,
    });
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();

    // Walk ALL pages and assert lossless coverage: every seeded run appears
    // exactly once — no overlap AND no gaps — across the paginated grouped view.
    const seen: string[] = [...page1.items.map((i) => i.runId)];
    let cursor = page1.nextCursor;
    let guard = 0;
    while (cursor && guard++ < 10) {
      const next = await caller.inbox.list.query({
        group: "similarity",
        window: "all",
        limit: 2,
        cursor,
      });
      seen.push(...next.items.map((i) => i.runId));
      cursor = next.nextCursor;
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);

    // A value-invalid cursor (valid JSON, bad uuid/timestamp) restarts from the
    // top rather than 500ing on the ::uuid/::timestamptz casts (which execute
    // outside the decode try/catch).
    const badCursor = Buffer.from(
      JSON.stringify({
        crc: 1,
        pid: "not-a-uuid",
        sig: "v1:x",
        cat: "nope",
        id: "bad",
      }),
    ).toString("base64url");
    const restarted = await caller.inbox.list.query({
      group: "similarity",
      window: "all",
      limit: 2,
      cursor: badCursor,
    });
    expect(restarted.items.length).toBeGreaterThan(0);
  });
});

d("inbox.rejectCluster", () => {
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

  async function wipe() {
    await h.db.delete(diffRegions);
    await h.db.delete(screenshots);
    await h.db.delete(runReviewerDecisions);
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

  test("fails all in-project cross-build runs with the signature, not other sigs or other projects", async () => {
    await wipe();

    // Seed two users: a reviewer (write member) and a non-member.
    const [reviewerUser] = await h.db
      .insert(users)
      .values({
        email: "rc-reviewer@t.example",
        hashedPassword: await hashPassword("x"),
        firstName: "Re",
        lastName: "Viewer",
        role: "editor",
        isActive: true,
      })
      .returning();
    if (!reviewerUser) throw new Error("reviewerUser not seeded");

    const [nonMemberUser] = await h.db
      .insert(users)
      .values({
        email: "rc-nonmember@t.example",
        hashedPassword: await hashPassword("x"),
        firstName: "Non",
        lastName: "Member",
        role: "editor",
        isActive: true,
      })
      .returning();
    if (!nonMemberUser) throw new Error("nonMemberUser not seeded");

    const reviewerJwt = h.app.jwt.sign({
      sub: reviewerUser.id,
      role: "editor",
    });
    const nonMemberJwt = h.app.jwt.sign({
      sub: nonMemberUser.id,
      role: "editor",
    });

    // Project A — reviewer is a member.
    const [projectA] = await h.db
      .insert(projects)
      .values({ name: "rc-project-a" })
      .returning();
    if (!projectA) throw new Error("projectA not seeded");

    await h.db
      .insert(projectMembers)
      .values({ userId: reviewerUser.id, projectId: projectA.id });

    // Project B — used to prove cross-project isolation.
    const [projectB] = await h.db
      .insert(projects)
      .values({ name: "rc-project-b" })
      .returning();
    if (!projectB) throw new Error("projectB not seeded");

    // 2 builds in project A for the target cluster.
    const [buildA1, buildA2] = (await h.db
      .insert(builds)
      .values([
        { projectId: projectA.id, branchName: "main" },
        { projectId: projectA.id, branchName: "main" },
      ])
      .returning()) as [typeof builds.$inferSelect, typeof builds.$inferSelect];

    // 1 build in project B.
    const [buildB1] = await h.db
      .insert(builds)
      .values({ projectId: projectB.id, branchName: "main" })
      .returning();
    if (!buildB1) throw new Error("buildB1 not seeded");

    // Seed: 2 unresolved runs in project A with primary_signature = "v1:target" (across 2 builds).
    const [targetRun1] = await h.db
      .insert(testRuns)
      .values({
        projectId: projectA.id,
        buildId: buildA1.id,
        name: "target-1",
        branchName: "main",
        status: "unresolved",
        primarySignature: "v1:target",
      })
      .returning();
    if (!targetRun1) throw new Error("targetRun1 not seeded");

    const [targetRun2] = await h.db
      .insert(testRuns)
      .values({
        projectId: projectA.id,
        buildId: buildA2.id,
        name: "target-2",
        branchName: "main",
        status: "unresolved",
        primarySignature: "v1:target",
      })
      .returning();
    if (!targetRun2) throw new Error("targetRun2 not seeded");

    // 1 unresolved run in project A with a different signature — must NOT be touched.
    const [otherSigRun] = await h.db
      .insert(testRuns)
      .values({
        projectId: projectA.id,
        buildId: buildA1.id,
        name: "other-sig",
        branchName: "main",
        status: "unresolved",
        primarySignature: "v1:other",
      })
      .returning();
    if (!otherSigRun) throw new Error("otherSigRun not seeded");

    // 1 unresolved run in project B with the SAME signature — must NOT be touched (cross-project).
    const [projectBTargetRun] = await h.db
      .insert(testRuns)
      .values({
        projectId: projectB.id,
        buildId: buildB1.id,
        name: "target-xproj",
        branchName: "main",
        status: "unresolved",
        primarySignature: "v1:target",
      })
      .returning();
    if (!projectBTargetRun) throw new Error("projectBTargetRun not seeded");

    // Every run has diffed checkpoints; the target runs' unresolved ones are
    // what the cluster reject decides (spec §5.7). targetRun1's passed step is
    // not pending and stays undecided.
    const [variationA] = await h.db
      .insert(testVariations)
      .values({ projectId: projectA.id, name: "rc-step" })
      .returning();
    const [variationB] = await h.db
      .insert(testVariations)
      .values({ projectId: projectB.id, name: "rc-step" })
      .returning();
    if (!variationA || !variationB) throw new Error("variations not seeded");
    const shotOf = async (
      run: { id: string; projectId: string },
      variationId: string,
      verdict: "unresolved" | "passed",
      key: string,
    ) => {
      const [shot] = await h.db
        .insert(screenshots)
        .values({
          runId: run.id,
          projectId: run.projectId,
          testVariationId: variationId,
          name: `rc-step-${key}`,
          viewport: "1280x720",
          browser: "chromium",
          imageKey: `rc-${key}`,
          verdict,
        })
        .returning();
      if (!shot) throw new Error("screenshot not seeded");
      return shot.id;
    };
    const t1 = await shotOf(targetRun1, variationA.id, "unresolved", "t1");
    const t1Passed = await shotOf(targetRun1, variationA.id, "passed", "t1p");
    const t2 = await shotOf(targetRun2, variationA.id, "unresolved", "t2");
    await shotOf(otherSigRun, variationA.id, "unresolved", "other");
    await shotOf(projectBTargetRun, variationB.id, "unresolved", "xproj");

    const caller = makeClient(reviewerJwt);
    const res = await caller.inbox.rejectCluster.mutate({
      projectId: projectA.id,
      signature: "v1:target",
      status: "all-open",
      window: "all",
    });

    expect(res.rejected).toBe(2);
    expect(res.runCount).toBe(2);
    expect(res.buildCount).toBe(2);
    expect(res.capped).toBe(false);

    // One action, source inbox, on the pending checkpoints only.
    const decisions = await h.db
      .select()
      .from(checkpointDecisions)
      .where(eq(checkpointDecisions.projectId, projectA.id));
    expect(new Set(decisions.map((d) => d.screenshotId))).toEqual(
      new Set([t1, t2]),
    );
    expect(decisions.map((d) => d.screenshotId)).not.toContain(t1Passed);
    expect(
      decisions.every(
        (d) =>
          d.decision === "rejected" &&
          d.source === "inbox" &&
          d.actorId === reviewerUser.id,
      ),
    ).toBe(true);
    expect(new Set(decisions.map((d) => d.actionId)).size).toBe(1);

    // The cluster-level summary row, plus the core's row per run.
    const [summary] = await h.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "run.reject_cluster"),
          eq(auditLog.targetId, projectA.id),
        ),
      );
    expect(summary?.metadata).toMatchObject({
      signature: "v1:target",
      rejected: 2,
      buildCount: 2,
      capped: false,
      actionId: decisions[0]!.actionId,
      source: "inbox",
    });
    const perRun = await h.db
      .select({ targetId: auditLog.targetId })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "run.reject_checkpoints"),
          inArray(auditLog.targetId, [targetRun1.id, targetRun2.id]),
        ),
      );
    expect(new Set(perRun.map((r) => r.targetId))).toEqual(
      new Set([targetRun1.id, targetRun2.id]),
    );

    // The two target runs are now failed.
    const failed = await h.db
      .select({ id: testRuns.id, status: testRuns.status })
      .from(testRuns)
      .where(inArray(testRuns.id, [targetRun1.id, targetRun2.id]));
    expect(failed.every((r) => r.status === "failed")).toBe(true);

    // Other-sig run untouched.
    const [other] = await h.db
      .select({ status: testRuns.status })
      .from(testRuns)
      .where(eq(testRuns.id, otherSigRun.id));
    expect(other?.status).toBe("unresolved");

    // Other-project same-sig run untouched (cross-project NOT crossed).
    const [xproj] = await h.db
      .select({ status: testRuns.status })
      .from(testRuns)
      .where(eq(testRuns.id, projectBTargetRun.id));
    expect(xproj?.status).toBe("unresolved");

    // Confirm non-member is FORBIDDEN.
    const nonMemberCaller = makeClient(nonMemberJwt);
    await expect(
      nonMemberCaller.inbox.rejectCluster.mutate({
        projectId: projectA.id,
        signature: "v1:target",
        status: "all-open",
        window: "all",
      }),
    ).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
  });

  test("returns zero counts when no in-scope runs match the signature", async () => {
    await wipe();

    const [admin] = await h.db
      .insert(users)
      .values({
        email: "rc-empty@t.example",
        hashedPassword: await hashPassword("x"),
        firstName: "Emp",
        lastName: "Ty",
        role: "admin",
        isActive: true,
      })
      .returning();
    if (!admin) throw new Error("admin not seeded");

    const adminJwt = h.app.jwt.sign({ sub: admin.id, role: "admin" });

    const [project] = await h.db
      .insert(projects)
      .values({ name: "rc-empty-project" })
      .returning();
    if (!project) throw new Error("project not seeded");

    const caller = makeClient(adminJwt);
    const res = await caller.inbox.rejectCluster.mutate({
      projectId: project.id,
      signature: "v1:nonexistent",
      status: "all-open",
      window: "all",
    });

    expect(res.rejected).toBe(0);
    expect(res.runCount).toBe(0);
    expect(res.buildCount).toBe(0);
    expect(res.capped).toBe(false);
  });
});
