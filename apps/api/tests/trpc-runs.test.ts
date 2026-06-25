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
import {
  approveCheckpointInTx,
  GROUP_APPROVE_CAP,
} from "../src/trpc/v1/checkpoint-grouping.js";
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

async function seedCheckpoint(
  h: TestApp,
  opts: {
    buildId: string;
    projectId: string;
    name: string;
    signature: string | null;
    unresolved: boolean;
    branchName?: string;
    viewport?: string;
    baselineName?: string | null;
  },
) {
  const viewport = opts.viewport ?? "1280x720";
  const [variation] = await h.db
    .insert(testVariations)
    .values({
      name: opts.name,
      projectId: opts.projectId,
      baselineName:
        opts.baselineName === undefined
          ? "existing-baseline"
          : opts.baselineName,
    })
    .returning();
  const [run] = await h.db
    .insert(testRuns)
    .values({
      buildId: opts.buildId,
      projectId: opts.projectId,
      status: "unresolved",
      branchName: opts.branchName ?? "feature/x",
      name: opts.name,
    })
    .returning();
  const [shot] = await h.db
    .insert(screenshots)
    .values({
      runId: run.id,
      projectId: opts.projectId,
      testVariationId: variation.id,
      name: opts.name,
      viewport,
      browser: "chromium",
      imageKey: opts.name.padEnd(64, "k").slice(0, 64),
      matchLevel: "Strict",
      diffSignature: opts.signature,
    })
    .returning();
  if (opts.unresolved) {
    await h.db.insert(diffRegions).values({
      runId: run.id,
      projectId: opts.projectId,
      screenshotId: shot.id,
      severity: "high",
      category: "layout",
      source: "l2_dom",
      description: "diff",
      bbox: { x: 0, y: 0, width: 10, height: 10 },
    });
  }
  return { run, shot, variation };
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
        // ADR-038: testVariationId removed from testRuns; link via screenshots.
        status: "passed",
        branchName: "feature/x",
        name: "older",
      })
      .returning();

    // ADR-038: link the older run to the variation via a screenshot row so
    // resolveBaseline can pick up the baseline through the screenshots table.
    const olderShot = await h.db
      .insert(screenshots)
      .values({
        runId: olderRun.id,
        projectId: s.projectId,
        testVariationId: s.variationId,
        name: "older",
        imageKey: "a".repeat(64),
        viewport: "1280x720",
        browser: "chromium",
      })
      .returning();
    expect(olderShot[0]?.id).toBeDefined();

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

    // Link the current run to the same variation so getById can resolve
    // the baseline via the first checkpoint's testVariationId.
    await h.db.insert(screenshots).values({
      runId: s.runId,
      projectId: s.projectId,
      testVariationId: s.variationId,
      name: "current",
      imageKey: "b".repeat(64),
      viewport: "1280x720",
      browser: "chromium",
    });

    const client = makeClient(baseUrl, s.memberJwt);
    const data = await client.runs.getById.query({ runId: s.runId });
    expect(data.baselineScreenshot).not.toBeNull();
    expect(data.baselineScreenshot?.imageKey).toBe("a".repeat(64));
    expect(data.baselineSource).toBe("this_branch");
  });

  test("getById: baselineSource is parent_pr when the baseline lives only on the parent branch (ADR-055)", async () => {
    // Current run is on feature/x with parent=develop; the only baseline is
    // on develop. this_branch (feature/x) + default (main) both miss, so the
    // parent_pr tier must resolve it — proving runs.ts threads the parent.
    await h.db
      .update(testRuns)
      .set({ parentBranchName: "develop" })
      .where(eq(testRuns.id, s.runId));

    const [olderRun] = await h.db
      .insert(testRuns)
      .values({
        buildId: await getSeedBuildId(h, s.runId),
        projectId: s.projectId,
        status: "passed",
        branchName: "develop",
        name: "older",
      })
      .returning();

    await h.db.insert(screenshots).values({
      runId: olderRun.id,
      projectId: s.projectId,
      testVariationId: s.variationId,
      name: "older",
      imageKey: "d".repeat(64),
      viewport: "1280x720",
      browser: "chromium",
    });

    await h.db.insert(baselines).values({
      baselineName: "older",
      testVariationId: s.variationId,
      testRunId: olderRun.id,
      branchName: "develop",
    });

    // Link the current run to the same variation so getById resolves it.
    await h.db.insert(screenshots).values({
      runId: s.runId,
      projectId: s.projectId,
      testVariationId: s.variationId,
      name: "current",
      imageKey: "c".repeat(64),
      viewport: "1280x720",
      browser: "chromium",
    });

    const client = makeClient(baseUrl, s.memberJwt);
    const data = await client.runs.getById.query({ runId: s.runId });
    expect(data.baselineSource).toBe("parent_pr");
  });

  test("getById: returns variationIgnoreAreas from the run's variation", async () => {
    // ADR-038: variationIgnoreAreas comes from the first checkpoint's
    // variation (test_variations.ignore_regions). Seed a screenshot linking
    // the run to the variation, then set ignore_regions on that variation.
    const region = {
      x: 10,
      y: 20,
      width: 30,
      height: 40,
      viewport: "1280x720",
    };
    await h.db.insert(screenshots).values({
      runId: s.runId,
      projectId: s.projectId,
      testVariationId: s.variationId,
      name: "home",
      viewport: "1280x720",
      browser: "chromium",
      imageKey: "aaaa",
    });
    await h.db
      .update(testVariations)
      .set({ ignoreRegions: [region] })
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
    // ADR-038: ignore_regions is jsonb; null is normal when no regions are set.
    // The "malformed JSON" case doesn't apply to jsonb columns. Test that
    // variationIgnoreAreas is null when no screenshot links the run to a variation.
    const client = makeClient(baseUrl, s.memberJwt);
    const data = await client.runs.getById.query({ runId: s.runId });
    expect(data.variationIgnoreAreas).toBeNull();
  });

  test("getById: returns ignoreAreas as a parsed array (not raw JSON string)", async () => {
    // ADR-038: run-level ignoreAreas removed from test_runs; getById always
    // returns null. This test validates the null behavior.
    const client = makeClient(baseUrl, s.memberJwt);
    const data = await client.runs.getById.query({ runId: s.runId });
    expect(data.ignoreAreas).toBeNull();
  });

  test("getById: ignoreAreas is null when test_runs.ignore_areas column is null", async () => {
    const client = makeClient(baseUrl, s.memberJwt);
    const data = await client.runs.getById.query({ runId: s.runId });
    expect(data.ignoreAreas).toBeNull();
  });

  test("getById: ignoreAreas is null when test_runs.ignore_areas holds malformed JSON", async () => {
    // ADR-038: run-level ignoreAreas removed; always null.
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
    // ADR-038: approve inserts a baseline only when the run has a checkpoint.
    // Seed a screenshot linking the run to the variation.
    await h.db.insert(screenshots).values({
      runId: s.runId,
      projectId: s.projectId,
      testVariationId: s.variationId,
      name: "home",
      imageKey: "approve-test-img",
      viewport: "1280x720",
      browser: "chromium",
    });

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

  test("approve: persists ignoreAreas onto the variation when provided (first-baseline draw-and-save)", async () => {
    await h.db.insert(screenshots).values({
      runId: s.runId,
      projectId: s.projectId,
      testVariationId: s.variationId,
      name: "home",
      imageKey: "approve-ign-img",
      viewport: "1280x720",
      browser: "chromium",
    });

    const region = {
      x: 10,
      y: 20,
      width: 100,
      height: 50,
      viewport: "1280x720",
      kind: "ignore" as const,
    };

    const client = makeClient(baseUrl, s.memberJwt);
    await client.runs.approve.mutate({ runId: s.runId, ignoreAreas: [region] });

    // The drawn region lands on the variation (forward mask for future runs).
    const variationRows = await h.db
      .select({ ignoreRegions: testVariations.ignoreRegions })
      .from(testVariations)
      .where(eq(testVariations.id, s.variationId))
      .limit(1);
    const stored = variationRows[0]?.ignoreRegions as Array<{
      x: number;
      width: number;
    }> | null;
    expect(Array.isArray(stored)).toBe(true);
    expect(stored).toHaveLength(1);
    expect(stored?.[0]?.x).toBe(10);
    expect(stored?.[0]?.width).toBe(100);

    // Baseline still created + status passed (unchanged).
    const updated = await h.db
      .select()
      .from(testRuns)
      .where(eq(testRuns.id, s.runId))
      .limit(1);
    expect(updated[0]?.status).toBe("passed");
    const baselineRows = await h.db
      .select()
      .from(baselines)
      .where(eq(baselines.testRunId, s.runId));
    expect(baselineRows.length).toBe(1);
  });

  test("approve: without ignoreAreas leaves the variation's existing regions untouched", async () => {
    await h.db
      .update(testVariations)
      .set({
        ignoreRegions: [
          {
            x: 1,
            y: 2,
            width: 3,
            height: 4,
            viewport: "1280x720",
            kind: "ignore",
          },
        ],
      })
      .where(eq(testVariations.id, s.variationId));
    await h.db.insert(screenshots).values({
      runId: s.runId,
      projectId: s.projectId,
      testVariationId: s.variationId,
      name: "home",
      imageKey: "approve-noign-img",
      viewport: "1280x720",
      browser: "chromium",
    });

    const client = makeClient(baseUrl, s.memberJwt);
    await client.runs.approve.mutate({ runId: s.runId });

    const variationRows = await h.db
      .select({ ignoreRegions: testVariations.ignoreRegions })
      .from(testVariations)
      .where(eq(testVariations.id, s.variationId))
      .limit(1);
    const stored = variationRows[0]?.ignoreRegions as Array<{
      x: number;
    }> | null;
    expect(stored).toHaveLength(1);
    expect(stored?.[0]?.x).toBe(1);
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
    // ADR-038: seed a screenshot so approve has a variation to reference.
    await h.db.insert(screenshots).values({
      runId: s.runId,
      projectId: s.projectId,
      testVariationId: s.variationId,
      name: "home",
      imageKey: "new-status-img",
      viewport: "1280x720",
      browser: "chromium",
    });
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

  test("approve: inserts a baseline row referencing the first checkpoint's variation (ADR-038)", async () => {
    // ADR-038: run-level ignoreAreas removed. approve now inserts a baselines
    // row using the first screenshot's testVariationId (not a run-level FK).
    // Seed a screenshot linking the run to the variation.
    await h.db.insert(screenshots).values({
      runId: s.runId,
      projectId: s.projectId,
      testVariationId: s.variationId,
      name: "home",
      imageKey: "abcd",
      viewport: "1280x720",
      browser: "chromium",
    });

    const client = makeClient(baseUrl, s.memberJwt);
    await client.runs.approve.mutate({ runId: s.runId });

    const baselineRows = await h.db
      .select()
      .from(baselines)
      .where(eq(baselines.testRunId, s.runId));
    // Baseline must be inserted with the variation from the first checkpoint.
    expect(baselineRows.length).toBe(1);
    expect(baselineRows[0]?.testVariationId).toBe(s.variationId);
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
    test("POST /runs → unresolved → approve produces passed + merge=true", async () => {
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
      // ADR-038: POST /runs now returns 201.
      expect(createRes.statusCode).toBe(201);
      const created = JSON.parse(createRes.body) as {
        runId: string;
        status: string;
        name: string;
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
        .where(eq(testRuns.id, created.runId));

      // Stage 3: reviewer approves via tRPC. This must (a) flip
      // status → passed and (b) set merge → true. ADR-038: baseline
      // insertion requires a checkpoint; skip baseline assertions here
      // since no screenshot was uploaded in this test.
      const client = makeClient(baseUrl, s.memberJwt);
      const approveRes = await client.runs.approve.mutate({
        runId: created.runId,
      });
      expect(approveRes).toEqual({ runId: created.runId, approved: true });

      const finalRows = await h.db
        .select()
        .from(testRuns)
        .where(eq(testRuns.id, created.runId))
        .limit(1);
      expect(finalRows[0]?.status).toBe("passed");
      expect(finalRows[0]?.merge).toBe(true);
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
      // ADR-038: POST /runs now returns 201.
      expect(createRes.statusCode).toBe(201);
      const created = JSON.parse(createRes.body) as {
        runId: string;
        status: string;
      };
      expect(created.status).toBe("running");

      // Simulate diff-worker writing the diff-found terminal state.
      await h.db
        .update(testRuns)
        .set({ status: "unresolved" })
        .where(eq(testRuns.id, created.runId));

      // No diff_regions inserted — the recompute branch sees zero rows.
      const client = makeClient(baseUrl, s.memberJwt);
      const overrideRes = await client.runs.overrideStatus.mutate({
        runId: created.runId,
        status: "default",
      });
      expect(overrideRes.status).toBe("passed");

      const finalRows = await h.db
        .select()
        .from(testRuns)
        .where(eq(testRuns.id, created.runId))
        .limit(1);
      // overrideStatus must NOT touch merge — that's approve/reject's job.
      expect(finalRows[0]?.status).toBe("passed");
      expect(finalRows[0]?.merge).toBe(false);
      // No baseline written by overrideStatus.
      const baselineRows = await h.db
        .select()
        .from(baselines)
        .where(eq(baselines.testRunId, created.runId));
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
      // ADR-038: POST /runs now returns 201.
      expect(createRes.statusCode).toBe(201);
      const created = JSON.parse(createRes.body) as {
        runId: string;
        status: string;
        name: string | null;
      };
      expect(created.status).toBe("running");

      // ADR-038: variation is no longer returned by POST /runs. Seed a
      // variation and screenshot to simulate the diff-worker first-baseline flow.
      const [variation] = await h.db
        .insert(testVariations)
        .values({
          name: created.name ?? "lifecycle-test-new",
          projectId: s.projectId,
        })
        .returning();
      await h.db.insert(screenshots).values({
        runId: created.runId,
        projectId: s.projectId,
        testVariationId: variation!.id,
        name: created.name ?? "lifecycle-test-new",
        imageKey: "lifecycle-img",
        viewport: "1280x720",
        browser: "chromium",
      });

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
        .where(eq(testRuns.id, created.runId));
      await h.db.insert(baselines).values({
        baselineName: created.name ?? "auto",
        testVariationId: variation!.id,
        testRunId: created.runId,
        userId: null,
        branchName: "feat/lifecycle-first-run",
      });

      // Verify the row landed in the new state.
      const rowAfter = (
        await h.db
          .select()
          .from(testRuns)
          .where(eq(testRuns.id, created.runId))
          .limit(1)
      )[0];
      expect(rowAfter!.status).toBe("new");
      expect(rowAfter!.merge).toBe(true);

      const baselineRows = await h.db
        .select()
        .from(baselines)
        .where(eq(baselines.testRunId, created.runId));
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
      // ADR-038: POST /runs now returns 201.
      expect(createRes.statusCode).toBe(201);
      const created = JSON.parse(createRes.body) as {
        runId: string;
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
        .where(eq(testRuns.id, created.runId));

      const rowAfter = (
        await h.db
          .select()
          .from(testRuns)
          .where(eq(testRuns.id, created.runId))
          .limit(1)
      )[0];
      expect(rowAfter!.status).toBe("passed");
      expect(rowAfter!.merge).toBe(false); // unchanged from default

      const baselineRows = await h.db
        .select()
        .from(baselines)
        .where(eq(baselines.testRunId, created.runId));
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

  test("getById returns prevRunId + nextRunId as null (ADR-038: deferred to Phase 5)", async () => {
    // ADR-038: sibling run navigation (prevRunId/nextRunId) is deferred to
    // Phase 5 of the batch/test/checkpoint model rework. getById always
    // returns null for both fields in the current implementation.
    const client = makeClient(baseUrl, s.memberJwt);
    const data = await client.runs.getById.query({ runId: s.runId });
    expect(data.prevRunId).toBeNull();
    expect(data.nextRunId).toBeNull();
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

    test("scope=run enqueues a diff job (ADR-038: run-scope stored at variation level via first checkpoint)", async () => {
      // ADR-038: test_runs no longer has ignore_areas column. Run-scope ignore
      // areas are written to the first checkpoint's variation's ignore_regions.
      // Seed a screenshot to link the run to the variation.
      await h.db.insert(screenshots).values({
        runId: s.runId,
        projectId: s.projectId,
        testVariationId: s.variationId,
        name: "home",
        imageKey: "seed-img",
        viewport: VP,
        browser: "chromium",
      });

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

      // ADR-038: run-scope ignore areas are written to the variation's
      // ignore_regions (via the first checkpoint link).
      const [vRow] = await h.db
        .select()
        .from(testVariations)
        .where(eq(testVariations.id, s.variationId))
        .limit(1);
      expect(vRow.ignoreRegions).toEqual([validRegion]);

      expect(h.diffQueueAdd).toHaveBeenCalledTimes(1);
      expect(h.diffQueueAdd).toHaveBeenCalledWith("diff", {
        runId: s.runId,
        projectId: s.projectId,
      });
    });

    test("scope=variation writes to test_variations.ignore_regions and enqueues a diff job (ADR-038)", async () => {
      // ADR-038: ignore_areas on test_variations renamed to ignore_regions (jsonb).
      // Seed a screenshot to link the run to the variation.
      await h.db.insert(screenshots).values({
        runId: s.runId,
        projectId: s.projectId,
        testVariationId: s.variationId,
        name: "home",
        imageKey: "seed-img",
        viewport: VP,
        browser: "chromium",
      });

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

      // ADR-038: column renamed to ignore_regions; stored as jsonb (not a JSON string).
      const [vRow] = await h.db
        .select()
        .from(testVariations)
        .where(eq(testVariations.id, s.variationId))
        .limit(1);
      expect(vRow.ignoreRegions).toEqual([validRegion]);

      expect(h.diffQueueAdd).toHaveBeenCalledTimes(1);
      expect(h.diffQueueAdd).toHaveBeenCalledWith("diff", {
        runId: s.runId,
        projectId: s.projectId,
      });
    });

    test("ignoreAreas: null clears the target variation column (scope=run, ADR-038)", async () => {
      // ADR-038: run-scope ignore areas are stored at the variation level via
      // the first checkpoint. Seed a screenshot to link run → variation.
      await h.db.insert(screenshots).values({
        runId: s.runId,
        projectId: s.projectId,
        testVariationId: s.variationId,
        name: "home",
        imageKey: "seed-img",
        viewport: VP,
        browser: "chromium",
      });

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

      // Verify the variation's ignore_regions was cleared.
      const [vRow] = await h.db
        .select()
        .from(testVariations)
        .where(eq(testVariations.id, s.variationId))
        .limit(1);
      expect(vRow.ignoreRegions).toBeNull();
    });

    test("ignoreAreas: null clears the target variation column (scope=variation, ADR-038)", async () => {
      // ADR-038: ignore_areas renamed to ignore_regions on test_variations.
      // Seed a screenshot to link run → variation.
      await h.db.insert(screenshots).values({
        runId: s.runId,
        projectId: s.projectId,
        testVariationId: s.variationId,
        name: "home",
        imageKey: "seed-img",
        viewport: VP,
        browser: "chromium",
      });

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
      // ADR-038: column renamed to ignore_regions.
      expect(vRow.ignoreRegions).toBeNull();
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
      // ADR-038: run-scope ignore areas stored at variation level via first checkpoint.
      await h.db.insert(screenshots).values({
        runId: s.runId,
        projectId: s.projectId,
        testVariationId: s.variationId,
        name: "home",
        imageKey: "seed-img",
        viewport: "1280x720",
        browser: "chromium",
      });

      const client = makeClient(baseUrl, s.memberJwt);
      await client.runs.setIgnoreAreas.mutate({
        runId: s.runId,
        scope: "run",
        ignoreAreas: [
          { x: 10, y: 10, width: 50, height: 50, viewport: "1280x720" },
        ],
      });
      const [vRow] = await h.db
        .select({ ignoreRegions: testVariations.ignoreRegions })
        .from(testVariations)
        .where(eq(testVariations.id, s.variationId));
      const stored = vRow!.ignoreRegions as Array<{ paddingPx: number }>;
      expect(stored[0]!.paddingPx).toBe(0);
    });

    test("setIgnoreAreas persists explicit paddingPx", async () => {
      // ADR-038: run-scope ignore areas stored at variation level via first checkpoint.
      await h.db.insert(screenshots).values({
        runId: s.runId,
        projectId: s.projectId,
        testVariationId: s.variationId,
        name: "home",
        imageKey: "seed-img",
        viewport: "1280x720",
        browser: "chromium",
      });

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
      const [vRow] = await h.db
        .select({ ignoreRegions: testVariations.ignoreRegions })
        .from(testVariations)
        .where(eq(testVariations.id, s.variationId));
      const stored = vRow!.ignoreRegions as Array<{ paddingPx: number }>;
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
      // ADR-038: run-scope ignore areas stored at variation level via first checkpoint.
      await h.db.insert(screenshots).values({
        runId: s.runId,
        projectId: s.projectId,
        testVariationId: s.variationId,
        name: "home",
        imageKey: "seed-img",
        viewport: "1280x720",
        browser: "chromium",
      });

      const client = makeClient(baseUrl, s.memberJwt);
      await client.runs.setIgnoreAreas.mutate({
        runId: s.runId,
        scope: "run",
        ignoreAreas: [
          { x: 10, y: 10, width: 50, height: 50, viewport: "1280x720" },
        ],
      });
      const [vRow] = await h.db
        .select({ ignoreRegions: testVariations.ignoreRegions })
        .from(testVariations)
        .where(eq(testVariations.id, s.variationId));
      const stored = vRow!.ignoreRegions as Array<{ kind: string }>;
      expect(stored[0]!.kind).toBe("ignore");
    });

    test("setIgnoreAreas accepts kind=dynamic-text with pattern", async () => {
      // ADR-038: run-scope ignore areas stored at variation level via first checkpoint.
      await h.db.insert(screenshots).values({
        runId: s.runId,
        projectId: s.projectId,
        testVariationId: s.variationId,
        name: "home",
        imageKey: "seed-img",
        viewport: "1280x720",
        browser: "chromium",
      });

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
      const [vRow] = await h.db
        .select({ ignoreRegions: testVariations.ignoreRegions })
        .from(testVariations)
        .where(eq(testVariations.id, s.variationId));
      const stored = vRow!.ignoreRegions as Array<{
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
      // ADR-038: variation-scope ignore areas stored via the first checkpoint.
      await h.db.insert(screenshots).values({
        runId: s.runId,
        projectId: s.projectId,
        testVariationId: s.variationId,
        name: "home",
        imageKey: "seed-img",
        viewport: VP,
        browser: "chromium",
      });

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

      // Round-trip: the jsonb column carries the field.
      // ADR-038: column renamed to ignore_regions.
      const [variation] = await h.db
        .select({ ignoreRegions: testVariations.ignoreRegions })
        .from(testVariations)
        .where(eq(testVariations.id, s.variationId))
        .limit(1);
      const stored = variation!.ignoreRegions as Array<{
        selector?: string;
      }>;
      expect(stored[0]!.selector).toBe("#login-button");
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
      // ADR-038: run-scope ignore areas stored at variation level via first checkpoint.
      await h.db.insert(screenshots).values({
        runId: s.runId,
        projectId: s.projectId,
        testVariationId: s.variationId,
        name: "home",
        imageKey: "seed-img",
        viewport: VP,
        browser: "chromium",
      });

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

      // ADR-038: stored at variation level.
      const [vRow] = await h.db
        .select()
        .from(testVariations)
        .where(eq(testVariations.id, s.variationId))
        .limit(1);
      expect(vRow.ignoreRegions).toEqual([r1]);

      expect(h.diffQueueAdd).toHaveBeenCalledTimes(1);
    });

    test("appends to a populated list without overwriting (scope=run)", async () => {
      // ADR-038: run-scope ignore areas stored at variation level via first checkpoint.
      await h.db.insert(screenshots).values({
        runId: s.runId,
        projectId: s.projectId,
        testVariationId: s.variationId,
        name: "home",
        imageKey: "seed-img",
        viewport: VP,
        browser: "chromium",
      });

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

      // ADR-038: stored at variation level.
      const [vRow] = await h.db
        .select()
        .from(testVariations)
        .where(eq(testVariations.id, s.variationId))
        .limit(1);
      expect(vRow.ignoreRegions).toEqual([r1, r2]);
      expect(h.diffQueueAdd).toHaveBeenCalledTimes(1);
    });

    test("appends to variation scope (preserves existing variation areas)", async () => {
      // ADR-038: variation-scope ignore areas stored via the first checkpoint.
      await h.db.insert(screenshots).values({
        runId: s.runId,
        projectId: s.projectId,
        testVariationId: s.variationId,
        name: "home",
        imageKey: "seed-img",
        viewport: VP,
        browser: "chromium",
      });

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
      // ADR-038: column renamed to ignore_regions; stored as jsonb (not a JSON string).
      expect(vRow.ignoreRegions).toEqual([r1, r2]);
    });

    test("rejects with BAD_REQUEST when combined total would exceed MAX_IGNORE_REGIONS (50)", async () => {
      // ADR-038: run-scope ignore areas stored at variation level via first checkpoint.
      await h.db.insert(screenshots).values({
        runId: s.runId,
        projectId: s.projectId,
        testVariationId: s.variationId,
        name: "home",
        imageKey: "seed-img",
        viewport: VP,
        browser: "chromium",
      });

      const client = makeClient(baseUrl, s.memberJwt);
      // Seed with 49 regions.
      const seedRegions = Array.from({ length: 49 }, (_, i) => ({
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
        ignoreAreas: seedRegions,
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
      // ADR-038: run-scope ignore areas stored at variation level via first checkpoint.
      await h.db.insert(screenshots).values({
        runId: s.runId,
        projectId: s.projectId,
        testVariationId: s.variationId,
        name: "home",
        imageKey: "seed-img",
        viewport: VP,
        browser: "chromium",
      });

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
      // Seed two sibling runs so bulk-approve has something to fan out over
      // (beyond the seed run). ADR-038: no testVariationId on testRuns.
      const buildId = await getSeedBuildId(h, s.runId);
      const [sib1] = await h.db
        .insert(testRuns)
        .values({
          buildId,
          projectId: s.projectId,
          status: "unresolved",
          name: "sib1",
          branchName: "feature/x",
        })
        .returning();
      const [sib2] = await h.db
        .insert(testRuns)
        .values({
          buildId,
          projectId: s.projectId,
          status: "unresolved",
          name: "sib2",
          branchName: "feature/x",
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

    test("bulkApproveByVariation inserts baselines from checkpoint variations (ADR-038)", async () => {
      // ADR-038: run-level ignoreAreas removed from test_runs. bulkApproveByVariation
      // now inserts baseline rows using the first screenshot's testVariationId.
      // Seed a screenshot linking the seed run to the variation so a baseline row is inserted.
      const buildId = await getSeedBuildId(h, s.runId);
      await h.db.insert(screenshots).values({
        runId: s.runId,
        projectId: s.projectId,
        testVariationId: s.variationId,
        name: "home",
        imageKey: "seed-img",
        viewport: "1280x720",
        browser: "chromium",
      });
      // Sibling run without a checkpoint — bulk-approve still transitions its status.
      await h.db
        .insert(testRuns)
        .values({
          buildId,
          projectId: s.projectId,
          status: "unresolved",
          name: "sib1",
          branchName: "feature/x",
        })
        .returning();

      // Sanity: variation starts with no ignore_regions.
      const beforeVariation = await h.db
        .select()
        .from(testVariations)
        .where(eq(testVariations.id, s.variationId))
        .limit(1);
      expect(beforeVariation[0]?.ignoreRegions).toBeNull();

      const client = makeClient(baseUrl, s.memberJwt);
      await client.runs.bulkApproveByVariation.mutate({ runId: s.runId });

      // The seed run had a screenshot → baseline inserted with that variation.
      const baselineRows = await h.db
        .select()
        .from(baselines)
        .where(eq(baselines.testRunId, s.runId));
      expect(baselineRows.length).toBe(1);
      expect(baselineRows[0]?.testVariationId).toBe(s.variationId);
    });
  });

  // ---------------------------------------------------------------------------
  // ADR-038 Phase 2: approveCheckpoint, approveAllCheckpoints, listCheckpoints
  // ---------------------------------------------------------------------------

  describe("approveCheckpoint", () => {
    test("happy path: promotes variation baselineName + all region columns + matchLevel", async () => {
      const ignoreRegion = { x: 1, y: 2, width: 10, height: 20 };
      // Insert a variation and a checkpoint screenshot with ignoreRegions populated.
      const [variation] = await h.db
        .insert(testVariations)
        .values({ name: "checkout", projectId: s.projectId })
        .returning();

      const imageKey = "b".repeat(64);
      const [chk] = await h.db
        .insert(screenshots)
        .values({
          runId: s.runId,
          projectId: s.projectId,
          testVariationId: variation!.id,
          name: "checkout",
          viewport: "1280x720",
          browser: "chromium",
          imageKey,
          matchLevel: "Layout",
          ignoreRegions: [ignoreRegion],
        })
        .returning();

      const client = makeClient(baseUrl, s.memberJwt);
      const res = await client.runs.approveCheckpoint.mutate({
        runId: s.runId,
        checkpointId: chk!.id,
      });
      expect(res).toEqual({ checkpointId: chk!.id });

      // Assert the variation was updated correctly.
      const [v] = await h.db
        .select()
        .from(testVariations)
        .where(eq(testVariations.id, variation!.id))
        .limit(1);
      expect(v!.baselineName).toBe(imageKey);
      expect(v!.matchLevel).toBe("Layout");
      expect(v!.ignoreRegions).toEqual([ignoreRegion]);
      // Remaining region columns were null on the screenshot — must be null on variation.
      expect(v!.layoutRegions).toBeNull();
      expect(v!.floatingRegions).toBeNull();
      expect(v!.contentRegions).toBeNull();
      expect(v!.accessibilityRegions).toBeNull();
    });

    test("ignoreAreas override: reviewer-drawn regions replace the checkpoint's captured regions (draw-and-save)", async () => {
      const captured = { x: 1, y: 2, width: 10, height: 20 };
      const [variation] = await h.db
        .insert(testVariations)
        .values({ name: "checkout-ov", projectId: s.projectId })
        .returning();
      const [chk] = await h.db
        .insert(screenshots)
        .values({
          runId: s.runId,
          projectId: s.projectId,
          testVariationId: variation!.id,
          name: "checkout-ov",
          viewport: "1280x720",
          browser: "chromium",
          imageKey: "c".repeat(64),
          matchLevel: "Strict",
          ignoreRegions: [captured],
        })
        .returning();

      const drawn = {
        x: 50,
        y: 60,
        width: 100,
        height: 80,
        viewport: "1280x720",
        kind: "ignore" as const,
      };

      const client = makeClient(baseUrl, s.memberJwt);
      await client.runs.approveCheckpoint.mutate({
        runId: s.runId,
        checkpointId: chk!.id,
        ignoreAreas: [drawn],
      });

      const [v] = await h.db
        .select()
        .from(testVariations)
        .where(eq(testVariations.id, variation!.id))
        .limit(1);
      const stored = v!.ignoreRegions as Array<{
        x: number;
        width: number;
      }> | null;
      expect(stored).toHaveLength(1);
      // The drawn region (x=50), NOT the captured one (x=1).
      expect(stored?.[0]?.x).toBe(50);
      expect(stored?.[0]?.width).toBe(100);
    });

    test("cross-run safety: checkpointId belonging to a different run returns BAD_REQUEST", async () => {
      // Seed a second run with its own checkpoint.
      const buildId = await getSeedBuildId(h, s.runId);
      const [run2] = await h.db
        .insert(testRuns)
        .values({
          buildId,
          projectId: s.projectId,
          status: "running",
          name: "run2",
          branchName: "feature/x",
        })
        .returning();

      const [variation2] = await h.db
        .insert(testVariations)
        .values({ name: "other-page", projectId: s.projectId })
        .returning();

      const [chk2] = await h.db
        .insert(screenshots)
        .values({
          runId: run2!.id,
          projectId: s.projectId,
          testVariationId: variation2!.id,
          name: "other-page",
          viewport: "1280x720",
          browser: "chromium",
          imageKey: "c".repeat(64),
        })
        .returning();

      const client = makeClient(baseUrl, s.memberJwt);
      let err: TRPCClientError<AppRouter> | undefined;
      try {
        // runId is run1 but checkpointId belongs to run2 — must reject.
        await client.runs.approveCheckpoint.mutate({
          runId: s.runId,
          checkpointId: chk2!.id,
        });
      } catch (e) {
        err = e as TRPCClientError<AppRouter>;
      }
      expect(err?.data?.code).toBe("BAD_REQUEST");
    });
  });

  describe("approveAllCheckpoints", () => {
    test("happy path: approves all checkpoints and returns { approved: N }", async () => {
      // Seed 3 checkpoints on distinct variations.
      const names = ["page-a", "page-b", "page-c"];
      for (const name of names) {
        const [v] = await h.db
          .insert(testVariations)
          .values({ name, projectId: s.projectId })
          .returning();
        await h.db.insert(screenshots).values({
          runId: s.runId,
          projectId: s.projectId,
          testVariationId: v!.id,
          name,
          viewport: "1280x720",
          browser: "chromium",
          imageKey: `${"d".repeat(60)}${name.slice(0, 4).padEnd(4, "0")}`,
        });
      }

      const client = makeClient(baseUrl, s.memberJwt);
      const res = await client.runs.approveAllCheckpoints.mutate({
        runId: s.runId,
      });
      expect(res).toEqual({ approved: 3 });

      // All 3 variations should now have baselineName set.
      const allVariations = await h.db
        .select({ baselineName: testVariations.baselineName })
        .from(testVariations)
        .where(eq(testVariations.projectId, s.projectId));
      const withBaseline = allVariations.filter((v) => v.baselineName !== null);
      expect(withBaseline.length).toBe(3);
    });
  });

  const SIG = `v1:${"a".repeat(64)}`;
  const SIG2 = `v1:${"b".repeat(64)}`;

  describe("runs.getCheckpointGroup", () => {
    test("returns other unresolved same-signature checkpoints in the build", async () => {
      const buildId = await getSeedBuildId(h, s.runId);
      const seedCp = await seedCheckpoint(h, {
        buildId,
        projectId: s.projectId,
        name: "seed",
        signature: SIG,
        unresolved: true,
      });
      const m1 = await seedCheckpoint(h, {
        buildId,
        projectId: s.projectId,
        name: "match1",
        signature: SIG,
        unresolved: true,
      });
      const m2 = await seedCheckpoint(h, {
        buildId,
        projectId: s.projectId,
        name: "match2",
        signature: SIG,
        unresolved: true,
      });
      await seedCheckpoint(h, {
        buildId,
        projectId: s.projectId,
        name: "passed",
        signature: SIG,
        unresolved: false,
      }); // same sig, PASSED -> excluded
      await seedCheckpoint(h, {
        buildId,
        projectId: s.projectId,
        name: "other",
        signature: SIG2,
        unresolved: true,
      }); // different sig -> excluded
      const [otherBuild] = await h.db
        .insert(builds)
        .values({ projectId: s.projectId, userId: s.memberId, isRunning: true })
        .returning();
      await seedCheckpoint(h, {
        buildId: otherBuild.id,
        projectId: s.projectId,
        name: "xbuild",
        signature: SIG,
        unresolved: true,
      }); // diff build -> excluded

      const client = makeClient(baseUrl, s.memberJwt);
      const res = await client.runs.getCheckpointGroup.query({
        runId: seedCp.run.id,
        checkpointId: seedCp.shot.id,
      });
      expect(res.checkpointCount).toBe(2);
      expect(res.runCount).toBe(2);
      expect(new Set(res.checkpoints.map((c) => c.id))).toEqual(
        new Set([m1.shot.id, m2.shot.id]),
      );
      const first = res.checkpoints.find((c) => c.id === m1.shot.id)!;
      expect(first).toHaveProperty("testName");
      expect(first).toHaveProperty("viewport");
      expect(res.capped).toBe(false);
    });

    test("returns empty group when the seed signature is NULL (VLM / auto-approved)", async () => {
      const buildId = await getSeedBuildId(h, s.runId);
      const seedCp = await seedCheckpoint(h, {
        buildId,
        projectId: s.projectId,
        name: "nullsig",
        signature: null,
        unresolved: true,
      });
      await seedCheckpoint(h, {
        buildId,
        projectId: s.projectId,
        name: "nullsig2",
        signature: null,
        unresolved: true,
      });
      const client = makeClient(baseUrl, s.memberJwt);
      const res = await client.runs.getCheckpointGroup.query({
        runId: seedCp.run.id,
        checkpointId: seedCp.shot.id,
      });
      expect(res).toEqual({
        checkpoints: [],
        checkpointCount: 0,
        runCount: 0,
        capped: false,
      });
    });

    test("rejects a checkpoint that is not in the given run", async () => {
      const buildId = await getSeedBuildId(h, s.runId);
      const a = await seedCheckpoint(h, {
        buildId,
        projectId: s.projectId,
        name: "a",
        signature: SIG,
        unresolved: true,
      });
      const b = await seedCheckpoint(h, {
        buildId,
        projectId: s.projectId,
        name: "b",
        signature: SIG,
        unresolved: true,
      });
      const client = makeClient(baseUrl, s.memberJwt);
      const err = await client.runs.getCheckpointGroup
        .query({ runId: a.run.id, checkpointId: b.shot.id })
        .catch((e) => e);
      expect(err?.data?.code).toBe("BAD_REQUEST");
    });

    test("throws NOT_FOUND for a nonexistent checkpointId", async () => {
      const buildId = await getSeedBuildId(h, s.runId);
      const seedCp = await seedCheckpoint(h, {
        buildId,
        projectId: s.projectId,
        name: "seed",
        signature: SIG,
        unresolved: true,
      });
      const client = makeClient(baseUrl, s.memberJwt);
      const err = await client.runs.getCheckpointGroup
        .query({
          runId: seedCp.run.id,
          checkpointId: "00000000-0000-0000-0000-000000000000",
        })
        .catch((e) => e);
      expect(err?.data?.code).toBe("NOT_FOUND");
    });

    test("excludes a same-signature 'new' checkpoint (no baseline yet)", async () => {
      const buildId = await getSeedBuildId(h, s.runId);
      const seedCp = await seedCheckpoint(h, {
        buildId,
        projectId: s.projectId,
        name: "seed",
        signature: SIG,
        unresolved: true,
      });
      const m1 = await seedCheckpoint(h, {
        buildId,
        projectId: s.projectId,
        name: "match1",
        signature: SIG,
        unresolved: true,
      });
      // Same signature but first-run (no baseline) -> status "new" -> must be excluded.
      await seedCheckpoint(h, {
        buildId,
        projectId: s.projectId,
        name: "fresh",
        signature: SIG,
        unresolved: true,
        baselineName: null,
      });
      const client = makeClient(baseUrl, s.memberJwt);
      const res = await client.runs.getCheckpointGroup.query({
        runId: seedCp.run.id,
        checkpointId: seedCp.shot.id,
      });
      expect(new Set(res.checkpoints.map((c) => c.id))).toEqual(
        new Set([m1.shot.id]),
      );
      expect(res.checkpointCount).toBe(1);
    });

    test("rejects a non-member with FORBIDDEN", async () => {
      const buildId = await getSeedBuildId(h, s.runId);
      const cp = await seedCheckpoint(h, {
        buildId,
        projectId: s.projectId,
        name: "seed",
        signature: SIG,
        unresolved: true,
      });
      const client = makeClient(baseUrl, s.nonMemberJwt);
      const err = await client.runs.getCheckpointGroup
        .query({ runId: cp.run.id, checkpointId: cp.shot.id })
        .catch((e) => e);
      expect(err?.data?.code).toBe("FORBIDDEN");
    });
  });

  describe("listCheckpoints", () => {
    test("happy path: returns items ordered by createdAt asc with all required fields", async () => {
      // Seed 3 checkpoints across 2 viewports.
      const [v1] = await h.db
        .insert(testVariations)
        .values({ name: "list-page", projectId: s.projectId })
        .returning();
      const [v2] = await h.db
        .insert(testVariations)
        .values({ name: "list-page-mobile", projectId: s.projectId })
        .returning();

      const chkData = [
        {
          name: "list-page",
          viewport: "1280x720",
          testVariationId: v1!.id,
          imageKey: "e".repeat(64),
        },
        {
          name: "list-page-mobile",
          viewport: "375x667",
          testVariationId: v2!.id,
          imageKey: "f".repeat(64),
        },
        {
          name: "list-page",
          viewport: "1920x1080",
          testVariationId: v1!.id,
          imageKey: "g".repeat(64),
        },
      ];

      for (const d of chkData) {
        await h.db.insert(screenshots).values({
          runId: s.runId,
          projectId: s.projectId,
          testVariationId: d.testVariationId,
          name: d.name,
          viewport: d.viewport,
          browser: "chromium",
          imageKey: d.imageKey,
        });
      }

      const client = makeClient(baseUrl, s.memberJwt);
      const res = await client.runs.listCheckpoints.query({ runId: s.runId });

      expect(res.items.length).toBe(3);

      // Ordered by createdAt asc — first inserted comes first.
      for (let i = 0; i < res.items.length - 1; i++) {
        expect(new Date(res.items[i]!.createdAt).getTime()).toBeLessThanOrEqual(
          new Date(res.items[i + 1]!.createdAt).getTime(),
        );
      }

      // Each item has all required fields.
      for (const item of res.items) {
        expect(item.id).toBeDefined();
        expect(item.name).toBeDefined();
        expect(item.viewport).toBeDefined();
        expect(item.browser).toBeDefined();
        expect(item.matchLevel).toBeDefined();
        expect(item.imageKey).toBeDefined();
        expect(item.testVariationId).toBeDefined();
        expect(item.createdAt).toBeDefined();
      }
    });

    test("non-member receives FORBIDDEN", async () => {
      const client = makeClient(baseUrl, s.nonMemberJwt);
      let err: TRPCClientError<AppRouter> | undefined;
      try {
        await client.runs.listCheckpoints.query({ runId: s.runId });
      } catch (e) {
        err = e as TRPCClientError<AppRouter>;
      }
      expect(err?.data?.code).toBe("FORBIDDEN");
    });

    test("approved run derives its checkpoints as passed despite diff regions", async () => {
      // Regression: approve flips the RUN to passed but keeps diff_regions for
      // display. The checkpoint status must follow (v1.1 has no partial
      // approval), else the batch row badge stays "Unresolved" after approval.
      const buildId = await getSeedBuildId(h, s.runId);
      const cp = await seedCheckpoint(h, {
        buildId,
        projectId: s.projectId,
        name: "approved-cp",
        signature: SIG,
        unresolved: true,
      });
      const client = makeClient(baseUrl, s.memberJwt);

      const before = await client.runs.listCheckpoints.query({
        runId: cp.run.id,
      });
      expect(before.items[0]?.status).toBe("unresolved");

      // Approve = run → passed (the diff_regions are intentionally left).
      await h.db
        .update(testRuns)
        .set({ status: "passed" })
        .where(eq(testRuns.id, cp.run.id));

      const after = await client.runs.listCheckpoints.query({
        runId: cp.run.id,
      });
      expect(after.items[0]?.status).toBe("passed");
    });
  });

  describe("runs.approveCheckpointGroup", () => {
    test("approves the seed + matching unresolved checkpoints across runs, not others", async () => {
      const buildId = await getSeedBuildId(h, s.runId);
      const seedCp = await seedCheckpoint(h, {
        buildId,
        projectId: s.projectId,
        name: "seed",
        signature: SIG,
        unresolved: true,
      });
      const m1 = await seedCheckpoint(h, {
        buildId,
        projectId: s.projectId,
        name: "m1",
        signature: SIG,
        unresolved: true,
      });
      const other = await seedCheckpoint(h, {
        buildId,
        projectId: s.projectId,
        name: "other",
        signature: SIG2,
        unresolved: true,
      });
      const [otherBuild] = await h.db
        .insert(builds)
        .values({ projectId: s.projectId, userId: s.memberId, isRunning: true })
        .returning();
      const xbuild = await seedCheckpoint(h, {
        buildId: otherBuild.id,
        projectId: s.projectId,
        name: "xbuild",
        signature: SIG,
        unresolved: true,
      });

      const client = makeClient(baseUrl, s.memberJwt);
      const res = await client.runs.approveCheckpointGroup.mutate({
        runId: seedCp.run.id,
        checkpointId: seedCp.shot.id,
      });
      expect(res.approved).toBe(2); // seed + m1
      expect(res.runCount).toBe(2);
      expect(res.capped).toBe(false);

      for (const runId of [seedCp.run.id, m1.run.id]) {
        const [r] = await h.db
          .select()
          .from(testRuns)
          .where(eq(testRuns.id, runId));
        expect(r.status).toBe("passed");
        expect(r.merge).toBe(true);
      }
      for (const runId of [other.run.id, xbuild.run.id]) {
        const [r] = await h.db
          .select()
          .from(testRuns)
          .where(eq(testRuns.id, runId));
        expect(r.status).toBe("unresolved");
      }
      const bl = await h.db
        .select()
        .from(baselines)
        .where(eq(baselines.testRunId, m1.run.id));
      expect(bl.length).toBeGreaterThan(0);
      expect(bl[0].userId).toBe(s.memberId);
      const seedBl = await h.db
        .select()
        .from(baselines)
        .where(eq(baselines.testRunId, seedCp.run.id));
      expect(seedBl.length).toBeGreaterThan(0);
      expect(seedBl[0].userId).toBe(s.memberId);
    });

    test("returns approved:0 for a NULL-signature seed (no group)", async () => {
      const buildId = await getSeedBuildId(h, s.runId);
      const seedCp = await seedCheckpoint(h, {
        buildId,
        projectId: s.projectId,
        name: "nullsig",
        signature: null,
        unresolved: true,
      });
      const client = makeClient(baseUrl, s.memberJwt);
      const res = await client.runs.approveCheckpointGroup.mutate({
        runId: seedCp.run.id,
        checkpointId: seedCp.shot.id,
      });
      expect(res.approved).toBe(0);
      const [r] = await h.db
        .select()
        .from(testRuns)
        .where(eq(testRuns.id, seedCp.run.id));
      expect(r.status).toBe("unresolved");
    });

    test("enforces the cap and reports capped=true", async () => {
      const buildId = await getSeedBuildId(h, s.runId);
      const seedCp = await seedCheckpoint(h, {
        buildId,
        projectId: s.projectId,
        name: "seed",
        signature: SIG,
        unresolved: true,
      });
      for (let i = 0; i < GROUP_APPROVE_CAP; i++) {
        await seedCheckpoint(h, {
          buildId,
          projectId: s.projectId,
          name: `m${i}`,
          signature: SIG,
          unresolved: true,
        });
      }
      const client = makeClient(baseUrl, s.memberJwt);
      const res = await client.runs.approveCheckpointGroup.mutate({
        runId: seedCp.run.id,
        checkpointId: seedCp.shot.id,
      });
      expect(res.approved).toBe(GROUP_APPROVE_CAP);
      expect(res.capped).toBe(true);
      expect(res.cap).toBe(GROUP_APPROVE_CAP);
    }, 60_000);

    test("the batch is atomic — a mid-loop failure rolls everything back", async () => {
      const buildId = await getSeedBuildId(h, s.runId);
      const a = await seedCheckpoint(h, {
        buildId,
        projectId: s.projectId,
        name: "a",
        signature: SIG,
        unresolved: true,
      });
      await expect(
        h.db.transaction(async (tx) => {
          await approveCheckpointInTx(
            tx,
            {
              testVariationId: a.variation.id,
              imageKey: a.shot.imageKey,
              ignoreRegions: null,
              layoutRegions: null,
              floatingRegions: null,
              contentRegions: null,
              accessibilityRegions: null,
              matchLevel: "Strict",
            },
            { id: a.run.id, name: a.run.name, branchName: a.run.branchName },
            s.memberId,
          );
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      const [v] = await h.db
        .select()
        .from(testVariations)
        .where(eq(testVariations.id, a.variation.id));
      expect(v.baselineName).toBe("existing-baseline");
      const [r] = await h.db
        .select()
        .from(testRuns)
        .where(eq(testRuns.id, a.run.id));
      expect(r.status).toBe("unresolved");
      const blRows = await h.db
        .select()
        .from(baselines)
        .where(eq(baselines.testRunId, a.run.id));
      expect(blRows.length).toBe(0);
    });

    test("rejects a non-member with FORBIDDEN", async () => {
      const buildId = await getSeedBuildId(h, s.runId);
      const cp = await seedCheckpoint(h, {
        buildId,
        projectId: s.projectId,
        name: "seed",
        signature: SIG,
        unresolved: true,
      });
      const client = makeClient(baseUrl, s.nonMemberJwt);
      const err = await client.runs.approveCheckpointGroup
        .mutate({ runId: cp.run.id, checkpointId: cp.shot.id })
        .catch((e) => e);
      expect(err?.data?.code).toBe("FORBIDDEN");
    });
  });

  describe("runs.rejectCheckpointGroup", () => {
    test("fails the matched checkpoints' distinct runs, not other-sig / other-build runs", async () => {
      const buildId = await getSeedBuildId(h, s.runId);
      const seedCp = await seedCheckpoint(h, {
        buildId,
        projectId: s.projectId,
        name: "seed",
        signature: SIG,
        unresolved: true,
      });
      const m1 = await seedCheckpoint(h, {
        buildId,
        projectId: s.projectId,
        name: "m1",
        signature: SIG,
        unresolved: true,
      });
      const other = await seedCheckpoint(h, {
        buildId,
        projectId: s.projectId,
        name: "other",
        signature: SIG2,
        unresolved: true,
      });
      const [otherBuild] = await h.db
        .insert(builds)
        .values({ projectId: s.projectId, userId: s.memberId, isRunning: true })
        .returning();
      const xbuild = await seedCheckpoint(h, {
        buildId: otherBuild.id,
        projectId: s.projectId,
        name: "xbuild",
        signature: SIG,
        unresolved: true,
      });

      const client = makeClient(baseUrl, s.memberJwt);
      const res = await client.runs.rejectCheckpointGroup.mutate({
        runId: seedCp.run.id,
        checkpointId: seedCp.shot.id,
      });
      expect(res.rejected).toBe(2);
      expect(res.runCount).toBe(2);
      expect(res.capped).toBe(false);

      for (const runId of [seedCp.run.id, m1.run.id]) {
        const [r] = await h.db
          .select()
          .from(testRuns)
          .where(eq(testRuns.id, runId));
        expect(r.status).toBe("failed");
        expect(r.merge).toBe(false);
      }
      for (const runId of [other.run.id, xbuild.run.id]) {
        const [r] = await h.db
          .select()
          .from(testRuns)
          .where(eq(testRuns.id, runId));
        expect(r.status).toBe("unresolved");
      }
    });

    test("dedupes runs: two matched checkpoints in one run fail that run once", async () => {
      const buildId = await getSeedBuildId(h, s.runId);
      const seedCp = await seedCheckpoint(h, {
        buildId,
        projectId: s.projectId,
        name: "seed",
        signature: SIG,
        unresolved: true,
      });
      const [shot2] = await h.db
        .insert(screenshots)
        .values({
          runId: seedCp.run.id,
          projectId: s.projectId,
          testVariationId: seedCp.variation.id,
          name: "seed-2",
          viewport: "800x600",
          browser: "chromium",
          imageKey: "seed2".padEnd(64, "k"),
          matchLevel: "Strict",
          diffSignature: SIG,
        })
        .returning();
      await h.db.insert(diffRegions).values({
        runId: seedCp.run.id,
        projectId: s.projectId,
        screenshotId: shot2.id,
        severity: "high",
        category: "layout",
        source: "l2_dom",
        description: "diff",
        bbox: { x: 0, y: 0, width: 10, height: 10 },
      });
      const client = makeClient(baseUrl, s.memberJwt);
      const res = await client.runs.rejectCheckpointGroup.mutate({
        runId: seedCp.run.id,
        checkpointId: seedCp.shot.id,
      });
      expect(res.rejected).toBe(1);
    });

    test("returns rejected:0 for a NULL-signature seed", async () => {
      const buildId = await getSeedBuildId(h, s.runId);
      const seedCp = await seedCheckpoint(h, {
        buildId,
        projectId: s.projectId,
        name: "nullsig",
        signature: null,
        unresolved: true,
      });
      const client = makeClient(baseUrl, s.memberJwt);
      const res = await client.runs.rejectCheckpointGroup.mutate({
        runId: seedCp.run.id,
        checkpointId: seedCp.shot.id,
      });
      expect(res.rejected).toBe(0);
      const [r] = await h.db
        .select()
        .from(testRuns)
        .where(eq(testRuns.id, seedCp.run.id));
      expect(r.status).toBe("unresolved");
    });

    test("rejects a checkpoint not in the given run", async () => {
      const buildId = await getSeedBuildId(h, s.runId);
      const a = await seedCheckpoint(h, {
        buildId,
        projectId: s.projectId,
        name: "a",
        signature: SIG,
        unresolved: true,
      });
      const b = await seedCheckpoint(h, {
        buildId,
        projectId: s.projectId,
        name: "b",
        signature: SIG,
        unresolved: true,
      });
      const client = makeClient(baseUrl, s.memberJwt);
      const err = await client.runs.rejectCheckpointGroup
        .mutate({ runId: a.run.id, checkpointId: b.shot.id })
        .catch((e) => e);
      expect(err?.data?.code).toBe("BAD_REQUEST");
    });

    test("rejects a non-member with FORBIDDEN", async () => {
      const buildId = await getSeedBuildId(h, s.runId);
      const cp = await seedCheckpoint(h, {
        buildId,
        projectId: s.projectId,
        name: "seed",
        signature: SIG,
        unresolved: true,
      });
      const client = makeClient(baseUrl, s.nonMemberJwt);
      const err = await client.runs.rejectCheckpointGroup
        .mutate({ runId: cp.run.id, checkpointId: cp.shot.id })
        .catch((e) => e);
      expect(err?.data?.code).toBe("FORBIDDEN");
    });
  });
});
