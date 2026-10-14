import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";

import {
  builds,
  checkpointDecisions,
  diffRegions,
  projectMembers,
  projects,
  screenshots,
  sql,
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
import {
  addReviewBuild,
  addReviewRun,
  cleanupReviewSeeds,
  seedReviewRun,
  type ReviewRunSpec,
  type ReviewSeed,
} from "./review-fixtures.js";

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

  test("list paginates builds created within the same millisecond without skipping any", async () => {
    // created_at is microsecond-precision; a JS Date is not. Six builds share
    // the millisecond .123 at different µs (two share one exact instant, one
    // sits on the ms boundary), bracketed by a build in the next and previous
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
    for (const b of seeds) {
      await h.db.insert(builds).values({
        id: b.id,
        projectId: s.projectId,
        createdAt: sql`${b.at}::timestamptz`,
      });
    }
    // Newest first, id DESC on an exact tie.
    const expected = seeds.map((b) => b.id);

    const client = mkClient(h, s.editorJwt);
    for (const limit of [1, 2, 3]) {
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page: Awaited<ReturnType<typeof client.builds.list.query>> =
          await client.builds.list.query({
            projectId: s.projectId,
            limit,
            cursor,
          });
        expect(page.items.length).toBeGreaterThan(0);
        expect(page.items.length).toBeLessThanOrEqual(limit);
        seen.push(...page.items.map((i) => i.id));
        cursor = page.nextCursor ?? undefined;
        pages++;
      } while (cursor && pages <= seeds.length);
      expect(seen, `limit=${limit}`).toEqual(expected);
      expect(pages, `limit=${limit}`).toBe(Math.ceil(seeds.length / limit));
    }
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

  describe("builds.getById", () => {
    test("returns one build with aggregateStatus + counts", async () => {
      const [b] = await h.db
        .insert(builds)
        .values({
          projectId: s.projectId,
          ciBuildId: "g1",
          number: 7,
          name: "nightly",
          branchName: "main",
        })
        .returning();
      if (!b) throw new Error("build not seeded");
      await h.db.insert(testRuns).values([
        {
          projectId: s.projectId,
          buildId: b.id,
          name: "t1",
          branchName: "main",
          status: "passed",
        },
        {
          projectId: s.projectId,
          buildId: b.id,
          name: "t2",
          branchName: "main",
          status: "unresolved",
        },
        {
          projectId: s.projectId,
          buildId: b.id,
          name: "t3",
          branchName: "main",
          status: "failed",
        },
      ]);
      const client = mkClient(h, s.editorJwt);
      const res = await client.builds.getById.query({ buildId: b.id });
      expect(res.id).toBe(b.id);
      expect(res.number).toBe(7);
      expect(res.name).toBe("nightly");
      expect(res.aggregateStatus).toBe("unresolved");
      expect(res.runCount).toBe(3);
      expect(res.unresolvedCount).toBe(1);
      expect(res.failedCount).toBe(1);
      expect(res.passedCount).toBe(1);
      expect(res.newCount).toBe(0);
      expect(res.stepsTotal).toBe(0);
      expect(res.runByName).toBeNull();
    });

    test("NOT_FOUND for a missing build id", async () => {
      const client = mkClient(h, s.editorJwt);
      await expect(
        client.builds.getById.query({
          buildId: "00000000-0000-0000-0000-000000000000",
        }),
      ).rejects.toThrow(/NOT_FOUND/);
    });

    test("non-member is rejected (FORBIDDEN) for another project's build", async () => {
      const [other] = await h.db
        .insert(users)
        .values({
          email: "other-gbi@t.example",
          hashedPassword: await hashPassword("x"),
          firstName: "O",
          lastName: "X",
          role: "editor",
          isActive: true,
        })
        .returning();
      if (!other) throw new Error("other user not seeded");
      const [b] = await h.db
        .insert(builds)
        .values({ projectId: s.projectId, ciBuildId: "g2" })
        .returning();
      if (!b) throw new Error("build not seeded");
      const otherJwt = h.app.jwt.sign({ sub: other.id, role: "editor" });
      const client = mkClient(h, otherJwt);
      await expect(
        client.builds.getById.query({ buildId: b.id }),
      ).rejects.toThrow(/FORBIDDEN/);
    });

    test("admin bypasses membership", async () => {
      const [admin] = await h.db
        .insert(users)
        .values({
          email: "admin-gbi@t.example",
          hashedPassword: await hashPassword("x"),
          firstName: "A",
          lastName: "D",
          role: "admin",
          isActive: true,
        })
        .returning();
      if (!admin) throw new Error("admin not seeded");
      const [b] = await h.db
        .insert(builds)
        .values({ projectId: s.projectId, ciBuildId: "g3" })
        .returning();
      if (!b) throw new Error("build not seeded");
      const adminJwt = h.app.jwt.sign({ sub: admin.id, role: "admin" });
      const client = mkClient(h, adminJwt);
      const res = await client.builds.getById.query({ buildId: b.id });
      expect(res.id).toBe(b.id);
    });

    test("returns aggregateStatus 'empty' + zero counts for a build with no runs", async () => {
      const [b] = await h.db
        .insert(builds)
        .values({ projectId: s.projectId, ciBuildId: "g-empty" })
        .returning();
      if (!b) throw new Error("build not seeded");
      const client = mkClient(h, s.editorJwt);
      const res = await client.builds.getById.query({ buildId: b.id });
      expect(res.aggregateStatus).toBe("empty");
      expect(res.runCount).toBe(0);
    });
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

d("tRPC builds: needing review, pending counts and the pending badge", () => {
  let h: TestApp;
  const seeds: ReviewSeed[] = [];

  async function seed(
    spec: ReviewRunSpec,
    opts?: { branch?: string },
  ): Promise<ReviewSeed> {
    const s = await seedReviewRun(h, spec, opts);
    seeds.push(s);
    return s;
  }

  /** The client of one of the seed's users. */
  const as = (user: { jwt: string }) => mkClient(h, user.jwt);

  /** A decision row (an approve unless `decision`), active unless `reverted`. */
  async function decide(
    s: ReviewSeed,
    runId: string,
    shotId: string,
    opts: { reverted?: boolean; decision?: "approved" | "rejected" } = {},
  ): Promise<void> {
    await h.db.insert(checkpointDecisions).values({
      projectId: s.projectId,
      runId,
      screenshotId: shotId,
      actionId: randomUUID(),
      decision: opts.decision ?? "approved",
      actorId: s.editor.id,
      source: "viewer",
      before: null,
      revertedAt: opts.reverted ? new Date() : null,
      revertedBy: opts.reverted ? s.editor.id : null,
    });
  }

  const idsOf = (page: { items: Array<{ id: string }> }) =>
    page.items.map((i) => i.id);
  const sorted = (ids: string[]) => [...ids].sort();

  beforeAll(async () => {
    h = await createTestApp();
    h.app.log.level = "silent";
    await h.app.listen({ host: "127.0.0.1", port: 0 });
  });
  afterAll(async () => {
    await cleanupReviewSeeds(h, seeds);
    await h.close();
  });

  test("needsReview keeps builds with pending steps", async () => {
    // A: a build whose only run is all `new`: pending.
    const s = await seed({
      checkpoints: [
        { name: "a1", verdict: "new" },
        { name: "a2", verdict: "new" },
      ],
    });
    const a = s.buildId;
    // B: every step rejected: nothing left to review.
    const bRun = await addReviewBuild(h, s, {
      spec: { checkpoints: [{ name: "b1", verdict: "unresolved" }] },
    });
    await decide(s, bRun.runId, bRun.shots["b1"]!.id, {
      decision: "rejected",
    });
    // C: only passed steps: nothing to review.
    const c = await addReviewBuild(h, s, {
      spec: { checkpoints: [{ name: "c1", verdict: "passed" }] },
    });
    // D: an unresolved step whose approve was reverted: pending again.
    const dRun = await addReviewBuild(h, s, {
      spec: { checkpoints: [{ name: "d1", verdict: "unresolved" }] },
    });
    await decide(s, dRun.runId, dRun.shots["d1"]!.id, { reverted: true });
    // E: still running, so not reviewable: its steps are not pending.
    const e = await addReviewBuild(h, s, {
      spec: {
        lifecycle: "running",
        checkpoints: [{ name: "e1", verdict: "unresolved" }],
      },
    });
    // F: no runs at all.
    const [f] = await h.db
      .insert(builds)
      .values({ projectId: s.projectId, branchName: s.branch })
      .returning({ id: builds.id });

    const client = as(s.editor);
    const all = await client.builds.list.query({ projectId: s.projectId });
    expect(sorted(idsOf(all))).toEqual(
      sorted([a, bRun.buildId, c.buildId, dRun.buildId, e.buildId, f!.id]),
    );

    const needing = await client.builds.list.query({
      projectId: s.projectId,
      needsReview: true,
    });
    expect(sorted(idsOf(needing))).toEqual(sorted([a, dRun.buildId]));

    // `false` is no filter, like leaving it out.
    const notFiltering = await client.builds.list.query({
      projectId: s.projectId,
      needsReview: false,
    });
    expect(sorted(idsOf(notFiltering))).toEqual(sorted(idsOf(all)));
  });

  test("needsReview combines with the other filters and pages without gaps", async () => {
    const s = await seed(
      { checkpoints: [{ name: "x1", verdict: "new" }] },
      { branch: "feature/one" },
    );
    const b2 = await addReviewBuild(h, s, {
      branch: "feature/two",
      spec: { checkpoints: [{ name: "x2", verdict: "unresolved" }] },
    });
    const b3 = await addReviewBuild(h, s, {
      branch: "feature/one",
      spec: { checkpoints: [{ name: "x3", verdict: "new" }] },
    });
    // Nothing to review on this one, between the others in time.
    await addReviewBuild(h, s, {
      branch: "feature/one",
      spec: { checkpoints: [{ name: "x4", verdict: "passed" }] },
    });
    const b5 = await addReviewBuild(h, s, {
      branch: "feature/one",
      spec: { checkpoints: [{ name: "x5", verdict: "unresolved" }] },
    });
    const client = as(s.editor);

    // AND with the branch filter.
    const onOne = await client.builds.list.query({
      projectId: s.projectId,
      needsReview: true,
      branch: "feature/one",
    });
    expect(sorted(idsOf(onOne))).toEqual(
      sorted([s.buildId, b3.buildId, b5.buildId]),
    );
    // AND with the aggregate status: x1/x3 are `new` (passed in the rollup),
    // x2/x5 are unresolved.
    const unresolved = await client.builds.list.query({
      projectId: s.projectId,
      needsReview: true,
      status: "unresolved",
    });
    expect(sorted(idsOf(unresolved))).toEqual(sorted([b2.buildId, b5.buildId]));

    // Keyset paging walks exactly the matching builds, newest first.
    const walked: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 6; i++) {
      const page = await client.builds.list.query({
        projectId: s.projectId,
        needsReview: true,
        limit: 1,
        ...(cursor ? { cursor } : {}),
      });
      walked.push(...idsOf(page));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(walked).toEqual([b5.buildId, b3.buildId, b2.buildId, s.buildId]);
  });

  test("anyFailed keeps batches with at least one failed run, whatever else they hold", async () => {
    // A: one rejected run and one pending run. The batch rolls up to
    // `unresolved`, yet it has a failed test and a step to review.
    const s = await seed({
      lifecycle: "failed",
      checkpoints: [{ name: "a-rejected", verdict: "unresolved" }],
    });
    await decide(s, s.runId, s.shots["a-rejected"]!.id, {
      decision: "rejected",
    });
    await addReviewRun(h, s, {
      checkpoints: [{ name: "a-pending", verdict: "unresolved" }],
    });
    const a = s.buildId;
    // B: only a rejected run: failed, nothing left to review.
    const b = await addReviewBuild(h, s, {
      spec: {
        lifecycle: "failed",
        checkpoints: [{ name: "b-rejected", verdict: "unresolved" }],
      },
    });
    await decide(s, b.runId, b.shots["b-rejected"]!.id, {
      decision: "rejected",
    });
    // C: only a pending run: to review, no failure.
    const c = await addReviewBuild(h, s, {
      spec: { checkpoints: [{ name: "c1", verdict: "new" }] },
    });
    // D: only passed steps.
    const dBuild = await addReviewBuild(h, s, {
      spec: { checkpoints: [{ name: "d1", verdict: "passed" }] },
    });
    // E: no runs at all.
    const [e] = await h.db
      .insert(builds)
      .values({ projectId: s.projectId, branchName: s.branch })
      .returning({ id: builds.id });

    const client = as(s.editor);
    const list = (extra: {
      anyFailed?: boolean;
      needsReview?: boolean;
      status?: "failed" | "unresolved";
    }) => client.builds.list.query({ projectId: s.projectId, ...extra });

    const failing = await list({ anyFailed: true });
    expect(sorted(idsOf(failing))).toEqual(sorted([a, b.buildId]));
    // A is `unresolved` in the rollup, so `status: "failed"` would miss it.
    expect(failing.items.find((i) => i.id === a)?.aggregateStatus).toBe(
      "unresolved",
    );
    expect(failing.items.find((i) => i.id === a)?.failedCount).toBe(1);

    // The same batch is under Needs review as well: the chips are filters,
    // not a partition.
    const needing = await list({ needsReview: true });
    expect(sorted(idsOf(needing))).toEqual(sorted([a, c.buildId]));

    // It combines with the other filters by AND.
    expect(
      sorted(idsOf(await list({ anyFailed: true, needsReview: true }))),
    ).toEqual([a]);
    expect(
      sorted(idsOf(await list({ anyFailed: true, status: "failed" }))),
    ).toEqual([b.buildId]);

    // `false` is no filter, like leaving it out.
    const all = await list({});
    expect(sorted(idsOf(await list({ anyFailed: false })))).toEqual(
      sorted(idsOf(all)),
    );
    expect(sorted(idsOf(all))).toEqual(
      sorted([a, b.buildId, c.buildId, dBuild.buildId, e!.id]),
    );
  });

  test("pendingCheckpoints per row equals builds.getById.pendingCheckpoints", async () => {
    // A: three steps, two pending (one decided).
    const s = await seed({
      checkpoints: [
        { name: "a-new", verdict: "new" },
        { name: "a-unresolved", verdict: "unresolved" },
        { name: "a-decided", verdict: "unresolved" },
      ],
    });
    const aRun = s.runId;
    await decide(s, aRun, s.shots["a-decided"]!.id);
    // A second run in the same build: one more pending step, and a run that is
    // still running (not reviewable, so none of its steps count).
    await addReviewRun(h, s, {
      checkpoints: [{ name: "a2", verdict: "new" }],
    });
    await addReviewRun(h, s, {
      lifecycle: "running",
      checkpoints: [{ name: "a3", verdict: "unresolved" }],
    });
    // B: nothing pending.
    await addReviewBuild(h, s, {
      spec: { checkpoints: [{ name: "b", verdict: "passed" }] },
    });
    // C: three pending steps over two runs.
    const c = await addReviewBuild(h, s, {
      spec: {
        checkpoints: [
          { name: "c1", verdict: "new" },
          { name: "c2", verdict: "unresolved" },
        ],
      },
    });
    await addReviewRun(
      h,
      s,
      { checkpoints: [{ name: "c3", verdict: "unresolved" }] },
      { buildId: c.buildId },
    );
    // D: no runs.
    await h.db
      .insert(builds)
      .values({ projectId: s.projectId, branchName: s.branch });

    const client = as(s.editor);
    const page = await client.builds.list.query({ projectId: s.projectId });
    expect(page.items).toHaveLength(4);
    for (const item of page.items) {
      const detail = await client.builds.getById.query({ buildId: item.id });
      expect(item.pendingCheckpoints).toBe(detail.pendingCheckpoints);
    }
    // And the numbers are what the seed says they are, not all zero.
    const byId = new Map(page.items.map((i) => [i.id, i.pendingCheckpoints]));
    expect(byId.get(s.buildId)).toBe(3);
    expect(byId.get(c.buildId)).toBe(3);
    expect(page.items.filter((i) => i.pendingCheckpoints === 0)).toHaveLength(
      2,
    );

    // needsReview rows count the same.
    const needing = await client.builds.list.query({
      projectId: s.projectId,
      needsReview: true,
    });
    expect(
      Object.fromEntries(
        needing.items.map((i) => [i.id, i.pendingCheckpoints]),
      ),
    ).toEqual({ [s.buildId]: 3, [c.buildId]: 3 });
  });

  test("builds.pendingCount counts builds, member-gated", async () => {
    // A: three pending steps over two runs count once.
    const s = await seed({
      checkpoints: [
        { name: "a1", verdict: "new" },
        { name: "a2", verdict: "unresolved" },
      ],
    });
    await addReviewRun(h, s, {
      checkpoints: [{ name: "a3", verdict: "new" }],
    });
    // B: pending. C: nothing pending.
    const b = await addReviewBuild(h, s, {
      spec: { checkpoints: [{ name: "b1", verdict: "unresolved" }] },
    });
    await addReviewBuild(h, s, {
      spec: { checkpoints: [{ name: "c1", verdict: "passed" }] },
    });
    // A build in another project does not count.
    const other = await seed({
      checkpoints: [{ name: "o1", verdict: "new" }],
    });

    const count = (user: { jwt: string }, projectId: string) =>
      as(user).builds.pendingCount.query({ projectId });
    expect(await count(s.editor, s.projectId)).toEqual({ total: 2 });
    expect(await count(other.editor, other.projectId)).toEqual({ total: 1 });

    // It follows the decisions: deciding B's only step takes B out.
    await decide(s, b.runId, b.shots["b1"]!.id, { decision: "rejected" });
    expect(await count(s.editor, s.projectId)).toEqual({ total: 1 });

    // A project without builds is zero.
    const empty = await seed({
      checkpoints: [{ name: "e1", verdict: "passed" }],
    });
    expect(await count(empty.editor, empty.projectId)).toEqual({ total: 0 });

    // The gate: members and admins only.
    await expect(count(s.outsider, s.projectId)).rejects.toThrow(/FORBIDDEN/);
    await expect(count(s.guest, s.projectId)).rejects.toThrow(/FORBIDDEN/);
    await expect(count(s.editor, other.projectId)).rejects.toThrow(/FORBIDDEN/);
    await expect(count(s.admin, s.projectId)).resolves.toEqual({ total: 1 });
    await expect(
      mkClient(h, "not-a-token").builds.pendingCount.query({
        projectId: s.projectId,
      }),
    ).rejects.toThrow(/UNAUTHORIZED/);
  });
});
