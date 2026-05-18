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
      status: "new",
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

d("tRPC runs router", () => {
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
        buildId: (
          await h.db
            .select({ buildId: testRuns.buildId })
            .from(testRuns)
            .where(eq(testRuns.id, s.runId))
            .limit(1)
        )[0]!.buildId,
        projectId: s.projectId,
        testVariationId: s.variationId,
        status: "ok",
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

  test("approve: flips merge=true and inserts a baseline row", async () => {
    const client = makeClient(baseUrl, s.memberJwt);
    const res = await client.runs.approve.mutate({ runId: s.runId });
    expect(res).toEqual({ runId: s.runId, approved: true });

    const updatedRows = await h.db
      .select()
      .from(testRuns)
      .where(eq(testRuns.id, s.runId))
      .limit(1);
    expect(updatedRows[0]?.merge).toBe(true);

    const baselineRows = await h.db
      .select()
      .from(baselines)
      .where(eq(baselines.testRunId, s.runId));
    expect(baselineRows.length).toBe(1);
    expect(baselineRows[0]?.branchName).toBe("feature/x");
    expect(baselineRows[0]?.userId).toBe(s.memberId);
  });

  test("reject: flips merge=false (and does NOT insert a baseline)", async () => {
    // First approve to flip it to true, then reject to ensure flip works.
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

  // ADR-031: per-run ignore-regions editor + re-diff trigger.
  describe("setIgnoreAreas", () => {
    const VP = "1280x720";
    const validRegion = { x: 10, y: 20, width: 30, height: 40, viewport: VP };

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
  });
});
