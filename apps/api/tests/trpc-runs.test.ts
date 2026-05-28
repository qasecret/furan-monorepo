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
  memberId: string;
  memberJwt: string;
  nonMemberId: string;
  nonMemberJwt: string;
  runId: string;
  projectId: string;
  variationId: string;
}

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
    .values({
      projectId: project.id,
      userId: member.id,
      isRunning: true,
    })
    .returning();

  const [variation] = await h.db
    .insert(testVariations)
    .values({ name: "home", projectId: project.id })
    .returning();

  const [run] = await h.db
    .insert(testRuns)
    .values({
      buildId: build.id,
      projectId: project.id,
      testVariationId: variation.id,
      // Per spec §3.3 (run-status-enum) only terminal review states are
      // reviewer-overridable. `unresolved` is the canonical "diff-worker
      // found differences, awaiting review" status — i.e. the state most
      // tests want as a starting point for approve/reject coverage.
      status: "unresolved",
      branchName: "feature/x",
      name: "home page",
    })
    .returning();

  return {
    memberId: member.id,
    memberJwt: h.app.jwt.sign({ sub: member.id, role: "editor" }),
    nonMemberId: nonMember.id,
    nonMemberJwt: h.app.jwt.sign({ sub: nonMember.id, role: "editor" }),
    runId: run.id,
    projectId: project.id,
    variationId: variation.id,
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

// Tiny helper to dedupe the IIFE that reads buildId off a seeded run.
// The /runs payload requires a buildId, and across this file we always
// reuse the seeded run's build to avoid spinning up a second one.
async function getSeedBuildId(h: TestApp, runId: string): Promise<string> {
  const rows = await h.db
    .select({ buildId: testRuns.buildId })
    .from(testRuns)
    .where(eq(testRuns.id, runId))
    .limit(1);
  return rows[0]!.buildId;
}

d("tRPC runs router", () => {
  let h: TestApp;
  let baseUrl: string;
  let s: Seeded;

  beforeAll(async () => {
    process.env.S3_ENDPOINT ??= "http://localhost:9000";
    process.env.S3_BUCKET ??= "furan-dev";
    process.env.S3_ACCESS_KEY ??= "furan";
    process.env.S3_SECRET_KEY ??= "devpw_must_be_long"; // gitleaks:allow
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

  test("getById: member can fetch run with screenshots + diffRegions", async () => {
    const client = makeClient(baseUrl, s.memberJwt);
    const data = await client.runs.getById.query({ runId: s.runId });
    expect(data.id).toBe(s.runId);
    expect(Array.isArray(data.screenshots)).toBe(true);
    expect(Array.isArray(data.diffRegions)).toBe(true);
    // T9: baseline lookup is included; null for a run with no prior baseline.
    expect(data.baselineScreenshot).toBeNull();
    expect(data.baselineSource).toBeNull();
  });

  test("getById: returns baselineScreenshot when a prior baseline exists", async () => {
    // Seed an older run on the SAME variation+branch and snapshot it as the
    // baseline; resolveBaseline should pick it up via the this_branch tier.
    const [olderRun] = await h.db
      .insert(testRuns)
      .values({
        buildId: await getSeedBuildId(h, s.runId),
        projectId: s.projectId,
        testVariationId: s.variationId,
        // Legacy `"ok"` value is no longer a valid enum label (migration
        // 0008 remaps it to "passed"). Use the post-migration spelling.
        status: "passed",
        branchName: "feature/x",
        name: "older",
      })
      .returning();

    const [bl] = await h.db
      .insert(baselines)
      .values({
        baselineName: "older",
        testVariationId: s.variationId,
        testRunId: olderRun.id,
        branchName: "feature/x",
      })
      .returning();
    expect(bl.id).toBeDefined();

    const olderShot = await h.db
      .insert(screenshots)
      .values({
        runId: olderRun.id,
        projectId: s.projectId,
        imageKey: "a".repeat(64),
        viewport: "1280x720",
        browser: "chromium",
      })
      .returning();
    expect(olderShot[0]?.id).toBeDefined();

    const client = makeClient(baseUrl, s.memberJwt);
    const data = await client.runs.getById.query({ runId: s.runId });
    expect(data.baselineScreenshot).not.toBeNull();
    expect(data.baselineScreenshot?.imageKey).toBe("a".repeat(64));
    expect(data.baselineSource).toBe("this_branch");
  });

  test("getById: returns variationIgnoreAreas from the run's variation", async () => {
    const region = {
      x: 10,
      y: 20,
      width: 30,
      height: 40,
      viewport: "1280x720",
    };
    await h.db
      .update(testVariations)
      .set({ ignoreAreas: JSON.stringify([region]) })
      .where(eq(testVariations.id, s.variationId));

    const client = makeClient(baseUrl, s.memberJwt);
    const data = await client.runs.getById.query({ runId: s.runId });
    expect(data.variationIgnoreAreas).toEqual([region]);
  });

  test("getById: variationIgnoreAreas is null when variation column is null", async () => {
    const client = makeClient(baseUrl, s.memberJwt);
    const data = await client.runs.getById.query({ runId: s.runId });
    expect(data.variationIgnoreAreas).toBeNull();
  });

  test("getById: variationIgnoreAreas is null when column holds malformed JSON", async () => {
    await h.db
      .update(testVariations)
      .set({ ignoreAreas: "not-valid-json" })
      .where(eq(testVariations.id, s.variationId));

    const client = makeClient(baseUrl, s.memberJwt);
    const data = await client.runs.getById.query({ runId: s.runId });
    expect(data.variationIgnoreAreas).toBeNull();
  });

  test("getById: returns ignoreAreas as a parsed array (not raw JSON string)", async () => {
    const region = { x: 5, y: 5, width: 20, height: 20, viewport: "1280x720" };
    await h.db
      .update(testRuns)
      .set({ ignoreAreas: JSON.stringify([region]) })
      .where(eq(testRuns.id, s.runId));

    const client = makeClient(baseUrl, s.memberJwt);
    const data = await client.runs.getById.query({ runId: s.runId });
    expect(data.ignoreAreas).toEqual([region]);
  });

  test("getById: ignoreAreas is null when test_runs.ignore_areas column is null", async () => {
    const client = makeClient(baseUrl, s.memberJwt);
    const data = await client.runs.getById.query({ runId: s.runId });
    expect(data.ignoreAreas).toBeNull();
  });

  test("getById: ignoreAreas is null when test_runs.ignore_areas holds malformed JSON", async () => {
    await h.db
      .update(testRuns)
      .set({ ignoreAreas: "not-valid-json" })
      .where(eq(testRuns.id, s.runId));

    const client = makeClient(baseUrl, s.memberJwt);
    const data = await client.runs.getById.query({ runId: s.runId });
    expect(data.ignoreAreas).toBeNull();
  });

  test("getById: non-member receives FORBIDDEN", async () => {
    const client = makeClient(baseUrl, s.nonMemberJwt);
    let err: TRPCClientError<AppRouter> | undefined;
    try {
      await client.runs.getById.query({ runId: s.runId });
    } catch (e) {
      err = e as TRPCClientError<AppRouter>;
    }
    expect(err).toBeDefined();
    expect(err?.data?.code).toBe("FORBIDDEN");
  });

  test("getById: missing credentials → UNAUTHORIZED", async () => {
    const client = makeClient(baseUrl); // no jwt
    let err: TRPCClientError<AppRouter> | undefined;
    try {
      await client.runs.getById.query({ runId: s.runId });
    } catch (e) {
      err = e as TRPCClientError<AppRouter>;
    }
    expect(err).toBeDefined();
    expect(err?.data?.code).toBe("UNAUTHORIZED");
  });

  test("approve: writes status=passed, merge=true and inserts a baseline row", async () => {
    const client = makeClient(baseUrl, s.memberJwt);
    const res = await client.runs.approve.mutate({ runId: s.runId });
    expect(res).toEqual({ runId: s.runId, approved: true });

    const updatedRows = await h.db
      .select()
      .from(testRuns)
      .where(eq(testRuns.id, s.runId))
      .limit(1);
    expect(updatedRows[0]?.merge).toBe(true);
    expect(updatedRows[0]?.status).toBe("passed");

    const baselineRows = await h.db
      .select()
      .from(baselines)
      .where(eq(baselines.testRunId, s.runId));
    expect(baselineRows.length).toBe(1);
    expect(baselineRows[0]?.branchName).toBe("feature/x");
    expect(baselineRows[0]?.userId).toBe(s.memberId);
  });

  test("reject: writes status=failed, merge=false (and does NOT insert a baseline)", async () => {
    // First approve to flip status=passed/merge=true, then reject to
    // ensure both flips work; both source statuses are reviewer-legal.
    const client = makeClient(baseUrl, s.memberJwt);
    await client.runs.approve.mutate({ runId: s.runId });

    const res = await client.runs.reject.mutate({ runId: s.runId });
    expect(res).toEqual({ runId: s.runId, approved: false });

    const updatedRows = await h.db
      .select()
      .from(testRuns)
      .where(eq(testRuns.id, s.runId))
      .limit(1);
    expect(updatedRows[0]?.merge).toBe(false);
    expect(updatedRows[0]?.status).toBe("failed");
  });

  test("transitions unresolved → failed and sets merge=false (canonical reviewer reject)", async () => {
    // Direct unresolved → reject path. The other reject test above
    // approves first (so the source status is `passed`); this test
    // covers the more common production case where the reviewer sees a
    // diff-worker-emitted `unresolved` and rejects without any prior
    // approve hop. Seed gives status=unresolved already (see `seed()`).
    const client = makeClient(baseUrl, s.memberJwt);
    const res = await client.runs.reject.mutate({ runId: s.runId });
    expect(res).toEqual({ runId: s.runId, approved: false });

    const updatedRows = await h.db
      .select()
      .from(testRuns)
      .where(eq(testRuns.id, s.runId))
      .limit(1);
    expect(updatedRows[0]?.status).toBe("failed");
    expect(updatedRows[0]?.merge).toBe(false);

    // Reject MUST NOT insert a baselines row — that's approve's job.
    // (Inserting one here would orphan a baseline pointing at a rejected
    // run, which would then be picked as a baseline by future diffs.)
    const baselineRows = await h.db
      .select()
      .from(baselines)
      .where(eq(baselines.testRunId, s.runId));
    expect(baselineRows.length).toBe(0);
  });

  test("approve: rejects BAD_REQUEST when run.status='aborted'", async () => {
    await h.db
      .update(testRuns)
      .set({ status: "aborted" })
      .where(eq(testRuns.id, s.runId));
    const client = makeClient(baseUrl, s.memberJwt);
    let err: TRPCClientError<AppRouter> | undefined;
    try {
      await client.runs.approve.mutate({ runId: s.runId });
    } catch (e) {
      err = e as TRPCClientError<AppRouter>;
    }
    expect(err?.data?.code).toBe("BAD_REQUEST");
  });

  test("approve: accepts run.status='new' and materialises baseline (ADR-036)", async () => {
    // First-baseline-with-autoApproveFeature=false path: diff-worker
    // lands the run as 'new' without seeding a baseline. The reviewer's
    // approve must materialise it (legacy backend's `approve()` parity).
    await h.db
      .update(testRuns)
      .set({ status: "new", merge: true })
      .where(eq(testRuns.id, s.runId));
    // Sanity: no baseline exists for this run yet.
    const beforeBaselines = await h.db
      .select()
      .from(baselines)
      .where(eq(baselines.testRunId, s.runId));
    expect(beforeBaselines.length).toBe(0);

    const client = makeClient(baseUrl, s.memberJwt);
    const res = await client.runs.approve.mutate({ runId: s.runId });
    expect(res).toEqual({ runId: s.runId, approved: true });

    const rows = await h.db
      .select()
      .from(testRuns)
      .where(eq(testRuns.id, s.runId))
      .limit(1);
    expect(rows[0]?.status).toBe("passed");
    expect(rows[0]?.merge).toBe(true);

    const afterBaselines = await h.db
      .select()
      .from(baselines)
      .where(eq(baselines.testRunId, s.runId));
    expect(afterBaselines.length).toBe(1);
    // userId set → manually approved (not auto-seeded).
    expect(afterBaselines[0]?.userId).not.toBeNull();
  });

  test("approve: idempotent no-op when run.status='passed'", async () => {
    await h.db
      .update(testRuns)
      .set({ status: "passed", merge: true })
      .where(eq(testRuns.id, s.runId));
    const client = makeClient(baseUrl, s.memberJwt);
    const res = await client.runs.approve.mutate({ runId: s.runId });
    expect(res).toEqual({ runId: s.runId, approved: true });
    const rows = await h.db
      .select()
      .from(testRuns)
      .where(eq(testRuns.id, s.runId))
      .limit(1);
    expect(rows[0]?.status).toBe("passed");
    expect(rows[0]?.merge).toBe(true);
  });

  test("reject: rejects BAD_REQUEST when run.status='new' (would orphan baseline)", async () => {
    await h.db
      .update(testRuns)
      .set({ status: "new", merge: true })
      .where(eq(testRuns.id, s.runId));
    const client = makeClient(baseUrl, s.memberJwt);
    let err: TRPCClientError<AppRouter> | undefined;
    try {
      await client.runs.reject.mutate({ runId: s.runId });
    } catch (e) {
      err = e as TRPCClientError<AppRouter>;
    }
    expect(err?.data?.code).toBe("BAD_REQUEST");
  });

  describe("overrideStatus", () => {
    test("status=passed: writes status without touching merge", async () => {
      // Seed: status=unresolved (from helper), merge defaults to false.
      const client = makeClient(baseUrl, s.memberJwt);
      const res = await client.runs.overrideStatus.mutate({
        runId: s.runId,
        status: "passed",
      });
      expect(res).toEqual({ runId: s.runId, status: "passed" });
      const rows = await h.db
        .select()
        .from(testRuns)
        .where(eq(testRuns.id, s.runId))
        .limit(1);
      expect(rows[0]?.status).toBe("passed");
      // merge unchanged (still default false from the seed insert).
      expect(rows[0]?.merge).toBe(false);
    });

    test("status='default' recomputes to 'unresolved' when diff_regions has severity!=none", async () => {
      // Pre-seed run as `passed` so the recompute must flip it back.
      await h.db
        .update(testRuns)
        .set({ status: "passed" })
        .where(eq(testRuns.id, s.runId));
      await h.db.insert(diffRegions).values({
        runId: s.runId,
        projectId: s.projectId,
        severity: "major",
        category: "layout",
        bbox: { x: 0, y: 0, width: 1, height: 1 },
        description: "test",
        source: "l1",
      });
      const client = makeClient(baseUrl, s.memberJwt);
      const res = await client.runs.overrideStatus.mutate({
        runId: s.runId,
        status: "default",
      });
      expect(res.status).toBe("unresolved");
      const rows = await h.db
        .select()
        .from(testRuns)
        .where(eq(testRuns.id, s.runId))
        .limit(1);
      expect(rows[0]?.status).toBe("unresolved");
    });

    test("status='default' resolves to 'passed' when no diff_regions rows exist", async () => {
      // Seed: status=unresolved (from helper), no diff_regions inserted.
      // Recompute should flip it to passed.
      const client = makeClient(baseUrl, s.memberJwt);
      const res = await client.runs.overrideStatus.mutate({
        runId: s.runId,
        status: "default",
      });
      expect(res.status).toBe("passed");
    });

    test("status='default' resolves to 'passed' when all diff_regions have severity=none", async () => {
      await h.db.insert(diffRegions).values({
        runId: s.runId,
        projectId: s.projectId,
        severity: "none",
        category: "layout",
        bbox: { x: 0, y: 0, width: 1, height: 1 },
        description: "below threshold",
        source: "l1",
      });
      const client = makeClient(baseUrl, s.memberJwt);
      const res = await client.runs.overrideStatus.mutate({
        runId: s.runId,
        status: "default",
      });
      expect(res.status).toBe("passed");
    });

    test("rejects BAD_REQUEST when run.status='running'", async () => {
      await h.db
        .update(testRuns)
        .set({ status: "running" })
        .where(eq(testRuns.id, s.runId));
      const client = makeClient(baseUrl, s.memberJwt);
      let err: TRPCClientError<AppRouter> | undefined;
      try {
        await client.runs.overrideStatus.mutate({
          runId: s.runId,
          status: "passed",
        });
      } catch (e) {
        err = e as TRPCClientError<AppRouter>;
      }
      expect(err?.data?.code).toBe("BAD_REQUEST");
    });

    test("rejects BAD_REQUEST when run.status='aborted'", async () => {
      await h.db
        .update(testRuns)
        .set({ status: "aborted" })
        .where(eq(testRuns.id, s.runId));
      const client = makeClient(baseUrl, s.memberJwt);
      let err: TRPCClientError<AppRouter> | undefined;
      try {
        await client.runs.overrideStatus.mutate({
          runId: s.runId,
          status: "passed",
        });
      } catch (e) {
        err = e as TRPCClientError<AppRouter>;
      }
      expect(err?.data?.code).toBe("BAD_REQUEST");
    });

    test("rejects invalid status value", async () => {
      const client = makeClient(baseUrl, s.memberJwt);
      let err: TRPCClientError<AppRouter> | undefined;
      try {
        await client.runs.overrideStatus.mutate({
          runId: s.runId,
          // @ts-expect-error deliberately invalid status
          status: "running",
        });
      } catch (e) {
        err = e as TRPCClientError<AppRouter>;
      }
      expect(err?.data?.code).toBe("BAD_REQUEST");
    });

    test("non-member receives FORBIDDEN", async () => {
      const client = makeClient(baseUrl, s.nonMemberJwt);
      let err: TRPCClientError<AppRouter> | undefined;
      try {
        await client.runs.overrideStatus.mutate({
          runId: s.runId,
          status: "passed",
        });
      } catch (e) {
        err = e as TRPCClientError<AppRouter>;
      }
      expect(err?.data?.code).toBe("FORBIDDEN");
    });

    test("unauthenticated receives UNAUTHORIZED", async () => {
      const client = makeClient(baseUrl);
      let err: TRPCClientError<AppRouter> | undefined;
      try {
        await client.runs.overrideStatus.mutate({
          runId: s.runId,
          status: "passed",
        });
      } catch (e) {
        err = e as TRPCClientError<AppRouter>;
      }
      expect(err?.data?.code).toBe("UNAUTHORIZED");
    });
  });

  test("approve: non-member receives FORBIDDEN", async () => {
    const client = makeClient(baseUrl, s.nonMemberJwt);
    let err: TRPCClientError<AppRouter> | undefined;
    try {
      await client.runs.approve.mutate({ runId: s.runId });
    } catch (e) {
      err = e as TRPCClientError<AppRouter>;
    }
    expect(err).toBeDefined();
    expect(err?.data?.code).toBe("FORBIDDEN");
  });

  test("setComment: writes a string and surfaces it via getById", async () => {
    const client = makeClient(baseUrl, s.memberJwt);
    const res = await client.runs.setComment.mutate({
      runId: s.runId,
      comment: "a reviewer note",
    });
    expect(res).toEqual({ runId: s.runId, comment: "a reviewer note" });

    const got = await client.runs.getById.query({ runId: s.runId });
    expect(got.comment).toBe("a reviewer note");
  });

  test("setComment: null clears the column", async () => {
    const client = makeClient(baseUrl, s.memberJwt);
    await client.runs.setComment.mutate({ runId: s.runId, comment: "x" });
    const cleared = await client.runs.setComment.mutate({
      runId: s.runId,
      comment: null,
    });
    expect(cleared).toEqual({ runId: s.runId, comment: null });

    const got = await client.runs.getById.query({ runId: s.runId });
    expect(got.comment).toBeNull();
  });

  test("setComment: empty string stored verbatim (server is not the normalizer)", async () => {
    const client = makeClient(baseUrl, s.memberJwt);
    const res = await client.runs.setComment.mutate({
      runId: s.runId,
      comment: "",
    });
    expect(res).toEqual({ runId: s.runId, comment: "" });
  });

  test("setComment: length cap rejects > 10,000 chars", async () => {
    const client = makeClient(baseUrl, s.memberJwt);
    let err: TRPCClientError<AppRouter> | undefined;
    try {
      await client.runs.setComment.mutate({
        runId: s.runId,
        comment: "x".repeat(10_001),
      });
    } catch (e) {
      err = e as TRPCClientError<AppRouter>;
    }
    expect(err).toBeDefined();
    expect(err?.data?.code).toBe("BAD_REQUEST");
  });

  test("setComment: 10,000 chars is accepted (boundary)", async () => {
    const client = makeClient(baseUrl, s.memberJwt);
    const payload = "x".repeat(10_000);
    const res = await client.runs.setComment.mutate({
      runId: s.runId,
      comment: payload,
    });
    expect(res.comment).toBe(payload);
  });

  test("setComment: unauthenticated client receives UNAUTHORIZED", async () => {
    const client = makeClient(baseUrl); // no jwt
    let err: TRPCClientError<AppRouter> | undefined;
    try {
      await client.runs.setComment.mutate({
        runId: s.runId,
        comment: "x",
      });
    } catch (e) {
      err = e as TRPCClientError<AppRouter>;
    }
    expect(err).toBeDefined();
    expect(err?.data?.code).toBe("UNAUTHORIZED");
  });

  test("setComment: non-member receives FORBIDDEN", async () => {
    const client = makeClient(baseUrl, s.nonMemberJwt);
    let err: TRPCClientError<AppRouter> | undefined;
    try {
      await client.runs.setComment.mutate({
        runId: s.runId,
        comment: "x",
      });
    } catch (e) {
      err = e as TRPCClientError<AppRouter>;
    }
    expect(err).toBeDefined();
    expect(err?.data?.code).toBe("FORBIDDEN");
  });

  test("setComment: unknown runId returns NOT_FOUND", async () => {
    const client = makeClient(baseUrl, s.memberJwt);
    let err: TRPCClientError<AppRouter> | undefined;
    try {
      await client.runs.setComment.mutate({
        runId: "00000000-0000-0000-0000-000000000000",
        comment: "x",
      });
    } catch (e) {
      err = e as TRPCClientError<AppRouter>;
    }
    expect(err).toBeDefined();
    expect(err?.data?.code).toBe("NOT_FOUND");
  });

  /**
   * Cross-cutting lifecycle e2e (Task 5 of furan-design/plans/
   * 2026-05-19-run-status-enum.md). Drives a single run through
   * SDK-creation → diff-worker-write → reviewer-approve and asserts each
   * stage emits the right status. The worker writes are simulated by
   * direct UPDATEs because the API test suite has no queue-draining
   * harness today (per plan §5.1 fallback), but every other hop —
   * Fastify route, tRPC mutation, baseline insert — runs through the
   * real wire path.
   *
   * If a future commit accidentally regresses any seam in this chain
   * (e.g. sdk-runs.ts starts writing "new" again, approve stops
   * inserting a baseline, override skips the recompute), this test
   * fails before the per-package suites do because it spans them.
   */
  describe("run lifecycle e2e", () => {
    test("POST /runs → unresolved → approve produces passed + baseline + merge=true", async () => {
      // Stage 1: SDK creates a run via the public REST surface. This is
      // what the Kotlin SDK does on its first checkpoint upload.
      const createRes = await h.app.inject({
        method: "POST",
        url: "/runs",
        headers: { authorization: `Bearer ${s.memberJwt}` },
        payload: {
          projectId: s.projectId,
          buildId: await getSeedBuildId(h, s.runId),
          branchName: "feature/lifecycle-e2e",
          name: "lifecycle-e2e",
          browser: "chromium",
          viewport: "1280x720",
        },
      });
      expect(createRes.statusCode).toBe(200);
      const created = JSON.parse(createRes.body) as {
        id: string;
        status: string;
      };
      // Per spec §3.2 SDK-creation writes 'running', not 'new'.
      expect(created.status).toBe("running");

      // Stage 2: diff-worker would now do its work. We simulate the
      // diff-found terminal write (spec §3.2: "unresolved" replaces the
      // legacy "failed" on diff-found). The real handler is integration-
      // tested in apps/diff-worker/tests/handler.test.ts.
      await h.db
        .update(testRuns)
        .set({ status: "unresolved" })
        .where(eq(testRuns.id, created.id));

      // Stage 3: reviewer approves via tRPC. This must (a) flip
      // status → passed, (b) set merge → true, and (c) insert a
      // baselines row attributing the promotion to the reviewer.
      const client = makeClient(baseUrl, s.memberJwt);
      const approveRes = await client.runs.approve.mutate({
        runId: created.id,
      });
      expect(approveRes).toEqual({ runId: created.id, approved: true });

      const finalRows = await h.db
        .select()
        .from(testRuns)
        .where(eq(testRuns.id, created.id))
        .limit(1);
      expect(finalRows[0]?.status).toBe("passed");
      expect(finalRows[0]?.merge).toBe(true);

      const baselineRows = await h.db
        .select()
        .from(baselines)
        .where(eq(baselines.testRunId, created.id));
      expect(baselineRows.length).toBe(1);
      expect(baselineRows[0]?.userId).toBe(s.memberId);
      expect(baselineRows[0]?.branchName).toBe("feature/lifecycle-e2e");
    });

    test("POST /runs → unresolved → overrideStatus(default) with no diffs collapses to passed", async () => {
      // Same SDK-creation hop as above, but the reviewer takes the
      // override-status path instead of approve. The diff-worker has
      // written 'unresolved' but the diff_regions table is empty
      // (e.g. all regions were below the severity threshold and
      // pruned); the recompute branch should resolve to 'passed'.
      const createRes = await h.app.inject({
        method: "POST",
        url: "/runs",
        headers: { authorization: `Bearer ${s.memberJwt}` },
        payload: {
          projectId: s.projectId,
          buildId: await getSeedBuildId(h, s.runId),
          branchName: "feature/lifecycle-e2e-override",
          name: "lifecycle-e2e-override",
          browser: "chromium",
          viewport: "1280x720",
        },
      });
      expect(createRes.statusCode).toBe(200);
      const created = JSON.parse(createRes.body) as {
        id: string;
        status: string;
      };
      expect(created.status).toBe("running");

      // Simulate diff-worker writing the diff-found terminal state.
      await h.db
        .update(testRuns)
        .set({ status: "unresolved" })
        .where(eq(testRuns.id, created.id));

      // No diff_regions inserted — the recompute branch sees zero rows.
      const client = makeClient(baseUrl, s.memberJwt);
      const overrideRes = await client.runs.overrideStatus.mutate({
        runId: created.id,
        status: "default",
      });
      expect(overrideRes.status).toBe("passed");

      const finalRows = await h.db
        .select()
        .from(testRuns)
        .where(eq(testRuns.id, created.id))
        .limit(1);
      // overrideStatus must NOT touch merge — that's approve/reject's job.
      expect(finalRows[0]?.status).toBe("passed");
      expect(finalRows[0]?.merge).toBe(false);
      // No baseline written by overrideStatus.
      const baselineRows = await h.db
        .select()
        .from(baselines)
        .where(eq(baselines.testRunId, created.id));
      expect(baselineRows.length).toBe(0);
    });

    test("POST /runs → first run with no baseline → diff-worker writes new + auto-creates baseline", async () => {
      // Stage 1: SDK creates the run; status is "running" at this point.
      const createRes = await h.app.inject({
        method: "POST",
        url: "/runs",
        headers: { authorization: `Bearer ${s.memberJwt}` },
        payload: {
          projectId: s.projectId,
          buildId: await getSeedBuildId(h, s.runId),
          branchName: "feat/lifecycle-first-run",
          name: "lifecycle-test-new",
          browser: "chromium",
          viewport: "1280x720",
        },
      });
      expect(createRes.statusCode).toBe(200);
      const created = JSON.parse(createRes.body) as {
        id: string;
        status: string;
        testVariationId: string;
        name: string | null;
      };
      expect(created.status).toBe("running");

      // Stage 2: simulate diff-worker discovering no baseline exists for
      // this (variation, branch, viewport):
      //   - writes status=new
      //   - sets merge=true
      //   - inserts a baselines row from this run with userId=NULL (auto)
      // The real handler is integration-tested in
      // apps/diff-worker/tests/handler.test.ts; here we just simulate the
      // terminal write (plan §5.1 fallback — no queue-draining harness yet).
      await h.db
        .update(testRuns)
        .set({ status: "new", merge: true })
        .where(eq(testRuns.id, created.id));
      await h.db.insert(baselines).values({
        baselineName: created.name ?? "auto",
        testVariationId: created.testVariationId,
        testRunId: created.id,
        userId: null,
        branchName: "feat/lifecycle-first-run",
      });

      // Verify the row landed in the new state.
      const rowAfter = (
        await h.db
          .select()
          .from(testRuns)
          .where(eq(testRuns.id, created.id))
          .limit(1)
      )[0];
      expect(rowAfter!.status).toBe("new");
      expect(rowAfter!.merge).toBe(true);

      const baselineRows = await h.db
        .select()
        .from(baselines)
        .where(eq(baselines.testRunId, created.id));
      expect(baselineRows).toHaveLength(1);
      expect(baselineRows[0]!.userId).toBeNull(); // auto-created, no reviewer
      expect(baselineRows[0]!.branchName).toBe("feat/lifecycle-first-run");
    });

    test("POST /runs → identical candidate → diff-worker writes passed, no baseline change", async () => {
      // Stage 1: SDK creates the run; status is "running".
      const createRes = await h.app.inject({
        method: "POST",
        url: "/runs",
        headers: { authorization: `Bearer ${s.memberJwt}` },
        payload: {
          projectId: s.projectId,
          buildId: await getSeedBuildId(h, s.runId),
          branchName: "feat/lifecycle-no-diff",
          name: "lifecycle-test-passed",
          browser: "chromium",
          viewport: "1280x720",
        },
      });
      expect(createRes.statusCode).toBe(200);
      const created = JSON.parse(createRes.body) as {
        id: string;
        status: string;
      };
      expect(created.status).toBe("running");

      // Stage 2: simulate diff-worker comparing against an existing
      // baseline and finding no diff:
      //   - writes status=passed
      //   - leaves merge untouched (no baseline promotion needed)
      //   - does NOT insert a baseline row
      // Real handler is integration-tested in
      // apps/diff-worker/tests/handler.test.ts.
      await h.db
        .update(testRuns)
        .set({ status: "passed" })
        .where(eq(testRuns.id, created.id));

      const rowAfter = (
        await h.db
          .select()
          .from(testRuns)
          .where(eq(testRuns.id, created.id))
          .limit(1)
      )[0];
      expect(rowAfter!.status).toBe("passed");
      expect(rowAfter!.merge).toBe(false); // unchanged from default

      const baselineRows = await h.db
        .select()
        .from(baselines)
        .where(eq(baselines.testRunId, created.id));
      expect(baselineRows).toHaveLength(0); // no new baseline
    });
  });

  test("getById: autoApproved is true when a baselines row has user_id NULL for the run", async () => {
    await h.db.insert(baselines).values({
      baselineName: "auto",
      testVariationId: s.variationId,
      testRunId: s.runId,
      branchName: "feature/x",
    });
    const client = makeClient(baseUrl, s.memberJwt);
    const data = await client.runs.getById.query({ runId: s.runId });
    expect(data.autoApproved).toBe(true);
  });

  test("getById: autoApproved is false when only manually-approved baselines exist", async () => {
    await h.db.insert(baselines).values({
      baselineName: "manual",
      testVariationId: s.variationId,
      testRunId: s.runId,
      userId: s.memberId,
      branchName: "feature/x",
    });
    const client = makeClient(baseUrl, s.memberJwt);
    const data = await client.runs.getById.query({ runId: s.runId });
    expect(data.autoApproved).toBe(false);
  });

  test("getById: autoApproved is false when no baselines exist for the run", async () => {
    const client = makeClient(baseUrl, s.memberJwt);
    const data = await client.runs.getById.query({ runId: s.runId });
    expect(data.autoApproved).toBe(false);
  });

  test("getById returns prevRunId + nextRunId for the same variation", async () => {
    // Seed: 1 variation, 3 runs in order (older → middle → newer).
    // The seed() helper already inserted one run (s.runId = middle candidate
    // here). We insert an older and a newer sibling on the same variation.
    const buildId = await getSeedBuildId(h, s.runId);

    // Insert older run — created_at must be strictly before s.runId's row.
    // We rely on DB-default now() ordering; to guarantee ordering we update
    // created_at explicitly after insert.
    const [olderRun] = await h.db
      .insert(testRuns)
      .values({
        buildId,
        projectId: s.projectId,
        testVariationId: s.variationId,
        status: "passed",
        name: "older-sibling",
      })
      .returning();
    await h.db
      .update(testRuns)
      .set({ createdAt: new Date("2000-01-01T00:00:00Z") })
      .where(eq(testRuns.id, olderRun!.id));

    // Update the seed run (middle) to a known mid-point timestamp.
    await h.db
      .update(testRuns)
      .set({ createdAt: new Date("2000-01-02T00:00:00Z") })
      .where(eq(testRuns.id, s.runId));

    // Insert newer run.
    const [newerRun] = await h.db
      .insert(testRuns)
      .values({
        buildId,
        projectId: s.projectId,
        testVariationId: s.variationId,
        status: "unresolved",
        name: "newer-sibling",
      })
      .returning();
    await h.db
      .update(testRuns)
      .set({ createdAt: new Date("2000-01-03T00:00:00Z") })
      .where(eq(testRuns.id, newerRun!.id));

    const client = makeClient(baseUrl, s.memberJwt);

    // Middle run → oldest as prev, newest as next.
    const middle = await client.runs.getById.query({ runId: s.runId });
    expect(middle.prevRunId).toBe(olderRun!.id);
    expect(middle.nextRunId).toBe(newerRun!.id);

    // Oldest run → no prev, middle as next.
    const older = await client.runs.getById.query({ runId: olderRun!.id });
    expect(older.prevRunId).toBeNull();
    expect(older.nextRunId).toBe(s.runId);

    // Newest run → middle as prev, no next.
    const newer = await client.runs.getById.query({ runId: newerRun!.id });
    expect(newer.prevRunId).toBe(s.runId);
    expect(newer.nextRunId).toBeNull();
  });

  // ADR-031: per-run ignore-regions editor + re-diff trigger.
  describe("setIgnoreAreas", () => {
    const VP = "1280x720";
    const validRegion = {
      x: 10,
      y: 20,
      width: 30,
      height: 40,
      viewport: VP,
      paddingPx: 0,
      kind: "ignore" as const,
    };

    beforeEach(() => {
      h.diffQueueAdd.mockClear();
    });

    test("scope=run writes to test_runs.ignore_areas and enqueues a diff job", async () => {
      const client = makeClient(baseUrl, s.memberJwt);
      const res = await client.runs.setIgnoreAreas.mutate({
        runId: s.runId,
        scope: "run",
        ignoreAreas: [validRegion],
      });
      expect(res).toEqual({
        runId: s.runId,
        scope: "run",
        ignoreAreas: [validRegion],
        requeued: true,
      });

      const [row] = await h.db
        .select()
        .from(testRuns)
        .where(eq(testRuns.id, s.runId))
        .limit(1);
      expect(row.ignoreAreas).toBe(JSON.stringify([validRegion]));

      const [vRow] = await h.db
        .select()
        .from(testVariations)
        .where(eq(testVariations.id, s.variationId))
        .limit(1);
      expect(vRow.ignoreAreas).toBeNull();

      expect(h.diffQueueAdd).toHaveBeenCalledTimes(1);
      expect(h.diffQueueAdd).toHaveBeenCalledWith("diff", {
        runId: s.runId,
        projectId: s.projectId,
      });
    });

    test("scope=variation writes to test_variations.ignore_areas and enqueues a diff job", async () => {
      const client = makeClient(baseUrl, s.memberJwt);
      const res = await client.runs.setIgnoreAreas.mutate({
        runId: s.runId,
        scope: "variation",
        ignoreAreas: [validRegion],
      });
      expect(res).toEqual({
        runId: s.runId,
        scope: "variation",
        ignoreAreas: [validRegion],
        requeued: true,
      });

      const [vRow] = await h.db
        .select()
        .from(testVariations)
        .where(eq(testVariations.id, s.variationId))
        .limit(1);
      expect(vRow.ignoreAreas).toBe(JSON.stringify([validRegion]));

      const [row] = await h.db
        .select()
        .from(testRuns)
        .where(eq(testRuns.id, s.runId))
        .limit(1);
      expect(row.ignoreAreas).toBeNull();

      expect(h.diffQueueAdd).toHaveBeenCalledTimes(1);
      expect(h.diffQueueAdd).toHaveBeenCalledWith("diff", {
        runId: s.runId,
        projectId: s.projectId,
      });
    });

    test("ignoreAreas: null clears the target column (scope=run)", async () => {
      const client = makeClient(baseUrl, s.memberJwt);
      await client.runs.setIgnoreAreas.mutate({
        runId: s.runId,
        scope: "run",
        ignoreAreas: [validRegion],
      });
      const res = await client.runs.setIgnoreAreas.mutate({
        runId: s.runId,
        scope: "run",
        ignoreAreas: null,
      });
      expect(res.ignoreAreas).toBeNull();

      const [row] = await h.db
        .select()
        .from(testRuns)
        .where(eq(testRuns.id, s.runId))
        .limit(1);
      expect(row.ignoreAreas).toBeNull();
    });

    test("ignoreAreas: null clears the target column (scope=variation)", async () => {
      const client = makeClient(baseUrl, s.memberJwt);
      await client.runs.setIgnoreAreas.mutate({
        runId: s.runId,
        scope: "variation",
        ignoreAreas: [validRegion],
      });
      const res = await client.runs.setIgnoreAreas.mutate({
        runId: s.runId,
        scope: "variation",
        ignoreAreas: null,
      });
      expect(res.ignoreAreas).toBeNull();

      const [vRow] = await h.db
        .select()
        .from(testVariations)
        .where(eq(testVariations.id, s.variationId))
        .limit(1);
      expect(vRow.ignoreAreas).toBeNull();
    });

    test("rejects > 50 regions", async () => {
      const client = makeClient(baseUrl, s.memberJwt);
      const tooMany = Array.from({ length: 51 }, (_, i) => ({
        ...validRegion,
        x: i,
      }));
      let err: TRPCClientError<AppRouter> | undefined;
      try {
        await client.runs.setIgnoreAreas.mutate({
          runId: s.runId,
          scope: "run",
          ignoreAreas: tooMany,
        });
      } catch (e) {
        err = e as TRPCClientError<AppRouter>;
      }
      expect(err?.data?.code).toBe("BAD_REQUEST");
      expect(h.diffQueueAdd).not.toHaveBeenCalled();
    });

    test("rejects region with negative coordinates", async () => {
      const client = makeClient(baseUrl, s.memberJwt);
      let err: TRPCClientError<AppRouter> | undefined;
      try {
        await client.runs.setIgnoreAreas.mutate({
          runId: s.runId,
          scope: "run",
          ignoreAreas: [{ ...validRegion, x: -1 }],
        });
      } catch (e) {
        err = e as TRPCClientError<AppRouter>;
      }
      expect(err?.data?.code).toBe("BAD_REQUEST");
    });

    test("rejects region with zero width/height", async () => {
      const client = makeClient(baseUrl, s.memberJwt);
      let err: TRPCClientError<AppRouter> | undefined;
      try {
        await client.runs.setIgnoreAreas.mutate({
          runId: s.runId,
          scope: "run",
          ignoreAreas: [{ ...validRegion, width: 0 }],
        });
      } catch (e) {
        err = e as TRPCClientError<AppRouter>;
      }
      expect(err?.data?.code).toBe("BAD_REQUEST");
    });

    test("rejects region missing viewport field", async () => {
      const client = makeClient(baseUrl, s.memberJwt);
      let err: TRPCClientError<AppRouter> | undefined;
      try {
        await client.runs.setIgnoreAreas.mutate({
          runId: s.runId,
          scope: "run",
          // @ts-expect-error — deliberately omitting viewport to test runtime validation
          ignoreAreas: [{ x: 1, y: 1, width: 10, height: 10 }],
        });
      } catch (e) {
        err = e as TRPCClientError<AppRouter>;
      }
      expect(err?.data?.code).toBe("BAD_REQUEST");
    });

    test("rejects invalid scope value", async () => {
      const client = makeClient(baseUrl, s.memberJwt);
      let err: TRPCClientError<AppRouter> | undefined;
      try {
        await client.runs.setIgnoreAreas.mutate({
          runId: s.runId,
          // @ts-expect-error — deliberately invalid scope
          scope: "project",
          ignoreAreas: [validRegion],
        });
      } catch (e) {
        err = e as TRPCClientError<AppRouter>;
      }
      expect(err?.data?.code).toBe("BAD_REQUEST");
    });

    test("unauthenticated client receives UNAUTHORIZED", async () => {
      const client = makeClient(baseUrl);
      let err: TRPCClientError<AppRouter> | undefined;
      try {
        await client.runs.setIgnoreAreas.mutate({
          runId: s.runId,
          scope: "run",
          ignoreAreas: [validRegion],
        });
      } catch (e) {
        err = e as TRPCClientError<AppRouter>;
      }
      expect(err?.data?.code).toBe("UNAUTHORIZED");
      expect(h.diffQueueAdd).not.toHaveBeenCalled();
    });

    test("non-member receives FORBIDDEN", async () => {
      const client = makeClient(baseUrl, s.nonMemberJwt);
      let err: TRPCClientError<AppRouter> | undefined;
      try {
        await client.runs.setIgnoreAreas.mutate({
          runId: s.runId,
          scope: "run",
          ignoreAreas: [validRegion],
        });
      } catch (e) {
        err = e as TRPCClientError<AppRouter>;
      }
      expect(err?.data?.code).toBe("FORBIDDEN");
      expect(h.diffQueueAdd).not.toHaveBeenCalled();
    });

    test("unknown runId returns NOT_FOUND or FORBIDDEN", async () => {
      const client = makeClient(baseUrl, s.memberJwt);
      let err: TRPCClientError<AppRouter> | undefined;
      try {
        await client.runs.setIgnoreAreas.mutate({
          runId: "00000000-0000-0000-0000-000000000000",
          scope: "run",
          ignoreAreas: [validRegion],
        });
      } catch (e) {
        err = e as TRPCClientError<AppRouter>;
      }
      // resolveRunProjectId returns null for unknown runId → projectMember
      // middleware rejects with NOT_FOUND. The test accepts FORBIDDEN as
      // well to be robust against future middleware refactors that might
      // pre-check authorization instead.
      expect(["FORBIDDEN", "NOT_FOUND"]).toContain(err?.data?.code);
      expect(h.diffQueueAdd).not.toHaveBeenCalled();
    });

    test("setIgnoreAreas accepts omitted paddingPx (defaults to 0)", async () => {
      const client = makeClient(baseUrl, s.memberJwt);
      await client.runs.setIgnoreAreas.mutate({
        runId: s.runId,
        scope: "run",
        ignoreAreas: [
          { x: 10, y: 10, width: 50, height: 50, viewport: "1280x720" },
        ],
      });
      const [row] = await h.db
        .select({ ignoreAreas: testRuns.ignoreAreas })
        .from(testRuns)
        .where(eq(testRuns.id, s.runId));
      const stored = JSON.parse(row!.ignoreAreas!) as Array<{
        paddingPx: number;
      }>;
      expect(stored[0]!.paddingPx).toBe(0);
    });

    test("setIgnoreAreas persists explicit paddingPx", async () => {
      const client = makeClient(baseUrl, s.memberJwt);
      await client.runs.setIgnoreAreas.mutate({
        runId: s.runId,
        scope: "run",
        ignoreAreas: [
          {
            x: 10,
            y: 10,
            width: 50,
            height: 50,
            viewport: "1280x720",
            paddingPx: 8,
          },
        ],
      });
      const [row] = await h.db
        .select({ ignoreAreas: testRuns.ignoreAreas })
        .from(testRuns)
        .where(eq(testRuns.id, s.runId));
      const stored = JSON.parse(row!.ignoreAreas!) as Array<{
        paddingPx: number;
      }>;
      expect(stored[0]!.paddingPx).toBe(8);
    });

    test("setIgnoreAreas rejects out-of-range paddingPx", async () => {
      const client = makeClient(baseUrl, s.memberJwt);
      await expect(
        client.runs.setIgnoreAreas.mutate({
          runId: s.runId,
          scope: "run",
          ignoreAreas: [
            {
              x: 10,
              y: 10,
              width: 50,
              height: 50,
              viewport: "1280x720",
              paddingPx: 33,
            },
          ],
        }),
      ).rejects.toThrow();
      await expect(
        client.runs.setIgnoreAreas.mutate({
          runId: s.runId,
          scope: "run",
          ignoreAreas: [
            {
              x: 10,
              y: 10,
              width: 50,
              height: 50,
              viewport: "1280x720",
              paddingPx: -1,
            },
          ],
        }),
      ).rejects.toThrow();
    });

    test("setIgnoreAreas accepts default kind=ignore without pattern", async () => {
      const client = makeClient(baseUrl, s.memberJwt);
      await client.runs.setIgnoreAreas.mutate({
        runId: s.runId,
        scope: "run",
        ignoreAreas: [
          { x: 10, y: 10, width: 50, height: 50, viewport: "1280x720" },
        ],
      });
      const [row] = await h.db
        .select({ ignoreAreas: testRuns.ignoreAreas })
        .from(testRuns)
        .where(eq(testRuns.id, s.runId));
      const stored = JSON.parse(row!.ignoreAreas!) as Array<{ kind: string }>;
      expect(stored[0]!.kind).toBe("ignore");
    });

    test("setIgnoreAreas accepts kind=dynamic-text with pattern", async () => {
      const client = makeClient(baseUrl, s.memberJwt);
      await client.runs.setIgnoreAreas.mutate({
        runId: s.runId,
        scope: "run",
        ignoreAreas: [
          {
            x: 10,
            y: 10,
            width: 50,
            height: 50,
            viewport: "1280x720",
            kind: "dynamic-text",
            pattern: "\\d{4}-\\d{2}-\\d{2}",
          },
        ],
      });
      const [row] = await h.db
        .select({ ignoreAreas: testRuns.ignoreAreas })
        .from(testRuns)
        .where(eq(testRuns.id, s.runId));
      const stored = JSON.parse(row!.ignoreAreas!) as Array<{
        kind: string;
        pattern: string;
      }>;
      expect(stored[0]!.kind).toBe("dynamic-text");
      expect(stored[0]!.pattern).toBe("\\d{4}-\\d{2}-\\d{2}");
    });

    test("setIgnoreAreas rejects kind=dynamic-text without pattern", async () => {
      const client = makeClient(baseUrl, s.memberJwt);
      await expect(
        client.runs.setIgnoreAreas.mutate({
          runId: s.runId,
          scope: "run",
          ignoreAreas: [
            {
              x: 10,
              y: 10,
              width: 50,
              height: 50,
              viewport: "1280x720",
              kind: "dynamic-text",
            },
          ],
        }),
      ).rejects.toThrow(/pattern is required/i);
    });

    test("setIgnoreAreas rejects unparseable regex pattern", async () => {
      const client = makeClient(baseUrl, s.memberJwt);
      await expect(
        client.runs.setIgnoreAreas.mutate({
          runId: s.runId,
          scope: "run",
          ignoreAreas: [
            {
              x: 10,
              y: 10,
              width: 50,
              height: 50,
              viewport: "1280x720",
              kind: "dynamic-text",
              pattern: "((",
            },
          ],
        }),
      ).rejects.toThrow(/Invalid regex/i);
    });

    test("setIgnoreAreas accepts + round-trips the optional selector field", async () => {
      const client = makeClient(baseUrl, s.memberJwt);
      const res = await client.runs.setIgnoreAreas.mutate({
        runId: s.runId,
        scope: "variation",
        ignoreAreas: [
          {
            x: 10,
            y: 20,
            width: 100,
            height: 50,
            viewport: VP,
            selector: "#login-button",
          },
        ],
      });
      expect(res.ignoreAreas).toBeDefined();
      expect(res.ignoreAreas?.[0]?.selector).toBe("#login-button");

      // Round-trip: the JSON column carries the field.
      const [variation] = await h.db
        .select({ ignoreAreas: testVariations.ignoreAreas })
        .from(testVariations)
        .where(eq(testVariations.id, s.variationId))
        .limit(1);
      const parsed = JSON.parse(variation!.ignoreAreas!) as Array<{
        selector?: string;
      }>;
      expect(parsed[0]!.selector).toBe("#login-button");
    });

    test("setIgnoreAreas accepts areas without a selector (back-compat)", async () => {
      const client = makeClient(baseUrl, s.memberJwt);
      const res = await client.runs.setIgnoreAreas.mutate({
        runId: s.runId,
        scope: "run",
        ignoreAreas: [
          {
            x: 10,
            y: 20,
            width: 100,
            height: 50,
            viewport: VP,
          },
        ],
      });
      expect(res.ignoreAreas).toBeDefined();
      expect(res.ignoreAreas?.[0]).not.toHaveProperty("selector");
    });
  });

  describe("addIgnoreAreas", () => {
    const VP = "1280x720";
    const r1 = {
      x: 1,
      y: 1,
      width: 10,
      height: 10,
      viewport: VP,
      paddingPx: 0,
      kind: "ignore" as const,
    };
    const r2 = {
      x: 100,
      y: 100,
      width: 20,
      height: 20,
      viewport: VP,
      paddingPx: 0,
      kind: "ignore" as const,
    };

    beforeEach(() => {
      h.diffQueueAdd.mockClear();
    });

    test("appends to empty list and enqueues a diff (scope=run)", async () => {
      const client = makeClient(baseUrl, s.memberJwt);
      const res = await client.runs.addIgnoreAreas.mutate({
        runId: s.runId,
        scope: "run",
        ignoreAreas: [r1],
      });
      expect(res).toMatchObject({
        runId: s.runId,
        scope: "run",
        added: 1,
        total: 1,
        requeued: true,
      });
      expect(res.ignoreAreas).toEqual([r1]);

      const [row] = await h.db
        .select()
        .from(testRuns)
        .where(eq(testRuns.id, s.runId))
        .limit(1);
      expect(row.ignoreAreas).toBe(JSON.stringify([r1]));

      expect(h.diffQueueAdd).toHaveBeenCalledTimes(1);
    });

    test("appends to a populated list without overwriting (scope=run)", async () => {
      const client = makeClient(baseUrl, s.memberJwt);
      // Seed with r1.
      await client.runs.setIgnoreAreas.mutate({
        runId: s.runId,
        scope: "run",
        ignoreAreas: [r1],
      });
      h.diffQueueAdd.mockClear();
      // Append r2 — should now have [r1, r2], not [r2].
      const res = await client.runs.addIgnoreAreas.mutate({
        runId: s.runId,
        scope: "run",
        ignoreAreas: [r2],
      });
      expect(res.added).toBe(1);
      expect(res.total).toBe(2);
      expect(res.ignoreAreas).toEqual([r1, r2]);

      const [row] = await h.db
        .select()
        .from(testRuns)
        .where(eq(testRuns.id, s.runId))
        .limit(1);
      const parsed = JSON.parse(row.ignoreAreas!) as unknown[];
      expect(parsed).toHaveLength(2);
      expect(parsed).toEqual([r1, r2]);
      expect(h.diffQueueAdd).toHaveBeenCalledTimes(1);
    });

    test("appends to variation scope (preserves existing variation areas)", async () => {
      const client = makeClient(baseUrl, s.memberJwt);
      await client.runs.setIgnoreAreas.mutate({
        runId: s.runId,
        scope: "variation",
        ignoreAreas: [r1],
      });
      h.diffQueueAdd.mockClear();
      const res = await client.runs.addIgnoreAreas.mutate({
        runId: s.runId,
        scope: "variation",
        ignoreAreas: [r2],
      });
      expect(res.total).toBe(2);

      const [vRow] = await h.db
        .select()
        .from(testVariations)
        .where(eq(testVariations.id, s.variationId))
        .limit(1);
      expect(JSON.parse(vRow.ignoreAreas!)).toEqual([r1, r2]);
    });

    test("rejects with BAD_REQUEST when combined total would exceed MAX_IGNORE_REGIONS (50)", async () => {
      const client = makeClient(baseUrl, s.memberJwt);
      // Seed with 49 regions.
      const seed = Array.from({ length: 49 }, (_, i) => ({
        x: i,
        y: i,
        width: 5,
        height: 5,
        viewport: VP,
        paddingPx: 0,
        kind: "ignore" as const,
      }));
      await client.runs.setIgnoreAreas.mutate({
        runId: s.runId,
        scope: "run",
        ignoreAreas: seed,
      });
      h.diffQueueAdd.mockClear();
      // Try to append 2 more (49 + 2 = 51 > 50).
      await expect(
        client.runs.addIgnoreAreas.mutate({
          runId: s.runId,
          scope: "run",
          ignoreAreas: [r1, r2],
        }),
      ).rejects.toThrow(/exceeds the per-scope cap/);
      expect(h.diffQueueAdd).not.toHaveBeenCalled();
    });

    test("empty array is a no-op append (does not error, still enqueues diff)", async () => {
      const client = makeClient(baseUrl, s.memberJwt);
      await client.runs.setIgnoreAreas.mutate({
        runId: s.runId,
        scope: "run",
        ignoreAreas: [r1],
      });
      h.diffQueueAdd.mockClear();
      const res = await client.runs.addIgnoreAreas.mutate({
        runId: s.runId,
        scope: "run",
        ignoreAreas: [],
      });
      expect(res.added).toBe(0);
      expect(res.total).toBe(1);
      expect(res.ignoreAreas).toEqual([r1]);
      // The write happens (which re-stamps updatedAt) and the diff is
      // re-enqueued — same semantics as setIgnoreAreas with the existing
      // payload, useful as a "kick the worker" affordance.
      expect(h.diffQueueAdd).toHaveBeenCalledTimes(1);
    });
  });

  describe("project-event broadcasts", () => {
    // Per the live-updates spec §7.3, every reviewer/SDK mutation that
    // mutates a test_run must fan out a project-channel event so the
    // dashboard list views can react in real time. The 67 surrounding
    // tests already cover the row-level effects; these assertions narrow
    // in on the wire shape so a future refactor can't silently drop the
    // broadcast.
    beforeEach(() => {
      h.broadcasterPublish.mockClear();
    });

    test("approve broadcasts testRun_updated + build_updated", async () => {
      const client = makeClient(baseUrl, s.memberJwt);
      const buildId = await getSeedBuildId(h, s.runId);
      await client.runs.approve.mutate({ runId: s.runId });
      expect(h.broadcasterPublish).toHaveBeenCalledWith(s.projectId, {
        event: "testRun_updated",
        data: { id: s.runId },
      });
      expect(h.broadcasterPublish).toHaveBeenCalledWith(s.projectId, {
        event: "build_updated",
        data: { id: buildId },
      });
    });

    test("reject broadcasts testRun_updated + build_updated", async () => {
      const client = makeClient(baseUrl, s.memberJwt);
      const buildId = await getSeedBuildId(h, s.runId);
      await client.runs.reject.mutate({ runId: s.runId });
      expect(h.broadcasterPublish).toHaveBeenCalledWith(s.projectId, {
        event: "testRun_updated",
        data: { id: s.runId },
      });
      expect(h.broadcasterPublish).toHaveBeenCalledWith(s.projectId, {
        event: "build_updated",
        data: { id: buildId },
      });
    });

    test("overrideStatus broadcasts testRun_updated + build_updated", async () => {
      const client = makeClient(baseUrl, s.memberJwt);
      const buildId = await getSeedBuildId(h, s.runId);
      await client.runs.overrideStatus.mutate({
        runId: s.runId,
        status: "passed",
      });
      expect(h.broadcasterPublish).toHaveBeenCalledWith(s.projectId, {
        event: "testRun_updated",
        data: { id: s.runId },
      });
      expect(h.broadcasterPublish).toHaveBeenCalledWith(s.projectId, {
        event: "build_updated",
        data: { id: buildId },
      });
    });

    test("setIgnoreAreas broadcasts testRun_updated (build update deferred to diff completion)", async () => {
      const client = makeClient(baseUrl, s.memberJwt);
      await client.runs.setIgnoreAreas.mutate({
        runId: s.runId,
        scope: "run",
        ignoreAreas: [
          { x: 0, y: 0, width: 10, height: 10, viewport: "1280x720" },
        ],
      });
      expect(h.broadcasterPublish).toHaveBeenCalledWith(s.projectId, {
        event: "testRun_updated",
        data: { id: s.runId },
      });
      // No build_updated — the diff worker fires it when the re-run lands.
      expect(h.broadcasterPublish).not.toHaveBeenCalledWith(
        s.projectId,
        expect.objectContaining({ event: "build_updated" }),
      );
    });

    test("addIgnoreAreas broadcasts testRun_updated", async () => {
      const client = makeClient(baseUrl, s.memberJwt);
      await client.runs.addIgnoreAreas.mutate({
        runId: s.runId,
        scope: "run",
        ignoreAreas: [
          { x: 0, y: 0, width: 10, height: 10, viewport: "1280x720" },
        ],
      });
      expect(h.broadcasterPublish).toHaveBeenCalledWith(s.projectId, {
        event: "testRun_updated",
        data: { id: s.runId },
      });
    });

    test("setDiffThresholdOverride broadcasts testRun_updated", async () => {
      const client = makeClient(baseUrl, s.memberJwt);
      await client.runs.setDiffThresholdOverride.mutate({
        runId: s.runId,
        threshold: 0.05,
      });
      expect(h.broadcasterPublish).toHaveBeenCalledWith(s.projectId, {
        event: "testRun_updated",
        data: { id: s.runId },
      });
    });

    test("bulkApproveByVariation fans out one testRun_updated per approved run + one build_updated per build", async () => {
      // Seed two sibling runs on the same variation so bulk-approve has
      // something to fan out over (beyond the seed run).
      const buildId = await getSeedBuildId(h, s.runId);
      const [sib1] = await h.db
        .insert(testRuns)
        .values({
          buildId,
          projectId: s.projectId,
          testVariationId: s.variationId,
          status: "unresolved",
          name: "sib1",
        })
        .returning();
      const [sib2] = await h.db
        .insert(testRuns)
        .values({
          buildId,
          projectId: s.projectId,
          testVariationId: s.variationId,
          status: "unresolved",
          name: "sib2",
        })
        .returning();

      h.broadcasterPublish.mockClear();
      const client = makeClient(baseUrl, s.memberJwt);
      const res = await client.runs.bulkApproveByVariation.mutate({
        runId: s.runId,
      });
      expect(res.approved).toBe(3);

      // 3 testRun_updated + 1 build_updated (all three siblings share the
      // same build, so the dedupe collapses to one).
      const testRunCalls = h.broadcasterPublish.mock.calls.filter(
        ([, ev]) => (ev as { event: string }).event === "testRun_updated",
      );
      const buildCalls = h.broadcasterPublish.mock.calls.filter(
        ([, ev]) => (ev as { event: string }).event === "build_updated",
      );
      expect(testRunCalls).toHaveLength(3);
      expect(buildCalls).toHaveLength(1);
      expect(buildCalls[0]?.[1]).toEqual({
        event: "build_updated",
        data: { id: buildId },
      });
      const broadcastRunIds = new Set(
        testRunCalls.map(([, ev]) => (ev as { data: { id: string } }).data.id),
      );
      expect(broadcastRunIds).toEqual(new Set([s.runId, sib1!.id, sib2!.id]));
    });
  });
});
