import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";

import {
  baselines,
  builds,
  diffRegions,
  eq,
  projectMembers,
  projects,
  recomputeRunStatus,
  screenshots,
  sql,
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
  vi,
} from "vitest";

import { hashPassword } from "../src/lib/password.js";
import type { AppRouter } from "../src/trpc/v1/router.js";

import {
  createTestApp,
  diffEnqueueFailures,
  diffJobsEnqueued,
  type TestApp,
} from "./helpers.js";

// `recomputeRunStatus` calls straight through; the spy lets a test see which
// runs the merge recomputed.
vi.mock("@furan/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@furan/db")>();
  return { ...actual, recomputeRunStatus: vi.fn(actual.recomputeRunStatus) };
});

const skip = !process.env.DATABASE_URL;
const d = skip ? describe.skip : describe;

interface Seeded {
  memberJwt: string;
  nonMemberJwt: string;
  projectId: string;
  /** Seed-stage helper — pre-existing build on fromBranch for variation runs. */
  fromBuildId: string;
}

async function seed(h: TestApp): Promise<Seeded> {
  // FK-order: dependents → parents.
  await h.db.delete(diffRegions);
  await h.db.delete(baselines);
  await h.db.delete(screenshots);
  await h.db.delete(testRuns);
  await h.db.delete(testVariations);
  await h.db.delete(builds);
  await h.db.delete(projectMembers);
  await h.db.delete(projects);
  await h.db.delete(users);

  const [member] = await h.db
    .insert(users)
    .values({
      email: "merge-member@t.example",
      hashedPassword: await hashPassword("x"),
      firstName: "Merge",
      lastName: "Member",
      role: "editor",
      isActive: true,
    })
    .returning();
  const [nonMember] = await h.db
    .insert(users)
    .values({
      email: "merge-nonmember@t.example",
      hashedPassword: await hashPassword("x"),
      firstName: "Non",
      lastName: "Member",
      role: "editor",
      isActive: true,
    })
    .returning();

  const [project] = await h.db
    .insert(projects)
    .values({ name: "merge-test-project" })
    .returning();
  await h.db
    .insert(projectMembers)
    .values({ userId: member.id, projectId: project.id });

  // Pre-existing build on the source branch — runs in the test all hang off this
  // so we don't have to create one per variation in the per-test setup.
  const [fromBuild] = await h.db
    .insert(builds)
    .values({
      projectId: project.id,
      userId: member.id,
      branchName: "feature/x",
      ciBuildId: "from-build",
    })
    .returning();

  return {
    memberJwt: h.app.jwt.sign({ sub: member.id, role: "editor" }),
    nonMemberJwt: h.app.jwt.sign({ sub: nonMember.id, role: "editor" }),
    projectId: project.id,
    fromBuildId: fromBuild.id,
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

/**
 * Inserts a variation + its run on `feature/x` with one screenshot and a
 * baseline row. Returns the variation id so tests can assert against it.
 */
async function seedVariationWithBaseline(
  h: TestApp,
  s: Seeded,
  name: string,
  imageKey: string,
  extra?: { viewport?: string; viewports?: string[] },
): Promise<string> {
  const [v] = await h.db
    .insert(testVariations)
    .values({
      projectId: s.projectId,
      name,
      browser: "chromium",
      viewport: extra?.viewport ?? "1280x720",
    })
    .returning();
  const [r] = await h.db
    .insert(testRuns)
    .values({
      projectId: s.projectId,
      buildId: s.fromBuildId,
      branchName: "feature/x",
      status: "passed",
      merge: true,
      name,
    })
    .returning();
  const viewports = extra?.viewports ?? [extra?.viewport ?? "1280x720"];
  for (const vp of viewports) {
    await h.db.insert(screenshots).values({
      runId: r.id,
      projectId: s.projectId,
      testVariationId: v.id,
      name,
      imageKey: `${imageKey}-${vp}`,
      viewport: vp,
      browser: "chromium",
    });
  }
  await h.db.insert(baselines).values({
    testVariationId: v.id,
    testRunId: r.id,
    branchName: "feature/x",
  });
  return v.id;
}

d("tRPC projects.mergeBranchBaselines", () => {
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
    h.diffQueueAdd.mockClear();
  });

  test("rejects fromBranch === toBranch with BAD_REQUEST", async () => {
    const client = makeClient(baseUrl, s.memberJwt);
    let err: TRPCClientError<AppRouter> | undefined;
    try {
      await client.projects.mergeBranchBaselines.mutate({
        projectId: s.projectId,
        fromBranch: "main",
        toBranch: "main",
      });
    } catch (e) {
      err = e as TRPCClientError<AppRouter>;
    }
    expect(err).toBeDefined();
    expect(err?.data?.code).toBe("BAD_REQUEST");
    expect(err?.message).toMatch(/same_branch/);
  });

  test("non-member receives FORBIDDEN", async () => {
    const client = makeClient(baseUrl, s.nonMemberJwt);
    let err: TRPCClientError<AppRouter> | undefined;
    try {
      await client.projects.mergeBranchBaselines.mutate({
        projectId: s.projectId,
        fromBranch: "feature/x",
        toBranch: "main",
      });
    } catch (e) {
      err = e as TRPCClientError<AppRouter>;
    }
    expect(err?.data?.code).toBe("FORBIDDEN");
  });

  test("happy path: enqueues one merge run per fromBranch baseline", async () => {
    await seedVariationWithBaseline(h, s, "view-1", "hash-1");
    await seedVariationWithBaseline(h, s, "view-2", "hash-2");
    await seedVariationWithBaseline(h, s, "view-3", "hash-3");
    const enqueuedBefore = await diffJobsEnqueued(
      h.app.telemetry.metrics,
      "branch_merge",
    );

    const client = makeClient(baseUrl, s.memberJwt);
    const res = await client.projects.mergeBranchBaselines.mutate({
      projectId: s.projectId,
      fromBranch: "feature/x",
      toBranch: "main",
    });

    expect(res.runCount).toBe(3);
    expect(res.skippedCount).toBe(0);
    expect(res.fromBranch).toBe("feature/x");
    expect(res.toBranch).toBe("main");
    expect(res.buildId).toBeDefined();

    // Synthetic build on main with the deterministic ciBuildId.
    const [mainBuild] = await h.db
      .select()
      .from(builds)
      .where(eq(builds.id, res.buildId));
    expect(mainBuild?.branchName).toBe("main");
    expect(mainBuild?.ciBuildId).toBe("merge:feature/x->main");

    // Three runs on main with threshold override 0, `running` until their
    // copies are diffed. `merge` is the rollup's (a baseline row exists for
    // the run): none yet.
    const mainRuns = await h.db
      .select()
      .from(testRuns)
      .where(eq(testRuns.branchName, "main"));
    expect(mainRuns).toHaveLength(3);
    expect(mainRuns.every((r) => r.merge === false)).toBe(true);
    expect(mainRuns.every((r) => Number(r.diffThresholdOverride) === 0)).toBe(
      true,
    );
    expect(mainRuns.every((r) => r.status === "running")).toBe(true);

    // Synthetic screenshots share imageKey with source (content-addressed).
    const mainShots = await h.db
      .select()
      .from(screenshots)
      .where(eq(screenshots.projectId, s.projectId));
    const mainKeys = mainShots
      .map((sh) => sh.imageKey)
      .filter((k) => k.startsWith("hash-"));
    // Each variation has 1 source shot + 1 synthetic shot, so 6 rows total.
    expect(mainKeys.length).toBe(6);

    // Diff queue calls — one per copied step (one per synthetic run here),
    // each queued by its insert at version 1, under its job id.
    const copies = mainShots.filter((sh) =>
      mainRuns.some((r) => r.id === sh.runId),
    );
    expect(copies).toHaveLength(3);
    expect(copies.every((sh) => sh.diffGeneration === 1)).toBe(true);
    expect(copies.every((sh) => sh.diffQueuedAt instanceof Date)).toBe(true);
    expect(h.diffQueueAdd).toHaveBeenCalledTimes(3);
    const byStep = (a: { screenshotId: string }, b: { screenshotId: string }) =>
      a.screenshotId.localeCompare(b.screenshotId);
    expect(
      h.diffQueueAdd.mock.calls
        .map(([, p, o]) => ({ ...p, jobId: o?.jobId }))
        .sort(byStep),
    ).toEqual(
      copies
        .map((sh) => ({
          runId: sh.runId,
          projectId: s.projectId,
          screenshotId: sh.id,
          generation: 1,
          jobId: `${sh.id}-g1`,
        }))
        .sort(byStep),
    );
    // ...each counted under the branch_merge trigger.
    expect(
      await diffJobsEnqueued(h.app.telemetry.metrics, "branch_merge"),
    ).toBe(enqueuedBefore + 3);
  });

  test("branch merge queues every copied step and sets the synthetic run's count and status", async () => {
    await seedVariationWithBaseline(h, s, "responsive", "hash-r", {
      viewports: ["1280x720", "375x812"],
    });
    await seedVariationWithBaseline(h, s, "single", "hash-s");
    vi.mocked(recomputeRunStatus).mockClear();

    const client = makeClient(baseUrl, s.memberJwt);
    const res = await client.projects.mergeBranchBaselines.mutate({
      projectId: s.projectId,
      fromBranch: "feature/x",
      toBranch: "main",
    });

    expect(res.runCount).toBe(2);
    const mainRuns = await h.db
      .select()
      .from(testRuns)
      .where(eq(testRuns.branchName, "main"));
    const copies = await h.db
      .select()
      .from(screenshots)
      .where(eq(screenshots.projectId, s.projectId));
    const copiesOf = (runId: string) =>
      copies.filter((sh) => sh.runId === runId);
    expect(mainRuns.map((r) => copiesOf(r.id).length).sort()).toEqual([1, 2]);
    for (const run of mainRuns) {
      // The count is the run's copied steps; the status is the rollup's
      // (`recomputeRunStatus`, in the merge's transaction): `running`, as
      // no copy has a verdict until its diff lands.
      expect(run.checkpointCount).toBe(copiesOf(run.id).length);
      expect(run.status).toBe("running");
      expect(recomputeRunStatus).toHaveBeenCalledWith(
        expect.anything(),
        run.id,
      );
    }
    expect(recomputeRunStatus).toHaveBeenCalledTimes(2);
    // Every copied step, at version 1, under its job id; nothing else.
    const queued = mainRuns.flatMap((r) => copiesOf(r.id));
    expect(
      h.diffQueueAdd.mock.calls.map(([, p, o]) => [p.screenshotId, o.jobId]),
    ).toEqual(
      expect.arrayContaining(queued.map((sh) => [sh.id, `${sh.id}-g1`])),
    );
    expect(h.diffQueueAdd).toHaveBeenCalledTimes(3);
  });

  test("the merged run's status is the rollup of its copied steps, not the one it is inserted with", async () => {
    // A merged run is inserted `running`, and a copy that has no verdict
    // yet rolls up to `running` as well, so a normal merge can't tell a
    // recompute from the insert. A trigger gives the steps inserted under a
    // marker name no other test uses (the variation's source step was inserted
    // before it existed, so only the copy) a verdict as they are inserted: the
    // rollup is then `passed`, which only a recompute over the steps can
    // write. The trigger is dropped afterwards, and does nothing to any other
    // step even if a crash leaves it behind.
    const marker = `rollup-marker-${randomUUID()}`;
    await seedVariationWithBaseline(h, s, marker, "hash-rollup");
    // Named with a random suffix, so two local runs on one database never
    // drop each other's trigger. Everything that creates it is inside the
    // `try`, so the `finally` drops whatever got created.
    const fn = sql.raw(`merge_test_copy_verdict_${randomUUID().slice(0, 8)}`);
    vi.mocked(recomputeRunStatus).mockClear();

    try {
      await h.db.execute(sql`
        create or replace function ${fn}() returns trigger language plpgsql as $body$
        begin
          if new.name = '${sql.raw(marker)}' then
            new.verdict := 'passed';
            new.verdict_at := clock_timestamp();
          end if;
          return new;
        end
        $body$`);
      await h.db.execute(sql`drop trigger if exists ${fn} on screenshots`);
      await h.db.execute(
        sql`create trigger ${fn} before insert on screenshots for each row execute function ${fn}()`,
      );

      const client = makeClient(baseUrl, s.memberJwt);
      const res = await client.projects.mergeBranchBaselines.mutate({
        projectId: s.projectId,
        fromBranch: "feature/x",
        toBranch: "main",
      });
      expect(res.runCount).toBe(1);

      const [run] = await h.db
        .select()
        .from(testRuns)
        .where(eq(testRuns.branchName, "main"));
      // Not the `running` the insert wrote; no baseline row exists for it, so
      // the rollup's `merge` is false as well.
      expect(run!.status).toBe("passed");
      expect(run!.merge).toBe(false);
      expect(recomputeRunStatus).toHaveBeenCalledWith(
        expect.anything(),
        run!.id,
      );
    } finally {
      await h.db.execute(sql`drop trigger if exists ${fn} on screenshots`);
      await h.db.execute(sql`drop function if exists ${fn}()`);
    }
  });

  test("an enqueue failure stays best-effort and is counted as a branch_merge failure", async () => {
    await seedVariationWithBaseline(h, s, "view-1", "hash-1");
    const registry = h.app.telemetry.metrics;
    const failuresBefore = await diffEnqueueFailures(registry, "branch_merge");
    const enqueuedBefore = await diffJobsEnqueued(registry, "branch_merge");
    h.diffQueueAdd.mockRejectedValueOnce(new Error("queue is down"));

    try {
      const client = makeClient(baseUrl, s.memberJwt);
      const res = await client.projects.mergeBranchBaselines.mutate({
        projectId: s.projectId,
        fromBranch: "feature/x",
        toBranch: "main",
      });

      // The merge succeeds: the synthetic run exists, only its diff was lost.
      expect(res.runCount).toBe(1);
      expect(res.skippedCount).toBe(0);
      expect(h.diffQueueAdd).toHaveBeenCalledTimes(1);
      expect(await diffEnqueueFailures(registry, "branch_merge")).toBe(
        failuresBefore + 1,
      );
      expect(await diffJobsEnqueued(registry, "branch_merge")).toBe(
        enqueuedBefore,
      );
    } finally {
      h.diffQueueAdd.mockReset();
      h.diffQueueAdd.mockResolvedValue({ id: "test-job-id" });
    }
  });

  test("idempotent: calling merge twice reuses the same synthetic build", async () => {
    await seedVariationWithBaseline(h, s, "view", "hash");

    const client = makeClient(baseUrl, s.memberJwt);
    const res1 = await client.projects.mergeBranchBaselines.mutate({
      projectId: s.projectId,
      fromBranch: "feature/x",
      toBranch: "main",
    });
    const res2 = await client.projects.mergeBranchBaselines.mutate({
      projectId: s.projectId,
      fromBranch: "feature/x",
      toBranch: "main",
    });

    expect(res2.buildId).toBe(res1.buildId);
    // Both calls created a synthetic run; the build holds 2 merge runs for
    // the same variation. Documented behavior — not deduped (spec §9
    // "Idempotent re-merge").
    const mainRuns = await h.db
      .select()
      .from(testRuns)
      .where(eq(testRuns.branchName, "main"));
    expect(mainRuns).toHaveLength(2);
  });

  test("no baselines on fromBranch returns runCount=0 + still creates the synthetic build", async () => {
    const client = makeClient(baseUrl, s.memberJwt);
    const res = await client.projects.mergeBranchBaselines.mutate({
      projectId: s.projectId,
      fromBranch: "feature/x",
      toBranch: "main",
    });
    expect(res.runCount).toBe(0);
    expect(res.skippedCount).toBe(0);
    expect(res.buildId).toBeDefined();
    const mainRuns = await h.db
      .select()
      .from(testRuns)
      .where(eq(testRuns.branchName, "main"));
    expect(mainRuns).toHaveLength(0);
  });

  test("multi-viewport: copies every source screenshot into the synthetic run", async () => {
    await seedVariationWithBaseline(h, s, "responsive", "hash", {
      viewports: ["1280x720", "375x667"],
    });

    const client = makeClient(baseUrl, s.memberJwt);
    const res = await client.projects.mergeBranchBaselines.mutate({
      projectId: s.projectId,
      fromBranch: "feature/x",
      toBranch: "main",
    });
    expect(res.runCount).toBe(1);

    const mainRuns = await h.db
      .select()
      .from(testRuns)
      .where(eq(testRuns.branchName, "main"));
    expect(mainRuns).toHaveLength(1);

    const mainShots = await h.db
      .select()
      .from(screenshots)
      .where(eq(screenshots.runId, mainRuns[0]!.id));
    expect(mainShots).toHaveLength(2);
    expect(mainShots.map((sh) => sh.viewport).sort()).toEqual([
      "1280x720",
      "375x667",
    ]);
  });

  test("only the LATEST baseline per variation on fromBranch is promoted", async () => {
    // Two variations; one variation has TWO baselines on feature/x (newer +
    // older). Merge should pick exactly one — the newest — for that
    // variation, not duplicate.
    const v1 = await seedVariationWithBaseline(h, s, "v1", "hash-v1-new");

    // Insert a second baseline for v1, OLDER (createdAt explicit so we beat
    // any clock skew within a millisecond).
    const [olderRun] = await h.db
      .insert(testRuns)
      .values({
        projectId: s.projectId,
        buildId: s.fromBuildId,
        branchName: "feature/x",
        name: "v1",
        status: "passed",
        merge: true,
      })
      .returning();
    await h.db.insert(screenshots).values({
      runId: olderRun.id,
      projectId: s.projectId,
      testVariationId: v1,
      name: "v1",
      imageKey: "hash-v1-old",
      viewport: "1280x720",
      browser: "chromium",
    });
    await h.db.insert(baselines).values({
      testVariationId: v1,
      testRunId: olderRun.id,
      branchName: "feature/x",
      createdAt: new Date(Date.now() - 60_000),
    });

    const client = makeClient(baseUrl, s.memberJwt);
    const res = await client.projects.mergeBranchBaselines.mutate({
      projectId: s.projectId,
      fromBranch: "feature/x",
      toBranch: "main",
    });

    // One synthetic run for v1 — the newest baseline only.
    expect(res.runCount).toBe(1);
    const mainRuns = await h.db
      .select()
      .from(testRuns)
      .where(eq(testRuns.branchName, "main"));
    expect(mainRuns).toHaveLength(1);
    // The promoted screenshot should match the NEWER baseline's imageKey.
    const mainShots = await h.db
      .select()
      .from(screenshots)
      .where(eq(screenshots.runId, mainRuns[0]!.id));
    expect(mainShots[0]!.imageKey).toBe("hash-v1-new-1280x720");
  });

  test("POST /projects/:id/merge REST route delegates to the same helper", async () => {
    await seedVariationWithBaseline(h, s, "view", "hash");

    const res = await h.app.inject({
      method: "POST",
      url: `/projects/${s.projectId}/merge`,
      headers: {
        Authorization: `Bearer ${s.memberJwt}`,
        "Content-Type": "application/json",
      },
      payload: { fromBranch: "feature/x", toBranch: "main" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { runCount: number; buildId: string };
    expect(body.runCount).toBe(1);
    expect(body.buildId).toBeDefined();
  });

  test("REST route rejects same-branch with 400", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: `/projects/${s.projectId}/merge`,
      headers: {
        Authorization: `Bearer ${s.memberJwt}`,
        "Content-Type": "application/json",
      },
      payload: { fromBranch: "main", toBranch: "main" },
    });
    expect(res.statusCode).toBe(400);
  });

  describe("project-event broadcasts", () => {
    beforeEach(() => {
      h.broadcasterPublish.mockClear();
    });

    test("first merge fires build_created + per-run testRun_created + build_updated", async () => {
      await seedVariationWithBaseline(h, s, "view-1", "hash-1");
      await seedVariationWithBaseline(h, s, "view-2", "hash-2");

      const client = makeClient(baseUrl, s.memberJwt);
      const res = await client.projects.mergeBranchBaselines.mutate({
        projectId: s.projectId,
        fromBranch: "feature/x",
        toBranch: "main",
      });

      const calls = h.broadcasterPublish.mock.calls;
      const events = calls.map(([, ev]) => (ev as { event: string }).event);
      expect(events).toContain("build_created");
      expect(events.filter((e) => e === "testRun_created")).toHaveLength(2);
      expect(events).toContain("build_updated");

      // build_created carries the synthetic build id.
      const buildCreated = calls.find(
        ([, ev]) => (ev as { event: string }).event === "build_created",
      );
      expect(buildCreated?.[1]).toEqual({
        event: "build_created",
        data: { id: res.buildId },
      });
    });

    test("re-merge (retry) does NOT re-fire build_created", async () => {
      await seedVariationWithBaseline(h, s, "view", "hash");

      const client = makeClient(baseUrl, s.memberJwt);
      await client.projects.mergeBranchBaselines.mutate({
        projectId: s.projectId,
        fromBranch: "feature/x",
        toBranch: "main",
      });

      h.broadcasterPublish.mockClear();
      await client.projects.mergeBranchBaselines.mutate({
        projectId: s.projectId,
        fromBranch: "feature/x",
        toBranch: "main",
      });

      const events = h.broadcasterPublish.mock.calls.map(
        ([, ev]) => (ev as { event: string }).event,
      );
      expect(events).not.toContain("build_created");
      expect(events).toContain("testRun_created");
      expect(events).toContain("build_updated");
    });

    test("no source baselines: skips broadcasts entirely (no synthetic runs)", async () => {
      const client = makeClient(baseUrl, s.memberJwt);
      const res = await client.projects.mergeBranchBaselines.mutate({
        projectId: s.projectId,
        fromBranch: "feature/x",
        toBranch: "main",
      });
      expect(res.runCount).toBe(0);

      // build_created fires (the synthetic container is still created) but
      // no testRun_created and no build_updated (skipped because nothing
      // was enqueued).
      const events = h.broadcasterPublish.mock.calls.map(
        ([, ev]) => (ev as { event: string }).event,
      );
      expect(events).toContain("build_created");
      expect(events).not.toContain("testRun_created");
      expect(events).not.toContain("build_updated");
    });
  });
});
