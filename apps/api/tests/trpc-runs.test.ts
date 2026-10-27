import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";

import {
  and,
  asc,
  auditLog,
  baselines,
  builds,
  checkpointDecisions,
  diffRegions,
  eq,
  inArray,
  projectMembers,
  projects,
  recomputeRunStatus,
  resolveBaseline,
  screenshots,
  sql,
  testRuns,
  testVariations,
  users,
} from "@furan/db";
import type {
  CheckpointVerdict,
  ReviewErrorDetails,
} from "@furan/shared-types";
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

import { createTestApp, diffJobsEnqueued, type TestApp } from "./helpers.js";
import {
  addReviewRun,
  cleanupReviewSeeds,
  seedReviewRun,
  type ReviewRunSpec,
  type ReviewSeed,
  type ReviewUser,
} from "./review-fixtures.js";

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
  await h.db.delete(auditLog);
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
    /**
     * The checkpoint's stored verdict (what the diff-worker wrote). Defaults to
     * the intent of `unresolved`: `unresolved`, else `passed`.
     */
    verdict?: CheckpointVerdict;
    branchName?: string;
    viewport?: string;
    baselineName?: string | null;
  },
) {
  const viewport = opts.viewport ?? "1280x720";
  const effectiveBaselineName =
    opts.baselineName === undefined ? "existing-baseline" : opts.baselineName;
  const verdict: CheckpointVerdict =
    opts.verdict ?? (opts.unresolved ? "unresolved" : "passed");
  const [variation] = await h.db
    .insert(testVariations)
    .values({
      name: opts.name,
      projectId: opts.projectId,
      baselineName: effectiveBaselineName,
    })
    .returning();
  const [run] = await h.db
    .insert(testRuns)
    .values({
      buildId: opts.buildId,
      projectId: opts.projectId,
      // Run status mirrors the checkpoint intent: an unresolved checkpoint
      // lives in an unresolved run; a non-unresolved one models a resolved
      // (passed) run.
      status: opts.unresolved ? "unresolved" : "passed",
      branchName: opts.branchName ?? "feature/x",
      name: opts.name,
      // Its one step, and the stored pending counter a writer would leave for
      // it (spec 2026-10-27 §3.1): the run is reviewable, the step undecided.
      checkpointCount: 1,
      pendingSteps: verdict === "passed" ? 0 : 1,
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
      // The per-checkpoint verdict is what the review reads (and the group
      // procedures' "pending" rule) go by; a checkpoint with none is not
      // diffed yet and its run is not reviewable.
      verdict,
    })
    .returning();
  // A fixture representing a variation WITH a baseline inserts a real
  // baselines row on the run's branch (what a diff would have compared to).
  if (effectiveBaselineName !== null) {
    await h.db.insert(baselines).values({
      baselineName: effectiveBaselineName,
      testVariationId: variation.id,
      testRunId: run.id,
      branchName: run.branchName ?? undefined,
    });
  }
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

  test("getById: a member gets the run header; a step's baseline context is getStep's", async () => {
    const [step] = await h.db
      .insert(screenshots)
      .values({
        runId: s.runId,
        projectId: s.projectId,
        testVariationId: s.variationId,
        name: "home",
        viewport: "1280x720",
        browser: "chromium",
        imageKey: "e".repeat(64),
      })
      .returning({ id: screenshots.id });
    const client = makeClient(baseUrl, s.memberJwt);
    const data = await client.runs.getById.query({ runId: s.runId });
    expect(data.id).toBe(s.runId);
    // Spec 2026-10-27 §5: the header carries none of the run's steps.
    for (const gone of [
      "screenshots",
      "diffRegions",
      "checkpointContexts",
      "baselineScreenshot",
      "variationIgnoreAreas",
      "ignoreAreas",
    ]) {
      expect(data).not.toHaveProperty(gone);
    }
    // T9: baseline lookup is getStep's; null for a step with no prior baseline.
    const view = await client.runs.getStep.query({
      runId: s.runId,
      checkpointId: step!.id,
    });
    expect(view.baselineContext.baselineScreenshot).toBeNull();
    expect(view.baselineContext.baselineSource).toBeNull();
  });

  test("getStep: returns baselineScreenshot when a prior baseline exists", async () => {
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

    // A step of the current run on the same variation, so getStep can
    // resolve the baseline via its testVariationId.
    const [current] = await h.db
      .insert(screenshots)
      .values({
        runId: s.runId,
        projectId: s.projectId,
        testVariationId: s.variationId,
        name: "current",
        imageKey: "b".repeat(64),
        viewport: "1280x720",
        browser: "chromium",
      })
      .returning({ id: screenshots.id });

    const client = makeClient(baseUrl, s.memberJwt);
    const { baselineContext: data } = await client.runs.getStep.query({
      runId: s.runId,
      checkpointId: current!.id,
    });
    expect(data.baselineScreenshot).not.toBeNull();
    expect(data.baselineScreenshot?.imageKey).toBe("a".repeat(64));
    expect(data.baselineSource).toBe("this_branch");
  });

  test("getStep: baselineSource is parent_pr when the baseline lives only on the parent branch (ADR-055)", async () => {
    // Current run is on feature/x with parent=develop; the only baseline is
    // on develop. this_branch (feature/x) + default (main) both miss, so the
    // parent_pr tier must resolve it — proving runs.ts threads the parent.
    await h.db
      .update(testRuns)
      .set({ parentBranchName: "develop" })
      .where(eq(testRuns.id, s.runId));

    // ADR-054: the develop baseline lives under a DISTINCT sibling variation on
    // develop that shares the candidate's branch-agnostic identity — NOT the
    // candidate's own feature/x variation. resolveBaseline's parent_pr tier
    // resolves that sibling by identity, then takes its baseline.
    const [candidateVar] = await h.db
      .select()
      .from(testVariations)
      .where(eq(testVariations.id, s.variationId));
    const [devVar] = await h.db
      .insert(testVariations)
      .values({
        name: candidateVar!.name,
        projectId: s.projectId,
        branchName: "develop",
        viewport: candidateVar!.viewport,
        browser: candidateVar!.browser,
        os: candidateVar!.os,
        device: candidateVar!.device,
        baselineName: "older",
      })
      .returning();

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
      testVariationId: devVar!.id,
      name: candidateVar!.name,
      imageKey: "d".repeat(64),
      viewport: candidateVar!.viewport ?? "1280x720",
      browser: candidateVar!.browser ?? "chromium",
    });

    await h.db.insert(baselines).values({
      baselineName: "older",
      testVariationId: devVar!.id,
      testRunId: olderRun.id,
      branchName: "develop",
    });

    // A step of the current run on the candidate variation, for getStep to
    // resolve.
    const [current] = await h.db
      .insert(screenshots)
      .values({
        runId: s.runId,
        projectId: s.projectId,
        testVariationId: s.variationId,
        name: "current",
        imageKey: "c".repeat(64),
        viewport: candidateVar!.viewport ?? "1280x720",
        browser: candidateVar!.browser ?? "chromium",
      })
      .returning({ id: screenshots.id });

    const client = makeClient(baseUrl, s.memberJwt);
    const { baselineContext: data } = await client.runs.getStep.query({
      runId: s.runId,
      checkpointId: current!.id,
    });
    expect(data.baselineSource).toBe("parent_pr");
    // The baseline screenshot must resolve under the SIBLING (develop)
    // variation the baseline actually lives on — keying off the candidate's
    // own variation would find nothing and blank the baseline image.
    expect(data.baselineScreenshot?.imageKey).toBe("d".repeat(64));
    // Control: the served screenshot is the sibling's, not the candidate's —
    // guards against an accidental match that happened to return an image.
    expect(data.baselineScreenshot?.testVariationId).toBe(devVar!.id);
  });

  test("getStep: returns variationIgnoreAreas from the step's variation", async () => {
    // ADR-038: variationIgnoreAreas comes from the step's variation
    // (test_variations.ignore_regions). Seed a step on the variation, then
    // set ignore_regions on that variation.
    const region = {
      x: 10,
      y: 20,
      width: 30,
      height: 40,
      viewport: "1280x720",
    };
    const [step] = await h.db
      .insert(screenshots)
      .values({
        runId: s.runId,
        projectId: s.projectId,
        testVariationId: s.variationId,
        name: "home",
        viewport: "1280x720",
        browser: "chromium",
        imageKey: "aaaa",
      })
      .returning({ id: screenshots.id });
    const client = makeClient(baseUrl, s.memberJwt);
    const read = async () =>
      (
        await client.runs.getStep.query({
          runId: s.runId,
          checkpointId: step!.id,
        })
      ).baselineContext.variationIgnoreAreas;
    // ADR-038: ignore_regions is jsonb; null when no regions are set.
    expect(await read()).toBeNull();
    await h.db
      .update(testVariations)
      .set({ ignoreRegions: [region] })
      .where(eq(testVariations.id, s.variationId));
    expect(await read()).toEqual([region]);
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

  test("getById: runByName is the build's runner, as builds.getById names them", async () => {
    const client = makeClient(baseUrl, s.memberJwt);
    const buildId = await getSeedBuildId(h, s.runId);
    const named = async () => {
      const run = await client.runs.getById.query({ runId: s.runId });
      const build = await client.builds.getById.query({ buildId });
      expect(run.runByName).toBe(build.runByName);
      return run.runByName;
    };
    expect(await named()).toBe("Mem Ber");
    await h.db
      .update(users)
      .set({ firstName: "Solo", lastName: "" })
      .where(eq(users.id, s.memberId));
    expect(await named()).toBe("Solo");
    // A build nobody ran: no name.
    await h.db
      .update(builds)
      .set({ userId: null })
      .where(eq(builds.id, buildId));
    expect(await named()).toBeNull();
  });

  test("getById: runByName never names the runner of another project's build", async () => {
    // Corrupt data: the run sits in a build of another project.
    const [other] = await h.db
      .insert(projects)
      .values({ name: "beta" })
      .returning();
    const [foreignBuild] = await h.db
      .insert(builds)
      .values({ projectId: other!.id, userId: s.memberId })
      .returning();
    await h.db
      .update(testRuns)
      .set({ buildId: foreignBuild!.id })
      .where(eq(testRuns.id, s.runId));
    const client = makeClient(baseUrl, s.memberJwt);
    const run = await client.runs.getById.query({ runId: s.runId });
    expect(run.runByName).toBeNull();
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
      // Written as the run's override (ADR-070), which the rollup honours.
      expect(rows[0]?.statusOverride).toBe("passed");
      // merge unchanged (still default false from the seed insert).
      expect(rows[0]?.merge).toBe(false);
    });

    /** Gives the seeded run one diffed checkpoint with `verdict`. */
    async function diffedCheckpoint(verdict: CheckpointVerdict) {
      await h.db.insert(screenshots).values({
        runId: s.runId,
        projectId: s.projectId,
        testVariationId: s.variationId,
        name: "home",
        imageKey: `override-${verdict}-img`,
        viewport: "1280x720",
        browser: "chromium",
        verdict,
      });
    }

    test("status='default' recomputes to 'unresolved' when diff_regions has severity!=none", async () => {
      // "default" clears the override and recomputes the rollup (ADR-070),
      // which reads the checkpoint verdicts the diff wrote, not diff_regions:
      // the unresolved verdict that came with the major region decides.
      await diffedCheckpoint("unresolved");
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
      // Forced `passed` first, so the reset must flip it back.
      await client.runs.overrideStatus.mutate({
        runId: s.runId,
        status: "passed",
      });
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
      // Seed: status=unresolved (from helper), no diff_regions inserted. The
      // run's one checkpoint diffed clean (verdict passed), so the recompute
      // (the rollup of the verdicts, ADR-070) flips it to passed.
      await diffedCheckpoint("passed");
      const client = makeClient(baseUrl, s.memberJwt);
      const res = await client.runs.overrideStatus.mutate({
        runId: s.runId,
        status: "default",
      });
      expect(res.status).toBe("passed");
    });

    test("status='default' resolves to 'passed' when all diff_regions have severity=none", async () => {
      // A below-threshold region leaves the checkpoint's verdict passed.
      await diffedCheckpoint("passed");
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
      // legacy "failed" on diff-found): the checkpoint's verdict and the
      // rolled-up run status. The real handler is integration-tested in
      // apps/diff-worker/tests/handler.test.ts.
      await h.db.insert(screenshots).values({
        runId: created.runId,
        projectId: s.projectId,
        testVariationId: s.variationId,
        name: "lifecycle-e2e",
        imageKey: "lifecycle-e2e-img",
        viewport: "1280x720",
        browser: "chromium",
        verdict: "unresolved",
      });
      await h.db
        .update(testRuns)
        .set({ status: "unresolved" })
        .where(eq(testRuns.id, created.runId));

      // Stage 3: reviewer approves via tRPC (`review.approve`, as the
      // dashboard calls it). This must (a) flip status → passed and (b) set
      // merge → true (the approve baselined the run's checkpoint).
      const client = makeClient(baseUrl, s.memberJwt);
      const approveRes = await client.review.approve.mutate({
        runId: created.runId,
        actionId: randomUUID(),
      });
      expect(approveRes.decided).toHaveLength(1);

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

      // Simulate diff-worker writing the diff-found terminal state. The
      // checkpoint's own verdict is passed: the regions were pruned.
      await h.db.insert(screenshots).values({
        runId: created.runId,
        projectId: s.projectId,
        testVariationId: s.variationId,
        name: "lifecycle-e2e-override",
        imageKey: "lifecycle-e2e-override-img",
        viewport: "1280x720",
        browser: "chromium",
        verdict: "passed",
      });
      await h.db
        .update(testRuns)
        .set({ status: "unresolved" })
        .where(eq(testRuns.id, created.runId));

      // No diff_regions inserted — the recompute (the rollup of the verdicts)
      // resolves to passed.
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

  test("getById has no prevRunId / nextRunId: review.next walks the queue", async () => {
    // The sibling-run links were always null (ADR-038); the review loop
    // (review.next) is the one way to the next or previous run now.
    const client = makeClient(baseUrl, s.memberJwt);
    const data = await client.runs.getById.query({ runId: s.runId });
    expect(data).not.toHaveProperty("prevRunId");
    expect(data).not.toHaveProperty("nextRunId");
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
      const enqueuedBefore = await diffJobsEnqueued(
        h.app.telemetry.metrics,
        "ignore_areas",
      );
      // ADR-038: test_runs no longer has ignore_areas column. Run-scope ignore
      // areas are written to the first checkpoint's variation's ignore_regions.
      // Seed a screenshot to link the run to the variation.
      const [shot] = await h.db
        .insert(screenshots)
        .values({
          runId: s.runId,
          projectId: s.projectId,
          testVariationId: s.variationId,
          name: "home",
          imageKey: "seed-img",
          viewport: VP,
          browser: "chromium",
        })
        .returning({ id: screenshots.id });

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

      // The run's step, at its next version, under its job id.
      expect(h.diffQueueAdd).toHaveBeenCalledTimes(1);
      expect(h.diffQueueAdd).toHaveBeenCalledWith(
        "diff",
        {
          runId: s.runId,
          projectId: s.projectId,
          screenshotId: shot!.id,
          generation: 1,
        },
        { jobId: `${shot!.id}-g1` },
      );
      expect(
        await diffJobsEnqueued(h.app.telemetry.metrics, "ignore_areas"),
      ).toBe(enqueuedBefore + 1);
    });

    test("scope=variation writes to test_variations.ignore_regions and enqueues a diff job (ADR-038)", async () => {
      // ADR-038: ignore_areas on test_variations renamed to ignore_regions (jsonb).
      // Seed a screenshot to link the run to the variation.
      const [shot] = await h.db
        .insert(screenshots)
        .values({
          runId: s.runId,
          projectId: s.projectId,
          testVariationId: s.variationId,
          name: "home",
          imageKey: "seed-img",
          viewport: VP,
          browser: "chromium",
        })
        .returning({ id: screenshots.id });

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
      expect(h.diffQueueAdd).toHaveBeenCalledWith(
        "diff",
        {
          runId: s.runId,
          projectId: s.projectId,
          screenshotId: shot!.id,
          generation: 1,
        },
        { jobId: `${shot!.id}-g1` },
      );
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
      const enqueuedBefore = await diffJobsEnqueued(
        h.app.telemetry.metrics,
        "ignore_areas",
      );
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
      expect(
        await diffJobsEnqueued(h.app.telemetry.metrics, "ignore_areas"),
      ).toBe(enqueuedBefore + 1);
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
    // broadcast. The decisions' own broadcasts (approve, reject, groups, a
    // build) are asserted with the `review.*` suite (trpc-review.test.ts).
    beforeEach(() => {
      h.broadcasterPublish.mockClear();
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
  });

  // ---------------------------------------------------------------------------
  // ADR-038 Phase 2: what approving a checkpoint promotes, and listCheckpoints
  // ---------------------------------------------------------------------------

  describe("review.approve promotes a checkpoint (ADR-038)", () => {
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
          verdict: "unresolved",
        })
        .returning();

      const client = makeClient(baseUrl, s.memberJwt);
      const res = await client.review.approve.mutate({
        runId: s.runId,
        actionId: randomUUID(),
        checkpointIds: [chk!.id],
      });
      expect(res.decided).toEqual([
        { checkpointId: chk!.id, runId: s.runId, state: "approved" },
      ]);

      // Assert the variation was updated correctly.
      const [v] = await h.db
        .select()
        .from(testVariations)
        .where(eq(testVariations.id, variation!.id))
        .limit(1);
      expect(v!.baselineName).toBe(imageKey);
      expect(v!.matchLevel).toBe("Layout");
      // ADR-067: captured regions are promoted tagged as SDK-owned.
      expect(v!.ignoreRegions).toEqual([{ ...ignoreRegion, source: "sdk" }]);
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
          verdict: "unresolved",
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
      await client.review.approve.mutate({
        runId: s.runId,
        actionId: randomUUID(),
        checkpointIds: [chk!.id],
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

    test("includes a same-signature 'new' checkpoint (pending, no baseline yet)", async () => {
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
      // Same signature but first-run (no baseline): its verdict is `new`, which
      // is pending like `unresolved` (the decision core's rule), so it is a
      // member of the group.
      const fresh = await seedCheckpoint(h, {
        buildId,
        projectId: s.projectId,
        name: "fresh",
        signature: SIG,
        unresolved: true,
        verdict: "new",
        baselineName: null,
      });
      const client = makeClient(baseUrl, s.memberJwt);
      const res = await client.runs.getCheckpointGroup.query({
        runId: seedCp.run.id,
        checkpointId: seedCp.shot.id,
      });
      expect(new Set(res.checkpoints.map((c) => c.id))).toEqual(
        new Set([m1.shot.id, fresh.shot.id]),
      );
      expect(res.checkpointCount).toBe(2);
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
    test("happy path: returns items ordered by createdAt asc with what the rail draws", async () => {
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

      const insertedIds: string[] = [];
      for (const d of chkData) {
        const [row] = await h.db
          .insert(screenshots)
          .values({
            runId: s.runId,
            projectId: s.projectId,
            testVariationId: d.testVariationId,
            name: d.name,
            viewport: d.viewport,
            browser: "chromium",
            imageKey: d.imageKey,
          })
          .returning({ id: screenshots.id });
        insertedIds.push(row!.id);
      }

      const client = makeClient(baseUrl, s.memberJwt);
      const res = await client.runs.listCheckpoints.query({ runId: s.runId });

      // Ordered by createdAt asc — first inserted comes first.
      expect(res.items.map((i) => i.id)).toEqual(insertedIds);

      // Each item has what the rail and the step cards draw.
      res.items.forEach((item, i) => {
        expect(item).toMatchObject({
          name: chkData[i]!.name,
          viewport: chkData[i]!.viewport,
          browser: "chromium",
          imageKey: chkData[i]!.imageKey,
        });
        // The rest of a step (its match level, variation, capture time and
        // numbers) is getStep's (spec 2026-10-27 §5).
        for (const gone of ["matchLevel", "testVariationId", "createdAt"]) {
          expect(item).not.toHaveProperty(gone);
        }
      });
      const { step } = await client.runs.getStep.query({
        runId: s.runId,
        checkpointId: insertedIds[1]!,
      });
      expect(step).toMatchObject({
        matchLevel: expect.any(String),
        testVariationId: v2!.id,
      });
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

    test("an approved checkpoint reads as approved despite its diff regions; the run's status alone does not decide", async () => {
      // Regression (was: "approved run derives its checkpoints as passed"):
      // approving keeps diff_regions for display, and the checkpoint's state
      // follows ITS decision. Forcing the run to `passed` without a decision no
      // longer turns its checkpoints passed (that inference is gone).
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
      expect(before.items[0]?.state).toBe("unresolved");

      await h.db
        .update(testRuns)
        .set({ status: "passed" })
        .where(eq(testRuns.id, cp.run.id));
      const forced = await client.runs.listCheckpoints.query({
        runId: cp.run.id,
      });
      expect(forced.items[0]?.state).toBe("unresolved");

      await client.review.approve.mutate({
        runId: cp.run.id,
        actionId: randomUUID(),
        checkpointIds: [cp.shot.id],
      });
      const after = await client.runs.listCheckpoints.query({
        runId: cp.run.id,
      });
      expect(after.items[0]).toMatchObject({
        state: "approved",
        verdict: "unresolved",
      });
      // The per-checkpoint `status` alias is gone: `state` is the one field.
      expect(after.items[0]).not.toHaveProperty("status");
    });

    test("a checkpoint with no diff regions reads as its stored verdict", async () => {
      // Regression (was: "region-less unresolved run derives its checkpoint as
      // unresolved"): the diff-worker can find a diff yet persist no
      // severity!='none' diff_regions (a small/scattered one). The old read had
      // to guess from the run's status; the verdict is now stored per checkpoint.
      const buildId = await getSeedBuildId(h, s.runId);
      const cp = await seedCheckpoint(h, {
        buildId,
        projectId: s.projectId,
        name: "regionless",
        signature: null,
        unresolved: false, // baseline present, NO diff_regions
        verdict: "unresolved",
      });

      const client = makeClient(baseUrl, s.memberJwt);
      const res = await client.runs.listCheckpoints.query({ runId: cp.run.id });
      expect(res.items[0]?.state).toBe("unresolved");
      expect(res.items[0]?.verdict).toBe("unresolved");
    });
  });

  describe("baseline latest-wins (several baselines in one transaction)", () => {
    // resolveBaseline picks the newest `baselines` row by created_at, whose
    // column default now() is the TRANSACTION start time: every baseline a
    // build / group approve wrote for one variation tied, so which image
    // resolved was arbitrary. The newest run must win.
    const SIG_LW = `v1:${"c".repeat(64)}`;

    async function seedVariationRun(
      buildId: string,
      opts: {
        label: string;
        createdAt: Date;
        status: "unresolved" | "passed";
        signature?: string;
      },
    ) {
      const [run] = await h.db
        .insert(testRuns)
        .values({
          buildId,
          projectId: s.projectId,
          status: opts.status,
          branchName: "feature/x",
          name: "home page",
          createdAt: opts.createdAt,
        })
        .returning();
      const [shot] = await h.db
        .insert(screenshots)
        .values({
          runId: run!.id,
          projectId: s.projectId,
          testVariationId: s.variationId,
          name: "home",
          viewport: "1280x720",
          browser: "chromium",
          imageKey: opts.label.padEnd(64, "k").slice(0, 64),
          matchLevel: "Strict",
          diffSignature: opts.signature ?? null,
          verdict: opts.status === "unresolved" ? "unresolved" : "passed",
        })
        .returning();
      return { run: run!, shot: shot! };
    }

    async function newBuild(): Promise<string> {
      const [build] = await h.db
        .insert(builds)
        .values({ projectId: s.projectId, userId: s.memberId })
        .returning();
      return build!.id;
    }

    /** The baseline row resolveBaseline diffs the variation's next run against. */
    async function resolvedBaseline() {
      const res = await resolveBaseline(
        h.db,
        s.projectId,
        "feature/x",
        s.variationId,
        { defaultBranch: "main" },
      );
      expect(res?.source).toBe("this_branch");
      const [row] = await h.db
        .select()
        .from(baselines)
        .where(eq(baselines.id, res!.baselineId));
      return row!;
    }

    /**
     * `laterRunId`'s baseline row sorts strictly after `earlierRunId`'s —
     * compared in SQL, since JS Dates drop created_at's microseconds.
     */
    async function stampedAfter(
      laterRunId: string,
      earlierRunId: string,
    ): Promise<boolean> {
      const [row] = await h.db
        .select({
          after: sql<boolean>`${baselines.createdAt} > (
            select b.created_at from baselines b
            where b.test_variation_id = ${s.variationId}
              and b.test_run_id = ${earlierRunId})`,
        })
        .from(baselines)
        .where(
          and(
            eq(baselines.testVariationId, s.variationId),
            eq(baselines.testRunId, laterRunId),
          ),
        );
      return row?.after === true;
    }

    async function variationBaselineName(): Promise<string | null> {
      const [v] = await h.db
        .select({ baselineName: testVariations.baselineName })
        .from(testVariations)
        .where(eq(testVariations.id, s.variationId));
      return v!.baselineName;
    }

    test("review.approveBuild: two runs of one variation — the newer run's image is the baseline", async () => {
      const buildId = await newBuild();
      const t0 = Date.now();
      // Inserted newest-first, so heap order is the reverse of run order: the
      // build approve must still approve the newest run last.
      const newer = await seedVariationRun(buildId, {
        label: "newer",
        createdAt: new Date(t0),
        status: "unresolved",
      });
      const older = await seedVariationRun(buildId, {
        label: "older",
        createdAt: new Date(t0 - 60_000),
        status: "unresolved",
      });

      const client = makeClient(baseUrl, s.memberJwt);
      const res = await client.review.approveBuild.mutate({
        buildId,
        actionId: randomUUID(),
        expectedCount: 2,
      });
      expect(res.decided).toHaveLength(2);

      expect(await stampedAfter(newer.run.id, older.run.id)).toBe(true);
      const resolved = await resolvedBaseline();
      expect(resolved.testRunId).toBe(newer.run.id);
      expect(resolved.baselineName).toBe(newer.shot.imageKey);
      // The denormalized pointer agrees with the resolver.
      expect(await variationBaselineName()).toBe(newer.shot.imageKey);
    });

    test.each(["a whole run", "one checkpoint"] as const)(
      "review.approve of %s: re-approving an older, already-approved run leaves the newer image the baseline (R19)",
      async (scope) => {
        // Was (ADR-068): re-approving the older run re-promoted its image.
        // R19 / ADR-071: a decided checkpoint changes only through undo, so an
        // explicit re-approve is refused (CONFLICT already_decided) and a
        // run-level one finds nothing pending and writes nothing.
        const buildId = await newBuild();
        const t0 = Date.now();
        const older = await seedVariationRun(buildId, {
          label: "older",
          createdAt: new Date(t0 - 60_000),
          status: "unresolved",
        });
        const newer = await seedVariationRun(buildId, {
          label: "newer",
          createdAt: new Date(t0),
          status: "unresolved",
        });
        const client = makeClient(baseUrl, s.memberJwt);
        await client.review.approveBuild.mutate({
          buildId,
          actionId: randomUUID(),
          expectedCount: 2,
        });
        expect((await resolvedBaseline()).testRunId).toBe(newer.run.id);

        if (scope === "a whole run") {
          // Nothing is pending any more: an empty success that decides nothing.
          const res = await client.review.approve.mutate({
            runId: older.run.id,
            actionId: randomUUID(),
          });
          expect(res.decided).toEqual([]);
        } else {
          const err = await client.review.approve
            .mutate({
              runId: older.run.id,
              actionId: randomUUID(),
              checkpointIds: [older.shot.id],
            })
            .catch((e: unknown) => e);
          expect(err).toBeInstanceOf(TRPCClientError);
          expect((err as TRPCClientError<AppRouter>).data?.code).toBe(
            "CONFLICT",
          );
          expect((err as TRPCClientError<AppRouter>).message).toBe(
            "already_decided",
          );
        }

        // The newer image stays current, in the resolver and the pointer.
        expect(await stampedAfter(newer.run.id, older.run.id)).toBe(true);
        const resolved = await resolvedBaseline();
        expect(resolved.testRunId).toBe(newer.run.id);
        expect(await variationBaselineName()).toBe(newer.shot.imageKey);
        const decisions = await h.db
          .select()
          .from(checkpointDecisions)
          .where(eq(checkpointDecisions.runId, older.run.id));
        expect(decisions).toHaveLength(1);
      },
    );

    test("review.approveGroup: one variation across runs — the newer run's image is the baseline", async () => {
      // A prior baseline on the branch, so the checkpoints are "unresolved".
      const prior = await seedVariationRun(await newBuild(), {
        label: "prior",
        createdAt: new Date(Date.now() - 120_000),
        status: "passed",
      });
      await h.db.insert(baselines).values({
        baselineName: prior.shot.imageKey,
        testVariationId: s.variationId,
        testRunId: prior.run.id,
        branchName: "feature/x",
      });

      const buildId = await newBuild();
      const t0 = Date.now();
      // The newer run's checkpoint is captured first, so capture order is the
      // reverse of run order: the group must still approve the newest run last.
      const newer = await seedVariationRun(buildId, {
        label: "newer",
        createdAt: new Date(t0),
        status: "unresolved",
        signature: SIG_LW,
      });
      const older = await seedVariationRun(buildId, {
        label: "older",
        createdAt: new Date(t0 - 60_000),
        status: "unresolved",
        signature: SIG_LW,
      });
      for (const cp of [newer, older]) {
        await h.db.insert(diffRegions).values({
          runId: cp.run.id,
          projectId: s.projectId,
          screenshotId: cp.shot.id,
          severity: "high",
          category: "layout",
          source: "l2_dom",
          description: "diff",
          bbox: { x: 0, y: 0, width: 10, height: 10 },
        });
      }

      const client = makeClient(baseUrl, s.memberJwt);
      const res = await client.review.approveGroup.mutate({
        runId: older.run.id,
        checkpointId: older.shot.id,
        actionId: randomUUID(),
      });
      expect(res.decided).toHaveLength(2);

      expect(await stampedAfter(newer.run.id, older.run.id)).toBe(true);
      const resolved = await resolvedBaseline();
      expect(resolved.testRunId).toBe(newer.run.id);
      expect(resolved.baselineName).toBe(newer.shot.imageKey);
      expect(await variationBaselineName()).toBe(newer.shot.imageKey);
    });

    test("rows already tied on created_at resolve deterministically by id", async () => {
      // Baselines written by one transaction before baselineWriteTime share
      // created_at. Inserted low-id first so a tie left to scan order would
      // resolve the low id.
      const buildId = await newBuild();
      const a = await seedVariationRun(buildId, {
        label: "tie-a",
        createdAt: new Date(),
        status: "passed",
      });
      const b = await seedVariationRun(buildId, {
        label: "tie-b",
        createdAt: new Date(),
        status: "passed",
      });
      const lowId = "00000000-0000-4000-8000-000000000001";
      const highId = "ffffffff-ffff-4fff-bfff-ffffffffffff";
      await h.db.transaction(async (tx) => {
        for (const [id, cp] of [
          [lowId, a],
          [highId, b],
        ] as const) {
          await tx.insert(baselines).values({
            id,
            baselineName: cp.shot.imageKey,
            testVariationId: s.variationId,
            testRunId: cp.run.id,
            branchName: "feature/x",
          });
        }
      });

      expect((await resolvedBaseline()).id).toBe(highId);
    });
  });

  // ---------------------------------------------------------------------------
  // ADR-067: every approve path promotes every checkpoint through one core,
  // keeps reviewer-saved ignore regions, and is audited.
  // ---------------------------------------------------------------------------

  /**
   * Give `runId` one checkpoint per name, each on its own variation, with
   * strictly increasing createdAt so "first checkpoint" is deterministic.
   */
  async function addCheckpoints(
    runId: string,
    names: string[],
    opts: {
      ignoreRegions?: (name: string) => unknown;
      /** Defaults to `unresolved`: diffed and pending (approvable). */
      verdict?: CheckpointVerdict;
    } = {},
  ) {
    const base = Date.now() - 60_000;
    const out: Array<{
      shotId: string;
      variationId: string;
      imageKey: string;
    }> = [];
    for (const [i, name] of names.entries()) {
      const [v] = await h.db
        .insert(testVariations)
        .values({ name, projectId: s.projectId, branchName: "feature/x" })
        .returning();
      const imageKey = `${name}-${runId.slice(0, 8)}`.padEnd(64, "k");
      const [shot] = await h.db
        .insert(screenshots)
        .values({
          runId,
          projectId: s.projectId,
          testVariationId: v!.id,
          name,
          viewport: "1280x720",
          browser: "chromium",
          imageKey,
          ignoreRegions: opts.ignoreRegions?.(name),
          verdict: opts.verdict ?? "unresolved",
          createdAt: new Date(base + i * 1000),
        })
        .returning();
      out.push({ shotId: shot!.id, variationId: v!.id, imageKey });
    }
    return out;
  }

  async function variationRow(id: string) {
    const [v] = await h.db
      .select()
      .from(testVariations)
      .where(eq(testVariations.id, id))
      .limit(1);
    return v!;
  }

  const savedRegion = {
    x: 5,
    y: 6,
    width: 70,
    height: 80,
    viewport: "1280x720",
    paddingPx: 0,
    kind: "ignore",
  };

  describe("run-level approve promotes every checkpoint (ADR-067)", () => {
    test.each(["review.approve", "inbox.approve"] as const)(
      "%s promotes the baseline of every checkpoint in a multi-checkpoint run",
      async (path) => {
        const cps = await addCheckpoints(s.runId, ["cp-a", "cp-b", "cp-c"]);
        const client = makeClient(baseUrl, s.memberJwt);
        if (path === "review.approve") {
          await client.review.approve.mutate({
            runId: s.runId,
            actionId: randomUUID(),
          });
        } else {
          await client.inbox.approve.mutate({ runId: s.runId });
        }

        const rows = await h.db
          .select()
          .from(baselines)
          .where(eq(baselines.testRunId, s.runId));
        expect(new Set(rows.map((r) => r.testVariationId))).toEqual(
          new Set(cps.map((c) => c.variationId)),
        );
        for (const c of cps) {
          const v = await variationRow(c.variationId);
          expect(v.baselineName).toBe(c.imageKey);
        }
      },
    );

    test("review.approveBuild promotes every checkpoint of every run in the build", async () => {
      const buildId = await getSeedBuildId(h, s.runId);
      const [run2] = await h.db
        .insert(testRuns)
        .values({
          buildId,
          projectId: s.projectId,
          status: "unresolved",
          name: "second test",
          branchName: "feature/x",
        })
        .returning();
      const cps = [
        ...(await addCheckpoints(s.runId, ["r1-a", "r1-b"])),
        ...(await addCheckpoints(run2!.id, ["r2-a", "r2-b"])),
      ];

      const client = makeClient(baseUrl, s.memberJwt);
      const res = await client.review.approveBuild.mutate({
        buildId,
        actionId: randomUUID(),
        expectedCount: 4,
      });
      expect(res.decided).toHaveLength(4);

      const rows = await h.db.select().from(baselines);
      expect(new Set(rows.map((r) => r.testVariationId))).toEqual(
        new Set(cps.map((c) => c.variationId)),
      );
      for (const c of cps) {
        expect((await variationRow(c.variationId)).baselineName).toBe(
          c.imageKey,
        );
      }
    });
  });

  describe("the pre-decision procedures are removed (ADR-067)", () => {
    // Decisions go through `review.*` (plus the SDK's REST approve and the
    // inbox); `runs` has no approve or reject procedure left.
    test.each([
      "approve",
      "approveCheckpoint",
      "approveAllCheckpoints",
      "bulkApproveByBuild",
      "bulkApproveByVariation",
      "reject",
      "approveCheckpointGroup",
      "rejectCheckpointGroup",
    ] as const)("runs.%s is gone and approves nothing", async (procedure) => {
      // A reviewer-actionable run elsewhere in the project — an old bulk
      // procedure approved it even though it shares no variation with the seed.
      const buildId = await getSeedBuildId(h, s.runId);
      const [other] = await h.db
        .insert(testRuns)
        .values({
          buildId,
          projectId: s.projectId,
          status: "unresolved",
          name: "unrelated test",
          branchName: "feature/x",
        })
        .returning();

      const res = await fetch(`${baseUrl}/trpc/runs.${procedure}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${s.memberJwt}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ runId: s.runId, buildId }),
      });
      expect(res.status).toBe(404);

      const runs = await h.db
        .select({ id: testRuns.id, status: testRuns.status })
        .from(testRuns);
      for (const r of runs) expect(r.status).toBe("unresolved");
      expect(runs.map((r) => r.id)).toContain(other!.id);
      expect(
        await h.db
          .select()
          .from(checkpointDecisions)
          .where(inArray(checkpointDecisions.runId, [s.runId, other!.id])),
      ).toHaveLength(0);
    });
  });

  describe("approve keeps reviewer-saved ignore regions (ADR-067)", () => {
    const sdkRegion = { x: 1, y: 2, width: 10, height: 20 };

    test("approving one checkpoint without an override keeps saved regions and adds the SDK-captured ones once", async () => {
      const [cp] = await addCheckpoints(s.runId, ["keep"], {
        // Captured twice (duplicate in the SDK payload) — stored once.
        ignoreRegions: () => [sdkRegion, sdkRegion],
      });
      await h.db
        .update(testVariations)
        .set({ ignoreRegions: [savedRegion] })
        .where(eq(testVariations.id, cp!.variationId));

      const client = makeClient(baseUrl, s.memberJwt);
      await client.review.approve.mutate({
        runId: s.runId,
        actionId: randomUUID(),
        checkpointIds: [cp!.shotId],
      });

      const v = await variationRow(cp!.variationId);
      expect(v.ignoreRegions).toEqual([
        savedRegion,
        { ...sdkRegion, source: "sdk" },
      ]);
    });

    test("re-approving replaces the previously promoted SDK regions instead of accumulating them", async () => {
      const [cp] = await addCheckpoints(s.runId, ["moving"], {
        ignoreRegions: () => [{ x: 300, y: 40, width: 120, height: 30 }],
      });
      // State after an earlier approve: a saved region + the SDK region the
      // previous capture promoted (e.g. a caret box that has since moved).
      await h.db
        .update(testVariations)
        .set({ ignoreRegions: [savedRegion, { ...sdkRegion, source: "sdk" }] })
        .where(eq(testVariations.id, cp!.variationId));

      const client = makeClient(baseUrl, s.memberJwt);
      await client.review.approve.mutate({
        runId: s.runId,
        actionId: randomUUID(),
        checkpointIds: [cp!.shotId],
      });

      const v = await variationRow(cp!.variationId);
      expect(v.ignoreRegions).toEqual([
        savedRegion,
        { x: 300, y: 40, width: 120, height: 30, source: "sdk" },
      ]);
    });

    test("approving a whole run keeps each variation's saved regions", async () => {
      const cps = await addCheckpoints(s.runId, ["all-a", "all-b"]);
      for (const c of cps) {
        await h.db
          .update(testVariations)
          .set({ ignoreRegions: [savedRegion] })
          .where(eq(testVariations.id, c.variationId));
      }

      const client = makeClient(baseUrl, s.memberJwt);
      await client.review.approve.mutate({
        runId: s.runId,
        actionId: randomUUID(),
      });

      for (const c of cps) {
        expect((await variationRow(c.variationId)).ignoreRegions).toEqual([
          savedRegion,
        ]);
      }
    });

    test("approving a group keeps the group's saved regions", async () => {
      const buildId = await getSeedBuildId(h, s.runId);
      const a = await seedCheckpoint(h, {
        buildId,
        projectId: s.projectId,
        name: "grp-a",
        signature: SIG,
        unresolved: true,
      });
      await h.db
        .update(testVariations)
        .set({ ignoreRegions: [savedRegion] })
        .where(eq(testVariations.id, a.variation.id));

      const client = makeClient(baseUrl, s.memberJwt);
      const res = await client.review.approveGroup.mutate({
        runId: a.run.id,
        checkpointId: a.shot.id,
        actionId: randomUUID(),
      });
      expect(res.decided).toHaveLength(1);

      expect((await variationRow(a.variation.id)).ignoreRegions).toEqual([
        savedRegion,
      ]);
    });
  });

  describe("review mutations are audited (ADR-067)", () => {
    async function auditRows(action: string) {
      return h.db.select().from(auditLog).where(eq(auditLog.action, action));
    }

    // The decision paths are audited with the decision core and the `review.*`
    // suites (review-decide.test.ts, trpc-review.test.ts): one
    // `run.approve_checkpoints` / `run.reject_checkpoints` row per run, and one
    // `run.approve_build` / `run.approve_group` / `run.reject_group` row per
    // build action. The mutations below write their own.
    test("overrideStatus → run.override_status", async () => {
      const client = makeClient(baseUrl, s.memberJwt);
      await client.runs.overrideStatus.mutate({
        runId: s.runId,
        status: "passed",
      });

      const [row] = await auditRows("run.override_status");
      expect(row).toMatchObject({ targetType: "run", targetId: s.runId });
      expect(row?.metadata).toMatchObject({
        projectId: s.projectId,
        from: "unresolved",
        to: "passed",
        requested: "passed",
      });
    });

    test("inbox.reject → run.reviewer_reject", async () => {
      const client = makeClient(baseUrl, s.memberJwt);
      await client.inbox.reject.mutate({ runId: s.runId, reason: "flaky" });

      const [row] = await auditRows("run.reviewer_reject");
      expect(row).toMatchObject({
        actorId: s.memberId,
        targetType: "run",
        targetId: s.runId,
      });
      expect(row?.metadata).toMatchObject({
        projectId: s.projectId,
        reason: "flaky",
      });
    });
  });

  /** The approve surfaces that decide through the core with a project gate. */
  const APPROVE_VIA = [
    "review.approve (whole run)",
    "review.approve (one checkpoint)",
    "inbox.approve",
  ] as const;
  type ApproveVia = (typeof APPROVE_VIA)[number];

  describe("approve paths: best-effort audit and run-status legality", () => {
    /** Approve `cp` the way `via` does, with the member's client. */
    function approveVia(
      via: ApproveVia,
      cp: { run: { id: string }; shot: { id: string } },
    ) {
      const client = makeClient(baseUrl, s.memberJwt);
      if (via === "inbox.approve")
        return client.inbox.approve.mutate({ runId: cp.run.id });
      return client.review.approve.mutate({
        runId: cp.run.id,
        actionId: randomUUID(),
        ...(via === "review.approve (one checkpoint)"
          ? { checkpointIds: [cp.shot.id] }
          : {}),
      });
    }

    test.each(APPROVE_VIA)(
      "%s: a failing audit write doesn't undo the approval",
      async (procedure) => {
        const cp = await seedCheckpoint(h, {
          buildId: await getSeedBuildId(h, s.runId),
          projectId: s.projectId,
          name: `audit-down-${procedure}`,
          signature: null,
          unresolved: true,
          baselineName: null,
        });
        // Fault injection: every audit_log insert fails at the DB level, as it
        // would on a full disk or a bad column value. The insert runs on the
        // procedure's request transaction (ADR-058).
        await h.db.execute(sql`
          CREATE FUNCTION test_audit_unavailable() RETURNS trigger
          LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$`);
        await h.db.execute(sql`
          CREATE TRIGGER test_audit_unavailable BEFORE INSERT ON audit_log
          FOR EACH ROW EXECUTE FUNCTION test_audit_unavailable()`);
        try {
          await approveVia(procedure, cp);
        } finally {
          await h.db.execute(
            sql`DROP TRIGGER IF EXISTS test_audit_unavailable ON audit_log`,
          );
          await h.db.execute(
            sql`DROP FUNCTION IF EXISTS test_audit_unavailable()`,
          );
        }

        const [run] = await h.db
          .select()
          .from(testRuns)
          .where(eq(testRuns.id, cp.run.id));
        expect(run!.status).toBe("passed");
        const bl = await h.db
          .select()
          .from(baselines)
          .where(eq(baselines.testRunId, cp.run.id));
        expect(bl.map((b) => b.userId)).toEqual([s.memberId]);
      },
    );

    test.each(
      APPROVE_VIA.filter((via) => via !== "review.approve (whole run)"),
    )(
      "%s: rejects a run that isn't reviewable (running / aborted / empty)",
      async (procedure) => {
        // Was BAD_REQUEST (assertApprovable, #437). The decision core's
        // `not_reviewable` refusal covers the same states, as
        // PRECONDITION_FAILED.
        for (const status of ["running", "aborted", "empty"] as const) {
          const cp = await seedCheckpoint(h, {
            buildId: await getSeedBuildId(h, s.runId),
            projectId: s.projectId,
            name: `illegal-${status}`,
            signature: null,
            unresolved: true,
            baselineName: null,
          });
          await h.db
            .update(testRuns)
            .set({ status })
            .where(eq(testRuns.id, cp.run.id));

          const err = await approveVia(procedure, cp).catch((e) => e);
          expect(err?.data?.code).toBe("PRECONDITION_FAILED");
          expect(err?.message).toBe("not_reviewable");

          const [run] = await h.db
            .select()
            .from(testRuns)
            .where(eq(testRuns.id, cp.run.id));
          expect(run!.status).toBe(status);
          const bl = await h.db
            .select()
            .from(baselines)
            .where(eq(baselines.testRunId, cp.run.id));
          expect(bl).toHaveLength(0);
        }
      },
    );

    test("review.approve of a whole run that isn't reviewable decides nothing (pending is empty)", async () => {
      // No ids means "every pending checkpoint", and a run that isn't
      // reviewable has none: an empty success, not a refusal.
      for (const status of ["running", "aborted", "empty"] as const) {
        const cp = await seedCheckpoint(h, {
          buildId: await getSeedBuildId(h, s.runId),
          projectId: s.projectId,
          name: `whole-run-${status}`,
          signature: null,
          unresolved: true,
          baselineName: null,
        });
        await h.db
          .update(testRuns)
          .set({ status })
          .where(eq(testRuns.id, cp.run.id));

        const res = await makeClient(
          baseUrl,
          s.memberJwt,
        ).review.approve.mutate({
          runId: cp.run.id,
          actionId: randomUUID(),
        });
        expect(res.decided).toEqual([]);

        const [run] = await h.db
          .select()
          .from(testRuns)
          .where(eq(testRuns.id, cp.run.id));
        expect(run!.status).toBe(status);
        expect(
          await h.db
            .select()
            .from(baselines)
            .where(eq(baselines.testRunId, cp.run.id)),
        ).toHaveLength(0);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Run mutations on multi-checkpoint runs (the review fixtures): the override
  // is stored beside the rollup, ignore areas and re-diffs act per checkpoint.
  // ---------------------------------------------------------------------------

  describe("run mutations on multi-checkpoint runs (spec §5.7)", () => {
    const seeds: ReviewSeed[] = [];
    afterAll(async () => {
      await cleanupReviewSeeds(h, seeds);
    });

    async function reviewSeed(spec: ReviewRunSpec): Promise<ReviewSeed> {
      const rs = await seedReviewRun(h, spec);
      seeds.push(rs);
      return rs;
    }

    const as = (u: ReviewUser) => makeClient(baseUrl, u.jwt);

    async function runRow(runId: string) {
      const [r] = await h.db
        .select()
        .from(testRuns)
        .where(eq(testRuns.id, runId));
      return r!;
    }

    /** The refusal a tRPC call came back with (over HTTP, so `details` is set). */
    async function refusal(p: Promise<unknown>) {
      const e = await p.then(
        () => {
          throw new Error("expected the call to be refused");
        },
        (err: unknown) => err,
      );
      expect(e).toBeInstanceOf(TRPCClientError);
      const err = e as TRPCClientError<AppRouter>;
      const data = err.data as
        { code?: string; details?: ReviewErrorDetails } | undefined;
      return { code: data?.code, message: err.message, details: data?.details };
    }

    describe("overrideStatus writes status_override", () => {
      test("an override survives a re-diff; 'default' clears it and restores the rollup", async () => {
        const rs = await reviewSeed({
          checkpoints: [
            { name: "a", verdict: "unresolved", withBaseline: true },
          ],
        });
        const c = as(rs.editor);
        expect(
          await c.runs.overrideStatus.mutate({
            runId: rs.runId,
            status: "failed",
          }),
        ).toEqual({ runId: rs.runId, status: "failed" });
        expect(await runRow(rs.runId)).toMatchObject({
          status: "failed",
          statusOverride: "failed",
        });

        // A re-diff (ignore-region / threshold edit): the diff-worker rewrites
        // the verdict and recomputes. The reviewer's override wins.
        await h.db
          .update(screenshots)
          .set({ verdict: "passed", verdictAt: new Date() })
          .where(eq(screenshots.id, rs.shots.a!.id));
        await recomputeRunStatus(h.db, rs.runId);
        expect((await runRow(rs.runId)).status).toBe("failed");

        expect(
          await c.runs.overrideStatus.mutate({
            runId: rs.runId,
            status: "default",
          }),
        ).toEqual({ runId: rs.runId, status: "passed" });
        expect(await runRow(rs.runId)).toMatchObject({
          status: "passed",
          statusOverride: null,
        });

        const audit = await h.db
          .select()
          .from(auditLog)
          .where(
            and(
              eq(auditLog.action, "run.override_status"),
              eq(auditLog.targetId, rs.runId),
            ),
          )
          .orderBy(asc(auditLog.createdAt));
        expect(audit.map((a) => a.metadata)).toMatchObject([
          { from: "unresolved", to: "failed", requested: "failed" },
          { from: "failed", to: "passed", requested: "default" },
        ]);
      });
    });

    describe("ignore areas target the selected checkpoint's variation", () => {
      const region = {
        x: 10,
        y: 20,
        width: 30,
        height: 40,
        viewport: "1280x720",
        paddingPx: 0,
        kind: "ignore" as const,
      };

      async function regionsOf(variationId: string) {
        const [v] = await h.db
          .select({ ignoreRegions: testVariations.ignoreRegions })
          .from(testVariations)
          .where(eq(testVariations.id, variationId));
        return v!.ignoreRegions;
      }

      test("setIgnoreAreas({ checkpointId: cart }) writes cart's variation, not home's", async () => {
        const rs = await reviewSeed({
          checkpoints: [
            { name: "home", verdict: "unresolved" },
            { name: "cart", verdict: "unresolved" },
          ],
        });
        await as(rs.editor).runs.setIgnoreAreas.mutate({
          runId: rs.runId,
          scope: "variation",
          checkpointId: rs.shots.cart!.id,
          ignoreAreas: [region],
        });
        expect(await regionsOf(rs.shots.cart!.variationId)).toEqual([region]);
        expect(await regionsOf(rs.shots.home!.variationId)).toBeNull();
      });

      test("without checkpointId, old clients still write the first checkpoint's variation", async () => {
        const rs = await reviewSeed({
          checkpoints: [
            { name: "home", verdict: "unresolved" },
            { name: "cart", verdict: "unresolved" },
          ],
        });
        await as(rs.editor).runs.setIgnoreAreas.mutate({
          runId: rs.runId,
          scope: "run",
          ignoreAreas: [region],
        });
        expect(await regionsOf(rs.shots.home!.variationId)).toEqual([region]);
        expect(await regionsOf(rs.shots.cart!.variationId)).toBeNull();
      });

      test("addIgnoreAreas({ checkpointId: cart }) appends to cart's variation", async () => {
        const rs = await reviewSeed({
          checkpoints: [
            { name: "home", verdict: "unresolved" },
            { name: "cart", verdict: "unresolved" },
          ],
        });
        const c = as(rs.editor);
        await c.runs.setIgnoreAreas.mutate({
          runId: rs.runId,
          scope: "variation",
          checkpointId: rs.shots.cart!.id,
          ignoreAreas: [region],
        });
        const second = { ...region, x: 200 };
        const res = await c.runs.addIgnoreAreas.mutate({
          runId: rs.runId,
          scope: "variation",
          checkpointId: rs.shots.cart!.id,
          ignoreAreas: [second],
        });
        expect(res.total).toBe(2);
        expect(await regionsOf(rs.shots.cart!.variationId)).toEqual([
          region,
          second,
        ]);
        expect(await regionsOf(rs.shots.home!.variationId)).toBeNull();
      });

      test.each(["setIgnoreAreas", "addIgnoreAreas"] as const)(
        "%s refuses a checkpoint of another run with BAD_REQUEST",
        async (procedure) => {
          const rs = await reviewSeed({
            checkpoints: [{ name: "home", verdict: "unresolved" }],
          });
          const other = await addReviewRun(h, rs, {
            checkpoints: [{ name: "elsewhere", verdict: "unresolved" }],
          });
          h.diffQueueAdd.mockClear();
          const input = {
            runId: rs.runId,
            scope: "variation" as const,
            checkpointId: other.shots.elsewhere!.id,
            ignoreAreas: [region],
          };
          const c = as(rs.editor);
          const r = await refusal(
            procedure === "setIgnoreAreas"
              ? c.runs.setIgnoreAreas.mutate(input)
              : c.runs.addIgnoreAreas.mutate(input),
          );
          expect(r.code).toBe("BAD_REQUEST");
          expect(
            await regionsOf(other.shots.elsewhere!.variationId),
          ).toBeNull();
          expect(h.diffQueueAdd).not.toHaveBeenCalled();
        },
      );
    });

    // Each re-diffing procedure is counted under its own trigger.
    const REDIFF_TRIGGER = {
      setIgnoreAreas: "ignore_areas",
      setTempIgnoreAreas: "temp_ignore_areas",
      addIgnoreAreas: "ignore_areas",
      setDiffThresholdOverride: "threshold",
    } as const;

    test.each([
      "setIgnoreAreas",
      "setTempIgnoreAreas",
      "addIgnoreAreas",
      "setDiffThresholdOverride",
    ] as const)(
      "%s re-diffs with the run's parentPrBaseBranch (ADR-055)",
      async (procedure) => {
        const trigger = REDIFF_TRIGGER[procedure];
        const enqueuedBefore = await diffJobsEnqueued(
          h.app.telemetry.metrics,
          trigger,
        );
        const rs = await reviewSeed({
          checkpoints: [{ name: "home", verdict: "unresolved" }],
        });
        await h.db
          .update(testRuns)
          .set({ parentBranchName: "main" })
          .where(eq(testRuns.id, rs.runId));
        const c = as(rs.editor);
        const areas = [
          {
            x: 1,
            y: 1,
            width: 5,
            height: 5,
            viewport: "1280x720",
            paddingPx: 0,
            kind: "ignore" as const,
          },
        ];
        h.diffQueueAdd.mockClear();
        if (procedure === "setIgnoreAreas") {
          await c.runs.setIgnoreAreas.mutate({
            runId: rs.runId,
            scope: "run",
            ignoreAreas: areas,
          });
        } else if (procedure === "setTempIgnoreAreas") {
          await c.runs.setTempIgnoreAreas.mutate({
            runId: rs.runId,
            tempIgnoreAreas: areas,
          });
        } else if (procedure === "addIgnoreAreas") {
          await c.runs.addIgnoreAreas.mutate({
            runId: rs.runId,
            scope: "run",
            ignoreAreas: areas,
          });
        } else {
          await c.runs.setDiffThresholdOverride.mutate({
            runId: rs.runId,
            threshold: 0.05,
          });
        }
        const step = rs.shots.home!.id;
        expect(h.diffQueueAdd).toHaveBeenCalledTimes(1);
        expect(h.diffQueueAdd).toHaveBeenCalledWith(
          "diff",
          {
            runId: rs.runId,
            projectId: rs.projectId,
            screenshotId: step,
            generation: 1,
            parentPrBaseBranch: "main",
          },
          { jobId: `${step}-g1` },
        );
        expect(await diffJobsEnqueued(h.app.telemetry.metrics, trigger)).toBe(
          enqueuedBefore + 1,
        );
      },
    );

    // Spec 2026-10-23 §7: each re-diff queues the steps it affects, each at
    // its next version, and nothing else.
    describe("each re-diff queues only the steps it affects", () => {
      const region = (viewport: string) => ({
        x: 1,
        y: 1,
        width: 5,
        height: 5,
        viewport,
        paddingPx: 0,
        kind: "ignore" as const,
      });

      /**
       * A run the per-step pipeline already diffed (every step at version
       * 1), so no legacy fan-out (Ruling R6) widens what a re-diff queues.
       */
      async function perStepSeed(spec: ReviewRunSpec): Promise<ReviewSeed> {
        const rs = await reviewSeed(spec);
        await h.db
          .update(screenshots)
          .set({ diffGeneration: 1 })
          .where(eq(screenshots.runId, rs.runId));
        h.diffQueueAdd.mockClear();
        return rs;
      }

      /** The jobs added since the last clear: `[screenshotId, generation]`. */
      const queued = () =>
        h.diffQueueAdd.mock.calls.map(([, p]) => [
          p.screenshotId,
          p.generation,
        ]);

      async function generationOf(id: string) {
        const [row] = await h.db
          .select({ generation: screenshots.diffGeneration })
          .from(screenshots)
          .where(eq(screenshots.id, id));
        return row!.generation;
      }

      test.each(["setIgnoreAreas", "addIgnoreAreas"] as const)(
        "%s queues only the step of that variation",
        async (procedure) => {
          const rs = await perStepSeed({
            checkpoints: [
              { name: "home", verdict: "unresolved" },
              { name: "cart", verdict: "unresolved" },
              { name: "login", verdict: "passed" },
            ],
          });
          const input = {
            runId: rs.runId,
            scope: "variation" as const,
            checkpointId: rs.shots.cart!.id,
            ignoreAreas: [region("1280x720")],
          };
          const c = as(rs.editor);
          await (procedure === "setIgnoreAreas"
            ? c.runs.setIgnoreAreas.mutate(input)
            : c.runs.addIgnoreAreas.mutate(input));

          expect(queued()).toEqual([[rs.shots.cart!.id, 2]]);
          expect(await generationOf(rs.shots.home!.id)).toBe(1);
          expect(await generationOf(rs.shots.login!.id)).toBe(1);
        },
      );

      test("setTempIgnoreAreas with tags 1280x720 → 375x812 queues only steps on those viewports", async () => {
        const rs = await perStepSeed({
          checkpoints: [
            { name: "home", verdict: "unresolved", viewport: "1280x720" },
            { name: "home", verdict: "unresolved", viewport: "375x812" },
            { name: "home", verdict: "unresolved", viewport: "768x1024" },
          ],
        });
        const [desktop, phone, tablet] = rs.shotsInOrder.map((x) => x.id) as [
          string,
          string,
          string,
        ];
        // The run's temp regions before the edit: tagged 1280x720.
        await h.db
          .update(testRuns)
          .set({ tempIgnoreAreas: JSON.stringify([region("1280x720")]) })
          .where(eq(testRuns.id, rs.runId));

        await as(rs.editor).runs.setTempIgnoreAreas.mutate({
          runId: rs.runId,
          tempIgnoreAreas: [region("375x812")],
        });

        // The old tag's step loses its mask, the new tag's step gains one.
        expect(queued()).toEqual([
          [desktop, 2],
          [phone, 2],
        ]);
        expect(await generationOf(tablet)).toBe(1);
      });

      test("setTempIgnoreAreas with an untagged region queues every step", async () => {
        const rs = await perStepSeed({
          checkpoints: [
            { name: "home", verdict: "unresolved", viewport: "1280x720" },
            { name: "home", verdict: "passed", viewport: "375x812" },
            { name: "home", verdict: "unresolved", viewport: "768x1024" },
          ],
        });
        // A stored region without a viewport tag (written before tags were
        // required) applies to every step (ADR-031), so replacing it
        // changes every step's mask.
        const { viewport: _untagged, ...untagged } = region("1280x720");
        await h.db
          .update(testRuns)
          .set({ tempIgnoreAreas: JSON.stringify([untagged]) })
          .where(eq(testRuns.id, rs.runId));

        await as(rs.editor).runs.setTempIgnoreAreas.mutate({
          runId: rs.runId,
          tempIgnoreAreas: [region("375x812")],
        });

        expect(queued()).toEqual(rs.shotsInOrder.map((x) => [x.id, 2]));
      });

      test("setTempIgnoreAreas from no regions to none queues nothing", async () => {
        const rs = await perStepSeed({
          checkpoints: [{ name: "home", verdict: "unresolved" }],
        });
        const c = as(rs.editor);

        await c.runs.setTempIgnoreAreas.mutate({
          runId: rs.runId,
          tempIgnoreAreas: [],
        });
        await c.runs.setTempIgnoreAreas.mutate({
          runId: rs.runId,
          tempIgnoreAreas: null,
        });

        expect(h.diffQueueAdd).not.toHaveBeenCalled();
        expect(await generationOf(rs.shots.home!.id)).toBe(1);
      });

      test("setDiffThresholdOverride queues every step except new ones", async () => {
        const rs = await perStepSeed({
          checkpoints: [
            { name: "home", verdict: "unresolved" },
            { name: "fresh", verdict: "new" },
            { name: "cart", verdict: "passed" },
            { name: "waiting", verdict: null },
            { name: "broken", verdict: "unresolved" },
          ],
        });
        // A failed step: its verdict is `unresolved`, with the failure set.
        await h.db
          .update(screenshots)
          .set({ diffFailedAt: new Date(), diffError: "engine_error" })
          .where(eq(screenshots.id, rs.shots.broken!.id));

        await as(rs.editor).runs.setDiffThresholdOverride.mutate({
          runId: rs.runId,
          threshold: 0.05,
        });

        // No baseline, no threshold: a `new` step's result can't change.
        expect(queued()).toEqual(
          ["home", "cart", "waiting", "broken"].map((n) => [
            rs.shots[n]!.id,
            2,
          ]),
        );
        expect(await generationOf(rs.shots.fresh!.id)).toBe(1);
      });
    });
  });
});
