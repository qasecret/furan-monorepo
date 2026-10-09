import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";

import {
  asc,
  auditLog,
  checkpointDecisions,
  createDb,
  eq,
  inArray,
  screenshots,
  sql,
  testRuns,
  testVariations,
} from "@furan/db";
import type {
  ApproveBuildPreview,
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

import { decideCheckpoints } from "../src/lib/review/decide.js";
import { lockRuns } from "../src/lib/review/targets.js";
import {
  GROUP_APPROVE_CAP,
  groupScope,
} from "../src/trpc/v1/checkpoint-grouping.js";
import { APPROVE_BUILD_CAP } from "../src/trpc/v1/review.js";
import type { AppRouter } from "../src/trpc/v1/router.js";

import { createTestApp, type TestApp } from "./helpers.js";
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
type Client = ReturnType<typeof makeClient>;

/**
 * The refusal an HTTP call came back with. Asserted over the wire: tRPC's
 * `createCaller` skips the errorFormatter, so only HTTP shows `data.details`.
 */
async function failure(p: Promise<unknown>): Promise<{
  code: string;
  message: string;
  details: ReviewErrorDetails | undefined;
}> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(TRPCClientError);
    const err = e as TRPCClientError<AppRouter>;
    const data = err.data as
      { code?: string; details?: ReviewErrorDetails } | undefined;
    return {
      code: data?.code ?? "",
      message: err.message,
      details: data?.details,
    };
  }
  throw new Error("expected the call to be refused");
}

const newAction = () => randomUUID();
const quietLogger = { info: () => undefined, error: () => undefined };

describe("groupScope", () => {
  const seed = {
    id: randomUUID(),
    runId: randomUUID(),
    buildId: randomUUID(),
    projectId: randomUUID(),
    diffSignature: "sig",
  };

  test("pins the project the caller resolved, not the seed row's (R18/R20)", () => {
    const resolved = randomUUID();
    expect(groupScope(seed, resolved)).toEqual({
      projectId: resolved,
      buildId: seed.buildId,
      diffSignature: "sig",
    });
  });

  test("a seed without a diff signature has no group", () => {
    expect(groupScope({ ...seed, diffSignature: null }, seed.projectId)).toBe(
      null,
    );
  });
});

d("review router", () => {
  let h: TestApp;
  let baseUrl: string;
  const seeds: ReviewSeed[] = [];

  const as = (u: ReviewUser | null): Client =>
    makeClient(baseUrl, u?.jwt ?? undefined);

  async function seed(spec: ReviewRunSpec): Promise<ReviewSeed> {
    const s = await seedReviewRun(h, spec);
    seeds.push(s);
    return s;
  }

  async function setSignature(ids: string[], sig: string): Promise<void> {
    await h.db
      .update(screenshots)
      .set({ diffSignature: sig })
      .where(inArray(screenshots.id, ids));
  }

  /** A run whose two unresolved checkpoints share one diff signature. */
  async function seedGroup(): Promise<ReviewSeed> {
    const s = await seed({
      checkpoints: [
        { name: "a", verdict: "unresolved", withBaseline: true },
        { name: "b", verdict: "unresolved", withBaseline: true },
      ],
    });
    await setSignature([s.shots.a!.id, s.shots.b!.id], `sig-${s.tag}`);
    return s;
  }

  const decisionsOfRun = (runId: string) =>
    h.db
      .select()
      .from(checkpointDecisions)
      .where(eq(checkpointDecisions.runId, runId))
      .orderBy(asc(checkpointDecisions.createdAt), asc(checkpointDecisions.id));

  const decisionsOfAction = (actionId: string) =>
    h.db
      .select()
      .from(checkpointDecisions)
      .where(eq(checkpointDecisions.actionId, actionId))
      .orderBy(asc(checkpointDecisions.createdAt), asc(checkpointDecisions.id));

  async function runStatus(runId: string): Promise<string> {
    const [r] = await h.db
      .select({ status: testRuns.status })
      .from(testRuns)
      .where(eq(testRuns.id, runId));
    return r!.status;
  }

  const auditOf = (targetId: string) =>
    h.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.targetId, targetId))
      .orderBy(asc(auditLog.createdAt));

  /** Rejects checkpoint `name` of `s` through the router (to set a scene up). */
  async function rejectShot(s: ReviewSeed, runId: string, shotId: string) {
    await as(s.editor).review.reject.mutate({
      runId,
      actionId: newAction(),
      checkpointIds: [shotId],
    });
  }

  /**
   * Adds `n` pending (`new`) checkpoints to `s`'s run with ONE variation insert
   * and ONE screenshot insert (no test hook in production code: the cap is the
   * real 500). Capture times ascend with the index, so the capture order is the
   * index order. Returns the checkpoint ids in capture order.
   */
  async function bulkPending(
    s: ReviewSeed,
    n: number,
    opts: { signature?: string; runId?: string } = {},
  ): Promise<string[]> {
    const runId = opts.runId ?? s.runId;
    const variations = await h.db
      .insert(testVariations)
      .values(
        Array.from({ length: n }, (_, i) => ({
          projectId: s.projectId,
          name: `bulk-${s.tag}-${i}`,
          branchName: "feature/review",
          browser: "chromium",
          viewport: "1280x720",
        })),
      )
      .returning({ id: testVariations.id, name: testVariations.name });
    const variationByName = new Map(variations.map((v) => [v.name, v.id]));
    const origin = Date.now() - 1_200_000;
    const rows = await h.db
      .insert(screenshots)
      .values(
        Array.from({ length: n }, (_, i) => ({
          runId,
          projectId: s.projectId,
          testVariationId: variationByName.get(`bulk-${s.tag}-${i}`)!,
          name: `bulk-${i}`,
          viewport: "1280x720",
          browser: "chromium",
          imageKey: `bulk-${i}-${randomUUID()}.png`,
          verdict: "new" as const,
          verdictAt: new Date(origin + i * 1_000),
          createdAt: new Date(origin + i * 1_000),
          ...(opts.signature ? { diffSignature: opts.signature } : {}),
        })),
      )
      .returning({ id: screenshots.id, name: screenshots.name });
    const index = (name: string) => Number(name.slice("bulk-".length));
    return rows.sort((x, y) => index(x.name) - index(y.name)).map((r) => r.id);
  }

  beforeAll(async () => {
    h = await createTestApp();
    // The app logs every refused call at error level (expected here: most
    // tests assert a refusal), which would bury real failures in stack traces.
    // Outcomes are asserted through the responses and the rows instead.
    h.app.log.level = "silent";
    await h.app.listen({ port: 0, host: "127.0.0.1" });
    baseUrl = `http://127.0.0.1:${(h.app.server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await cleanupReviewSeeds(h, seeds);
    await h.close();
  });

  beforeEach(() => {
    h.broadcasterPublish.mockReset();
    h.broadcasterPublish.mockResolvedValue(undefined);
  });

  // -------------------------------------------------------------------------
  // Gates: every procedure.
  // -------------------------------------------------------------------------

  interface GateCase {
    name: string;
    seed: () => Promise<ReviewSeed>;
    call: (c: Client, s: ReviewSeed) => Promise<unknown>;
    callUnknown: (c: Client) => Promise<unknown>;
  }
  const twoPending = () =>
    seed({
      checkpoints: [
        { name: "a", verdict: "unresolved", withBaseline: true },
        { name: "b", verdict: "new" },
      ],
    });
  const gateCases: GateCase[] = [
    {
      name: "approve",
      seed: twoPending,
      call: (c, s) =>
        c.review.approve.mutate({ runId: s.runId, actionId: newAction() }),
      callUnknown: (c) =>
        c.review.approve.mutate({ runId: randomUUID(), actionId: newAction() }),
    },
    {
      name: "reject",
      seed: twoPending,
      call: (c, s) =>
        c.review.reject.mutate({ runId: s.runId, actionId: newAction() }),
      callUnknown: (c) =>
        c.review.reject.mutate({ runId: randomUUID(), actionId: newAction() }),
    },
    {
      name: "approveGroup",
      seed: seedGroup,
      call: (c, s) =>
        c.review.approveGroup.mutate({
          runId: s.runId,
          checkpointId: s.shots.a!.id,
          actionId: newAction(),
        }),
      callUnknown: (c) =>
        c.review.approveGroup.mutate({
          runId: randomUUID(),
          checkpointId: randomUUID(),
          actionId: newAction(),
        }),
    },
    {
      name: "rejectGroup",
      seed: seedGroup,
      call: (c, s) =>
        c.review.rejectGroup.mutate({
          runId: s.runId,
          checkpointId: s.shots.a!.id,
          actionId: newAction(),
        }),
      callUnknown: (c) =>
        c.review.rejectGroup.mutate({
          runId: randomUUID(),
          checkpointId: randomUUID(),
          actionId: newAction(),
        }),
    },
    {
      name: "previewApproveBuild",
      seed: twoPending,
      call: (c, s) =>
        c.review.previewApproveBuild.query({ buildId: s.buildId }),
      callUnknown: (c) =>
        c.review.previewApproveBuild.query({ buildId: randomUUID() }),
    },
    {
      name: "approveBuild",
      seed: twoPending,
      call: (c, s) =>
        c.review.approveBuild.mutate({
          buildId: s.buildId,
          actionId: newAction(),
          expectedCount: 2,
        }),
      callUnknown: (c) =>
        c.review.approveBuild.mutate({
          buildId: randomUUID(),
          actionId: newAction(),
          expectedCount: 0,
        }),
    },
  ];

  describe.each(gateCases)("$name gate", (g) => {
    test("a project member (editor) is allowed", async () => {
      const s = await g.seed();
      await expect(g.call(as(s.editor), s)).resolves.toBeDefined();
    });

    test("an admin who is not a member is allowed", async () => {
      const s = await g.seed();
      await expect(g.call(as(s.admin), s)).resolves.toBeDefined();
    });

    test("an outsider is FORBIDDEN and nothing is written", async () => {
      const s = await g.seed();
      const f = await failure(g.call(as(s.outsider), s));
      expect(f.code).toBe("FORBIDDEN");
      expect(await decisionsOfRun(s.runId)).toHaveLength(0);
      expect(h.broadcasterPublish).not.toHaveBeenCalled();
    });

    test("a guest member is FORBIDDEN and nothing is written", async () => {
      const s = await g.seed();
      const f = await failure(g.call(as(s.guest), s));
      expect(f.code).toBe("FORBIDDEN");
      expect(await decisionsOfRun(s.runId)).toHaveLength(0);
    });

    test("an unknown id is NOT_FOUND for a member and for an admin", async () => {
      const s = await g.seed();
      expect((await failure(g.callUnknown(as(s.editor)))).code).toBe(
        "NOT_FOUND",
      );
      expect((await failure(g.callUnknown(as(s.admin)))).code).toBe(
        "NOT_FOUND",
      );
    });

    test("an anonymous caller is UNAUTHORIZED", async () => {
      const s = await g.seed();
      expect((await failure(g.call(as(null), s))).code).toBe("UNAUTHORIZED");
    });
  });

  // -------------------------------------------------------------------------
  // Input validation.
  // -------------------------------------------------------------------------

  describe("input validation", () => {
    test("rejects malformed input as BAD_REQUEST", async () => {
      const s = await twoPending();
      const c = as(s.editor);
      const base = { runId: s.runId, actionId: newAction() };
      const region = { x: 0, y: 0, width: 1, height: 1, viewport: "1280x720" };
      const cases: Array<[string, Promise<unknown>]> = [
        [
          "actionId not a uuid",
          c.review.approve.mutate({ ...base, actionId: "x" }),
        ],
        [
          "empty checkpointIds",
          c.review.approve.mutate({ ...base, checkpointIds: [] }),
        ],
        [
          "501 checkpointIds",
          c.review.approve.mutate({
            ...base,
            checkpointIds: Array.from({ length: 501 }, () => randomUUID()),
          }),
        ],
        [
          "51 ignoreAreas",
          c.review.approve.mutate({
            ...base,
            checkpointIds: [s.shots.a!.id],
            ignoreAreas: Array.from({ length: 51 }, () => region),
          }),
        ],
        [
          "reason over 500 chars",
          c.review.reject.mutate({ ...base, reason: "x".repeat(501) }),
        ],
        [
          "negative expectedCount",
          c.review.approveBuild.mutate({
            buildId: s.buildId,
            actionId: newAction(),
            expectedCount: -1,
          }),
        ],
        [
          "fractional expectedCount",
          c.review.approveBuild.mutate({
            buildId: s.buildId,
            actionId: newAction(),
            expectedCount: 1.5,
          }),
        ],
      ];
      for (const [label, call] of cases) {
        expect([label, (await failure(call)).code]).toEqual([
          label,
          "BAD_REQUEST",
        ]);
      }
      expect(await decisionsOfRun(s.runId)).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // approve
  // -------------------------------------------------------------------------

  describe("approve", () => {
    test("without ids approves every pending checkpoint, as one action", async () => {
      const s = await seed({
        checkpoints: [
          { name: "home", verdict: "unresolved", withBaseline: true },
          { name: "cart", verdict: "new" },
          { name: "footer", verdict: "passed", withBaseline: true },
          { name: "login", verdict: "unresolved", withBaseline: true },
        ],
      });
      // `login` was rejected: not pending, left as it is.
      await rejectShot(s, s.runId, s.shots.login!.id);

      const actionId = newAction();
      const res = await as(s.editor).review.approve.mutate({
        runId: s.runId,
        actionId,
      });

      expect(res).toMatchObject({
        actionId,
        replayed: false,
        capped: false,
        cap: 500,
      });
      expect(res.decided).toEqual([
        { checkpointId: s.shots.home!.id, runId: s.runId, state: "approved" },
        { checkpointId: s.shots.cart!.id, runId: s.runId, state: "approved" },
      ]);
      expect(res.runs).toEqual([{ runId: s.runId, status: "failed" }]);

      const rows = await decisionsOfAction(actionId);
      expect(rows.map((r) => r.screenshotId)).toEqual([
        s.shots.home!.id,
        s.shots.cart!.id,
      ]);
      expect(rows.every((r) => r.source === "viewer")).toBe(true);
      expect(rows.every((r) => r.actorId === s.editor.id)).toBe(true);
      // The rejected step and the passed one have exactly what they had.
      const all = await decisionsOfRun(s.runId);
      expect(all).toHaveLength(3);
      expect(
        all.filter((r) => r.screenshotId === s.shots.login!.id),
      ).toMatchObject([{ decision: "rejected", revertedAt: null }]);
      expect(await runStatus(s.runId)).toBe("failed");
    });

    test("with explicit ids decides only those", async () => {
      const s = await twoPending();
      const res = await as(s.editor).review.approve.mutate({
        runId: s.runId,
        actionId: newAction(),
        checkpointIds: [s.shots.b!.id],
      });
      expect(res.decided.map((x) => x.checkpointId)).toEqual([s.shots.b!.id]);
      expect(res.runs).toEqual([{ runId: s.runId, status: "unresolved" }]);
      expect(res).toMatchObject({ capped: false });
    });

    test("an explicit illegal id refuses the whole call over HTTP, with a reason per checkpoint", async () => {
      const s = await seed({
        checkpoints: [
          { name: "home", verdict: "unresolved" },
          { name: "footer", verdict: "passed" },
        ],
      });
      const f = await failure(
        as(s.editor).review.approve.mutate({
          runId: s.runId,
          actionId: newAction(),
          checkpointIds: [s.shots.home!.id, s.shots.footer!.id],
        }),
      );
      expect(f.code).toBe("PRECONDITION_FAILED");
      expect(f.message).toBe("nothing_to_approve");
      expect(f.details?.reasons).toEqual([
        { checkpointId: s.shots.footer!.id, reason: "nothing_to_approve" },
      ]);
      // All or nothing, and no broadcast for a refused action.
      expect(await decisionsOfRun(s.runId)).toHaveLength(0);
      expect(h.broadcasterPublish).not.toHaveBeenCalled();
    });

    test("an already-decided id is CONFLICT already_decided with the winner", async () => {
      const s = await twoPending();
      await as(s.admin).review.approve.mutate({
        runId: s.runId,
        actionId: newAction(),
        checkpointIds: [s.shots.a!.id],
      });
      const f = await failure(
        as(s.editor).review.approve.mutate({
          runId: s.runId,
          actionId: newAction(),
          checkpointIds: [s.shots.a!.id],
        }),
      );
      expect(f.code).toBe("CONFLICT");
      expect(f.message).toBe("already_decided");
      expect(f.details?.winner).toEqual({
        checkpointId: s.shots.a!.id,
        kind: "approved",
        actorName: s.admin.name,
      });
    });

    test("a checkpoint of another run is refused as not_in_run", async () => {
      const s = await twoPending();
      const other = await twoPending();
      const f = await failure(
        as(s.editor).review.approve.mutate({
          runId: s.runId,
          actionId: newAction(),
          checkpointIds: [other.shots.a!.id],
        }),
      );
      expect(f.code).toBe("PRECONDITION_FAILED");
      expect(f.details?.reasons).toEqual([
        { checkpointId: other.shots.a!.id, reason: "not_in_run" },
      ]);
      expect(await decisionsOfRun(other.runId)).toHaveLength(0);
    });

    test("a retry with the same actionId replays and never acts twice", async () => {
      const s = await twoPending();
      const input = { runId: s.runId, actionId: newAction() };
      const first = await as(s.editor).review.approve.mutate(input);
      const second = await as(s.editor).review.approve.mutate(input);
      expect(second).toEqual({ ...first, replayed: true });
      expect(await decisionsOfRun(s.runId)).toHaveLength(2);
    });

    test("ignoreAreas with exactly one explicit checkpoint are saved on its variation", async () => {
      const s = await twoPending();
      const area = {
        x: 10,
        y: 20,
        width: 30,
        height: 40,
        viewport: "1280x720",
      };
      await as(s.editor).review.approve.mutate({
        runId: s.runId,
        actionId: newAction(),
        checkpointIds: [s.shots.a!.id],
        ignoreAreas: [area],
      });
      const [v] = await h.db
        .select({ ignoreRegions: testVariations.ignoreRegions })
        .from(testVariations)
        .where(eq(testVariations.id, s.shots.a!.variationId));
      expect(v!.ignoreRegions).toEqual([
        { ...area, paddingPx: 0, kind: "ignore" },
      ]);
    });

    test("ignoreAreas without exactly one explicit checkpoint is BAD_REQUEST and writes nothing", async () => {
      const s = await twoPending();
      const area = { x: 0, y: 0, width: 5, height: 5, viewport: "1280x720" };
      const c = as(s.editor);
      // No ids: "all pending" is never a single explicit target.
      const none = await failure(
        c.review.approve.mutate({
          runId: s.runId,
          actionId: newAction(),
          ignoreAreas: [area],
        }),
      );
      const two = await failure(
        c.review.approve.mutate({
          runId: s.runId,
          actionId: newAction(),
          checkpointIds: [s.shots.a!.id, s.shots.b!.id],
          ignoreAreas: [area],
        }),
      );
      expect([none.code, two.code]).toEqual(["BAD_REQUEST", "BAD_REQUEST"]);
      expect(await decisionsOfRun(s.runId)).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // reject
  // -------------------------------------------------------------------------

  describe("reject", () => {
    test("without ids rejects the pending checkpoints only", async () => {
      const s = await seed({
        checkpoints: [
          { name: "home", verdict: "unresolved", withBaseline: true },
          { name: "cart", verdict: "new" },
          { name: "footer", verdict: "passed", withBaseline: true },
        ],
      });
      const actionId = newAction();
      const res = await as(s.editor).review.reject.mutate({
        runId: s.runId,
        actionId,
      });
      expect(res.decided).toEqual([
        { checkpointId: s.shots.home!.id, runId: s.runId, state: "rejected" },
        { checkpointId: s.shots.cart!.id, runId: s.runId, state: "rejected" },
      ]);
      expect(res.runs).toEqual([{ runId: s.runId, status: "failed" }]);
      const rows = await decisionsOfAction(actionId);
      expect(rows.map((r) => r.decision)).toEqual(["rejected", "rejected"]);
      expect(rows.every((r) => r.source === "viewer")).toBe(true);
    });

    test("without ids and nothing pending rejects every undecided checkpoint", async () => {
      const s = await seed({
        checkpoints: [
          { name: "one", verdict: "passed", withBaseline: true },
          { name: "two", verdict: "passed", withBaseline: true },
        ],
      });
      const res = await as(s.editor).review.reject.mutate({
        runId: s.runId,
        actionId: newAction(),
      });
      expect(res.decided).toEqual([
        { checkpointId: s.shots.one!.id, runId: s.runId, state: "rejected" },
        { checkpointId: s.shots.two!.id, runId: s.runId, state: "rejected" },
      ]);
      expect(res.runs).toEqual([{ runId: s.runId, status: "failed" }]);
    });

    test("without ids falls back to undecided only after the pending ones are decided, never touching a decision", async () => {
      const s = await seed({
        checkpoints: [
          { name: "home", verdict: "unresolved", withBaseline: true },
          { name: "footer", verdict: "passed", withBaseline: true },
        ],
      });
      await as(s.editor).review.approve.mutate({
        runId: s.runId,
        actionId: newAction(),
        checkpointIds: [s.shots.home!.id],
      });
      const res = await as(s.editor).review.reject.mutate({
        runId: s.runId,
        actionId: newAction(),
      });
      // `home` is approved (decided); only the undecided `footer` is rejected.
      expect(res.decided).toEqual([
        { checkpointId: s.shots.footer!.id, runId: s.runId, state: "rejected" },
      ]);
    });

    test("without ids on a run with nothing left to decide is an empty success", async () => {
      const s = await seed({
        checkpoints: [{ name: "home", verdict: "unresolved" }],
      });
      await rejectShot(s, s.runId, s.shots.home!.id);
      const res = await as(s.editor).review.reject.mutate({
        runId: s.runId,
        actionId: newAction(),
      });
      expect(res).toMatchObject({ decided: [], runs: [], replayed: false });
    });

    test("with explicit ids and a reason records the reason on the audit row", async () => {
      const s = await twoPending();
      const actionId = newAction();
      const res = await as(s.editor).review.reject.mutate({
        runId: s.runId,
        actionId,
        checkpointIds: [s.shots.a!.id],
        reason: "wrong banner",
      });
      expect(res.decided.map((x) => x.state)).toEqual(["rejected"]);
      const audit = (await auditOf(s.runId)).filter(
        (a) => a.action === "run.reject_checkpoints",
      );
      expect(audit).toHaveLength(1);
      expect(audit[0]!.metadata).toMatchObject({
        actionId,
        source: "viewer",
        count: 1,
        reason: "wrong banner",
      });
    });

    test("rejecting an approved checkpoint is CONFLICT already_decided (undo first)", async () => {
      const s = await twoPending();
      await as(s.editor).review.approve.mutate({
        runId: s.runId,
        actionId: newAction(),
        checkpointIds: [s.shots.a!.id],
      });
      const f = await failure(
        as(s.editor).review.reject.mutate({
          runId: s.runId,
          actionId: newAction(),
          checkpointIds: [s.shots.a!.id],
        }),
      );
      expect(f.code).toBe("CONFLICT");
      expect(f.message).toBe("already_decided");
    });

    test("a retry with the same actionId replays", async () => {
      const s = await twoPending();
      const input = { runId: s.runId, actionId: newAction() };
      const first = await as(s.editor).review.reject.mutate(input);
      const second = await as(s.editor).review.reject.mutate(input);
      expect(second).toEqual({ ...first, replayed: true });
      expect(await decisionsOfRun(s.runId)).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // approveGroup / rejectGroup
  // -------------------------------------------------------------------------

  describe("groups", () => {
    /**
     * One signature across two runs of a build: pending members a, b, c (run
     * 1) and g (run 2); not pending: d (rejected), e (passed). f has another
     * signature.
     */
    async function seedGroupBuild() {
      const s = await seed({
        checkpoints: [
          { name: "a", verdict: "unresolved", withBaseline: true },
          { name: "b", verdict: "unresolved", withBaseline: true },
          { name: "c", verdict: "new" },
          { name: "d", verdict: "unresolved", withBaseline: true },
          { name: "e", verdict: "passed", withBaseline: true },
          { name: "f", verdict: "unresolved", withBaseline: true },
        ],
      });
      const run2 = await addReviewRun(h, s, {
        checkpoints: [{ name: "g", verdict: "unresolved" }],
      });
      const sig = `sig-${s.tag}`;
      await setSignature(
        ["a", "b", "c", "d", "e"].map((n) => s.shots[n]!.id),
        sig,
      );
      await setSignature([run2.shots.g!.id], sig);
      await setSignature([s.shots.f!.id], `other-${s.tag}`);
      await rejectShot(s, s.runId, s.shots.d!.id);
      return { s, run2 };
    }

    test("approveGroup approves only the pending members, as one action", async () => {
      const { s, run2 } = await seedGroupBuild();
      const actionId = newAction();
      const res = await as(s.editor).review.approveGroup.mutate({
        runId: s.runId,
        checkpointId: s.shots.a!.id,
        actionId,
      });

      expect(res.decided).toEqual([
        { checkpointId: s.shots.a!.id, runId: s.runId, state: "approved" },
        { checkpointId: s.shots.b!.id, runId: s.runId, state: "approved" },
        { checkpointId: s.shots.c!.id, runId: s.runId, state: "approved" },
        {
          checkpointId: run2.shots.g!.id,
          runId: run2.runId,
          state: "approved",
        },
      ]);
      expect(res).toMatchObject({
        capped: false,
        cap: GROUP_APPROVE_CAP,
        replayed: false,
      });
      expect(res.runs.map((r) => r.runId)).toEqual(
        [s.runId, run2.runId].sort(),
      );

      // One actionId, source "group", on exactly those four rows.
      const rows = await decisionsOfAction(actionId);
      expect(rows).toHaveLength(4);
      expect(rows.every((r) => r.source === "group")).toBe(true);
      expect(rows.every((r) => r.decision === "approved")).toBe(true);

      // d (rejected), e (passed) and f (other signature) were not touched.
      for (const name of ["d", "e", "f"]) {
        const ds = await h.db
          .select()
          .from(checkpointDecisions)
          .where(eq(checkpointDecisions.screenshotId, s.shots[name]!.id));
        expect(ds.filter((r) => r.actionId === actionId)).toHaveLength(0);
      }
      expect(await runStatus(run2.runId)).toBe("passed");
    });

    test("the seed need not be pending: its already-decided state is left alone", async () => {
      const { s } = await seedGroupBuild();
      await as(s.editor).review.approve.mutate({
        runId: s.runId,
        actionId: newAction(),
        checkpointIds: [s.shots.a!.id],
      });
      const res = await as(s.editor).review.approveGroup.mutate({
        runId: s.runId,
        checkpointId: s.shots.a!.id,
        actionId: newAction(),
      });
      expect(res.decided.map((x) => x.checkpointId)).not.toContain(
        s.shots.a!.id,
      );
      expect(res.decided).toHaveLength(3);
    });

    test("rejectGroup rejects only the pending members, as one action", async () => {
      const { s, run2 } = await seedGroupBuild();
      const actionId = newAction();
      const res = await as(s.editor).review.rejectGroup.mutate({
        runId: s.runId,
        checkpointId: s.shots.b!.id,
        actionId,
      });
      expect(res.decided.map((x) => x.checkpointId)).toEqual([
        s.shots.a!.id,
        s.shots.b!.id,
        s.shots.c!.id,
        run2.shots.g!.id,
      ]);
      expect(res.decided.every((x) => x.state === "rejected")).toBe(true);
      const rows = await decisionsOfAction(actionId);
      expect(rows).toHaveLength(4);
      expect(rows.every((r) => r.source === "group")).toBe(true);
    });

    test("a checkpoint with no diff signature has no group: an empty success", async () => {
      const s = await twoPending();
      const res = await as(s.editor).review.approveGroup.mutate({
        runId: s.runId,
        checkpointId: s.shots.a!.id,
        actionId: newAction(),
      });
      expect(res).toMatchObject({
        decided: [],
        runs: [],
        capped: false,
        cap: GROUP_APPROVE_CAP,
      });
      expect(await decisionsOfRun(s.runId)).toHaveLength(0);
    });

    test("a checkpoint outside the run is BAD_REQUEST, an unknown one NOT_FOUND", async () => {
      const s = await seedGroup();
      const other = await seedGroup();
      const wrongRun = await failure(
        as(s.editor).review.approveGroup.mutate({
          runId: s.runId,
          checkpointId: other.shots.a!.id,
          actionId: newAction(),
        }),
      );
      const unknown = await failure(
        as(s.editor).review.approveGroup.mutate({
          runId: s.runId,
          checkpointId: randomUUID(),
          actionId: newAction(),
        }),
      );
      expect([wrongRun.code, unknown.code]).toEqual([
        "BAD_REQUEST",
        "NOT_FOUND",
      ]);
    });

    test("a retry of a group action replays", async () => {
      const s = await seedGroup();
      const input = {
        runId: s.runId,
        checkpointId: s.shots.a!.id,
        actionId: newAction(),
      };
      const first = await as(s.editor).review.approveGroup.mutate(input);
      const second = await as(s.editor).review.approveGroup.mutate(input);
      expect(second).toMatchObject({
        decided: first.decided,
        runs: first.runs,
        replayed: true,
      });
      expect(await decisionsOfRun(s.runId)).toHaveLength(2);
    });

    test("writes a build-level audit row per group action", async () => {
      const s = await seedGroup();
      const actionId = newAction();
      await as(s.editor).review.approveGroup.mutate({
        runId: s.runId,
        checkpointId: s.shots.a!.id,
        actionId,
      });
      await as(s.editor).review.rejectGroup.mutate({
        runId: s.runId,
        checkpointId: s.shots.a!.id,
        actionId: newAction(),
      });
      const rows = await auditOf(s.buildId);
      expect(rows.map((r) => r.action)).toEqual(["run.approve_group"]);
      expect(rows[0]).toMatchObject({
        actorId: s.editor.id,
        targetType: "build",
      });
      expect(rows[0]!.metadata).toMatchObject({
        actionId,
        source: "group",
        count: 2,
        runIds: [s.runId],
        seedCheckpointId: s.shots.a!.id,
        capped: false,
      });
    });

    test("caps a group at GROUP_APPROVE_CAP in capture order; running it again drains the rest", async () => {
      const s = await seed({ checkpoints: [], lifecycle: "unresolved" });
      const sig = `sig-${s.tag}`;
      const ids = await bulkPending(s, GROUP_APPROVE_CAP + 1, {
        signature: sig,
      });
      const input = {
        runId: s.runId,
        checkpointId: ids[0]!,
      };
      const first = await as(s.editor).review.approveGroup.mutate({
        ...input,
        actionId: newAction(),
      });
      expect(first).toMatchObject({ capped: true, cap: GROUP_APPROVE_CAP });
      expect(first.decided.map((x) => x.checkpointId)).toEqual(
        ids.slice(0, GROUP_APPROVE_CAP),
      );

      const second = await as(s.editor).review.approveGroup.mutate({
        ...input,
        actionId: newAction(),
      });
      expect(second).toMatchObject({ capped: false });
      expect(second.decided.map((x) => x.checkpointId)).toEqual([
        ids[GROUP_APPROVE_CAP],
      ]);
      expect(await runStatus(s.runId)).toBe("passed");
    }, 60_000);
  });

  // -------------------------------------------------------------------------
  // previewApproveBuild / approveBuild
  // -------------------------------------------------------------------------

  describe("approve pending in a build", () => {
    /**
     * run 1: a (unresolved), b (new)            -> 2 pending
     * run 2: c (unresolved), d (rejected)       -> 1 pending, 1 rejected
     * run 3: still running (e has no verdict)   -> not reviewable
     */
    async function seedBuild() {
      const s = await seed({
        checkpoints: [
          { name: "a", verdict: "unresolved", withBaseline: true },
          { name: "b", verdict: "new" },
        ],
      });
      const run2 = await addReviewRun(h, s, {
        checkpoints: [
          { name: "c", verdict: "unresolved" },
          { name: "d", verdict: "unresolved" },
        ],
      });
      const run3 = await addReviewRun(h, s, {
        checkpoints: [{ name: "e", verdict: null }],
        lifecycle: "running",
      });
      await rejectShot(s, run2.runId, run2.shots.d!.id);
      return { s, run2, run3 };
    }

    test("previewApproveBuild counts what approveBuild would do", async () => {
      const { s } = await seedBuild();
      const preview: ApproveBuildPreview = await as(
        s.editor,
      ).review.previewApproveBuild.query({
        buildId: s.buildId,
      });
      expect(preview).toEqual({
        pendingCheckpoints: 3,
        tests: 2,
        rejectedLeftAsIs: 1,
        notReviewableTests: 1,
        capped: false,
        cap: APPROVE_BUILD_CAP,
      });
      expect(APPROVE_BUILD_CAP).toBe(500);
    });

    test("approveBuild approves the pending checkpoints, leaves a rejected step as is and skips a running run", async () => {
      const { s, run2, run3 } = await seedBuild();
      const actionId = newAction();
      const res = await as(s.editor).review.approveBuild.mutate({
        buildId: s.buildId,
        actionId,
        expectedCount: 3,
      });

      expect(res).toMatchObject({
        actionId,
        capped: false,
        cap: 500,
        replayed: false,
      });
      expect(res.decided.map((x) => x.checkpointId)).toEqual([
        s.shots.a!.id,
        s.shots.b!.id,
        run2.shots.c!.id,
      ]);
      expect(res.decided.every((x) => x.state === "approved")).toBe(true);
      expect(res.runs.map((r) => r.runId)).toEqual(
        [s.runId, run2.runId].sort(),
      );

      const rows = await decisionsOfAction(actionId);
      expect(rows).toHaveLength(3);
      expect(rows.every((r) => r.source === "batch")).toBe(true);

      // d keeps its rejection; the running run is untouched.
      const dRows = await h.db
        .select()
        .from(checkpointDecisions)
        .where(eq(checkpointDecisions.screenshotId, run2.shots.d!.id));
      expect(dRows).toMatchObject([{ decision: "rejected", revertedAt: null }]);
      expect(await runStatus(run3.runId)).toBe("running");
      expect(await decisionsOfRun(run3.runId)).toHaveLength(0);
      expect(await runStatus(s.runId)).toBe("passed");
      expect(await runStatus(run2.runId)).toBe("failed");

      // Nothing pending is left; the running run is still not reviewable.
      expect(
        await as(s.editor).review.previewApproveBuild.query({
          buildId: s.buildId,
        }),
      ).toMatchObject({
        pendingCheckpoints: 0,
        tests: 0,
        rejectedLeftAsIs: 1,
        notReviewableTests: 1,
      });
    });

    test("an expectedCount that is off by one is CONFLICT batch_changed with the fresh preview, and nothing is approved", async () => {
      const { s } = await seedBuild();
      h.broadcasterPublish.mockClear(); // the scene's own reject announced
      for (const expectedCount of [2, 4]) {
        const f = await failure(
          as(s.editor).review.approveBuild.mutate({
            buildId: s.buildId,
            actionId: newAction(),
            expectedCount,
          }),
        );
        expect(f.code).toBe("CONFLICT");
        expect(f.message).toBe("batch_changed");
        expect(f.details?.preview).toEqual({
          pendingCheckpoints: 3,
          tests: 2,
          rejectedLeftAsIs: 1,
          notReviewableTests: 1,
          capped: false,
          cap: 500,
        });
      }
      expect(await decisionsOfRun(s.runId)).toHaveLength(0);
      expect(h.broadcasterPublish).not.toHaveBeenCalled();
    });

    test("expectedCount 0 on a build with nothing pending is an empty success", async () => {
      const s = await seed({
        checkpoints: [{ name: "ok", verdict: "passed" }],
      });
      const res = await as(s.editor).review.approveBuild.mutate({
        buildId: s.buildId,
        actionId: newAction(),
        expectedCount: 0,
      });
      expect(res).toMatchObject({
        decided: [],
        runs: [],
        capped: false,
        cap: 500,
      });
    });

    test("a retry of the same action replays even though nothing is pending any more", async () => {
      const { s } = await seedBuild();
      const input = {
        buildId: s.buildId,
        actionId: newAction(),
        expectedCount: 3,
      };
      const first = await as(s.editor).review.approveBuild.mutate(input);
      // Pending is 0 now, which is not expectedCount: still a replay, not a
      // batch_changed conflict.
      const second = await as(s.editor).review.approveBuild.mutate(input);
      expect(second).toMatchObject({
        actionId: first.actionId,
        decided: first.decided,
        runs: first.runs,
        replayed: true,
        capped: false,
      });
      expect(await decisionsOfAction(input.actionId)).toHaveLength(3);
    });

    test("writes one build-level audit row", async () => {
      const { s, run2 } = await seedBuild();
      const actionId = newAction();
      await as(s.editor).review.approveBuild.mutate({
        buildId: s.buildId,
        actionId,
        expectedCount: 3,
      });
      const rows = (await auditOf(s.buildId)).filter(
        (a) => a.action === "run.approve_build",
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actorId: s.editor.id,
        targetType: "build",
      });
      expect(rows[0]!.metadata).toMatchObject({
        actionId,
        source: "batch",
        count: 3,
        expectedCount: 3,
        capped: false,
        runIds: [s.runId, run2.runId].sort(),
      });
      // The per-run rows from the core are there too.
      expect(
        (await auditOf(s.runId)).filter(
          (a) => a.action === "run.approve_checkpoints",
        ),
      ).toHaveLength(1);
    });

    test("the count is taken after the runs are locked: a decision that lands while it waits changes the count (batch_changed)", async () => {
      const { s } = await seedBuild();
      const side = createDb();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let locked!: () => void;
      const lockedP = new Promise<void>((resolve) => {
        locked = resolve;
      });
      let sidePid = 0;
      // A concurrent reviewer holds the first run's lock, approves `a`, and
      // commits only when released.
      const sideDone = side.db.transaction(async (tx) => {
        const pid = await tx.execute<{ pid: number }>(
          sql`select pg_backend_pid() as pid`,
        );
        sidePid = pid[0]!.pid;
        await lockRuns(tx, s.projectId, [s.runId]);
        locked();
        await gate;
        await decideCheckpoints(
          tx,
          {
            actor: { id: s.admin.id, role: s.admin.role, via: "jwt" },
            projectId: s.projectId,
            actionId: randomUUID(),
            source: "viewer",
            decision: "rejected",
            targets: [{ runId: s.runId, screenshotId: s.shots.a!.id }],
          },
          { registry: h.telemetry.metrics, logger: quietLogger },
        );
      });
      sideDone.catch(() => locked());

      let call: Promise<unknown> = Promise.resolve();
      try {
        await lockedP;
        call = as(s.editor).review.approveBuild.mutate({
          buildId: s.buildId,
          actionId: newAction(),
          // The count the reviewer saw before the concurrent decision.
          expectedCount: 3,
        });
        call.catch(() => undefined);
        // approveBuild is now parked on the run lock.
        const deadline = Date.now() + 5_000;
        let waiting = false;
        while (!waiting && Date.now() < deadline) {
          const r = await h.db.execute<{ n: number }>(sql`
            select count(*)::int as n from pg_stat_activity
            where wait_event_type = 'Lock'
              and ${sidePid}::int = any(pg_blocking_pids(pid))
          `);
          waiting = r[0]!.n > 0;
          if (!waiting) await new Promise((r2) => setTimeout(r2, 25));
        }
        expect(waiting).toBe(true);
        release();
        await sideDone;
        const f = await failure(call);
        // Counted after the lock: 2 pending now (`a` was rejected meanwhile),
        // so the confirmed 3 is stale. Counting before the lock would have
        // matched 3 and then died in the core as already_decided.
        expect(f.code).toBe("CONFLICT");
        expect(f.message).toBe("batch_changed");
        expect(f.details?.preview?.pendingCheckpoints).toBe(2);
      } finally {
        release();
        await Promise.allSettled([sideDone, call]);
        await side.close();
      }
      // The approved count was never applied.
      const approved = (await decisionsOfRun(s.runId)).filter(
        (r) => r.decision === "approved",
      );
      expect(approved).toHaveLength(0);
    }, 30_000);

    test("caps at 500 in capture order; running it again drains the rest", async () => {
      const s = await seed({ checkpoints: [], lifecycle: "unresolved" });
      const ids = await bulkPending(s, APPROVE_BUILD_CAP + 1);

      const preview = await as(s.editor).review.previewApproveBuild.query({
        buildId: s.buildId,
      });
      expect(preview).toMatchObject({
        pendingCheckpoints: 501,
        capped: true,
        cap: 500,
      });

      const firstAction = newAction();
      const first = await as(s.editor).review.approveBuild.mutate({
        buildId: s.buildId,
        actionId: firstAction,
        expectedCount: 501,
      });
      expect(first).toMatchObject({ capped: true, cap: 500, replayed: false });
      expect(first.decided).toHaveLength(500);
      // Deterministic: the first 500 in capture order; the newest is left.
      expect(first.decided.map((x) => x.checkpointId)).toEqual(
        ids.slice(0, 500),
      );
      expect(first.runs).toEqual([{ runId: s.runId, status: "new" }]);

      // A retry of the capped action still says there is more to drain.
      const replay = await as(s.editor).review.approveBuild.mutate({
        buildId: s.buildId,
        actionId: firstAction,
        expectedCount: 501,
      });
      expect(replay).toMatchObject({ replayed: true, capped: true, cap: 500 });
      expect(replay.decided).toEqual(first.decided);

      const second = await as(s.editor).review.approveBuild.mutate({
        buildId: s.buildId,
        actionId: newAction(),
        expectedCount: 1,
      });
      expect(second).toMatchObject({ capped: false, cap: 500 });
      expect(second.decided.map((x) => x.checkpointId)).toEqual([ids[500]]);
      expect(second.runs).toEqual([{ runId: s.runId, status: "passed" }]);
      expect(await decisionsOfRun(s.runId)).toHaveLength(501);
    }, 90_000);
  });

  // -------------------------------------------------------------------------
  // Project pinning (R18)
  // -------------------------------------------------------------------------

  describe("a build that holds another project's run (corrupt state)", () => {
    /**
     * `s` is project A's build with two pending checkpoints of one diff
     * signature. `foreign` is project B's run, moved INTO that build (the
     * build/project mismatch the pin guards against), with a pending
     * checkpoint of the same signature.
     */
    async function seedWithForeignRun() {
      const s = await seedGroup();
      const foreign = await seed({
        checkpoints: [{ name: "x", verdict: "unresolved", withBaseline: true }],
      });
      await setSignature([foreign.shots.x!.id], `sig-${s.tag}`);
      await h.db
        .update(testRuns)
        .set({ buildId: s.buildId })
        .where(eq(testRuns.id, foreign.runId));
      return { s, foreign };
    }

    async function expectForeignUntouched(foreign: ReviewSeed) {
      expect(await decisionsOfRun(foreign.runId)).toHaveLength(0);
      expect(await runStatus(foreign.runId)).toBe("unresolved");
    }

    test("previewApproveBuild counts only the build's own project", async () => {
      const { s } = await seedWithForeignRun();
      const preview = await as(s.editor).review.previewApproveBuild.query({
        buildId: s.buildId,
      });
      expect(preview).toMatchObject({
        pendingCheckpoints: 2,
        tests: 1,
        notReviewableTests: 0,
      });
    });

    test("approveBuild approves its own project's checkpoints and ignores the foreign run", async () => {
      const { s, foreign } = await seedWithForeignRun();
      const res = await as(s.editor).review.approveBuild.mutate({
        buildId: s.buildId,
        actionId: newAction(),
        expectedCount: 2,
      });
      expect(res.decided.map((x) => x.checkpointId)).toEqual([
        s.shots.a!.id,
        s.shots.b!.id,
      ]);
      expect(await runStatus(s.runId)).toBe("passed");
      await expectForeignUntouched(foreign);
    });

    test("approveGroup and rejectGroup ignore the foreign run", async () => {
      const { s, foreign } = await seedWithForeignRun();
      const approved = await as(s.editor).review.approveGroup.mutate({
        runId: s.runId,
        checkpointId: s.shots.a!.id,
        actionId: newAction(),
      });
      expect(approved.decided.map((x) => x.checkpointId)).toEqual([
        s.shots.a!.id,
        s.shots.b!.id,
      ]);

      const other = await seedWithForeignRun();
      const rejected = await as(other.s.editor).review.rejectGroup.mutate({
        runId: other.s.runId,
        checkpointId: other.s.shots.a!.id,
        actionId: newAction(),
      });
      expect(rejected.decided.map((x) => x.checkpointId)).toEqual([
        other.s.shots.a!.id,
        other.s.shots.b!.id,
      ]);
      await expectForeignUntouched(foreign);
      await expectForeignUntouched(other.foreign);
    });
  });

  describe("an actionId is scoped to its project", () => {
    test("replaying project A's actionId through project B's run is a fresh decision, never A's result", async () => {
      const a = await twoPending();
      const b = await twoPending();
      const actionId = newAction();
      const first = await as(a.editor).review.approve.mutate({
        runId: a.runId,
        actionId,
      });
      expect(first.decided).toHaveLength(2);

      const second = await as(b.editor).review.approve.mutate({
        runId: b.runId,
        actionId,
      });
      expect(second.replayed).toBe(false);
      expect(second.decided.map((x) => x.checkpointId).sort()).toEqual(
        [b.shots.a!.id, b.shots.b!.id].sort(),
      );
      expect(second.runs.map((r) => r.runId)).toEqual([b.runId]);
      // A's rows are A's; B has its own, under the same actionId.
      expect(await decisionsOfRun(a.runId)).toHaveLength(2);
      expect(await decisionsOfRun(b.runId)).toHaveLength(2);
    });

    test("when project B has nothing to decide, A's actionId is an empty no-op, not a replay", async () => {
      const a = await twoPending();
      const b = await seed({
        checkpoints: [{ name: "ok", verdict: "passed" }],
      });
      const actionId = newAction();
      await as(a.editor).review.approve.mutate({ runId: a.runId, actionId });

      const viaRun = await as(b.editor).review.approve.mutate({
        runId: b.runId,
        actionId,
      });
      expect(viaRun).toMatchObject({ decided: [], runs: [], replayed: false });

      const viaBuild = await as(b.editor).review.approveBuild.mutate({
        buildId: b.buildId,
        actionId,
        expectedCount: 0,
      });
      expect(viaBuild).toMatchObject({
        decided: [],
        runs: [],
        replayed: false,
      });
      expect(await decisionsOfRun(b.runId)).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Broadcasts
  // -------------------------------------------------------------------------

  describe("broadcasts", () => {
    const calls = () =>
      h.broadcasterPublish.mock.calls as Array<
        [string, { event: string; data: { id: string } }]
      >;

    test("approve broadcasts testRun_updated and build_updated for the project", async () => {
      const s = await twoPending();
      await as(s.editor).review.approve.mutate({
        runId: s.runId,
        actionId: newAction(),
      });
      expect(h.broadcasterPublish).toHaveBeenCalledWith(s.projectId, {
        event: "testRun_updated",
        data: { id: s.runId },
      });
      expect(h.broadcasterPublish).toHaveBeenCalledWith(s.projectId, {
        event: "build_updated",
        data: { id: s.buildId },
      });
      expect(calls()).toHaveLength(2);
    });

    test("reject broadcasts testRun_updated and build_updated", async () => {
      const s = await twoPending();
      await as(s.editor).review.reject.mutate({
        runId: s.runId,
        actionId: newAction(),
      });
      expect(calls().map(([, ev]) => ev.event)).toEqual([
        "testRun_updated",
        "build_updated",
      ]);
    });

    test("a multi-run action broadcasts every affected run and the build once", async () => {
      const s = await twoPending();
      const run2 = await addReviewRun(h, s, {
        checkpoints: [{ name: "c", verdict: "unresolved" }],
      });
      await as(s.editor).review.approveBuild.mutate({
        buildId: s.buildId,
        actionId: newAction(),
        expectedCount: 3,
      });
      const runEvents = calls()
        .filter(([, ev]) => ev.event === "testRun_updated")
        .map(([, ev]) => ev.data.id)
        .sort();
      expect(runEvents).toEqual([s.runId, run2.runId].sort());
      const buildEvents = calls().filter(
        ([, ev]) => ev.event === "build_updated",
      );
      expect(buildEvents).toEqual([
        [s.projectId, { event: "build_updated", data: { id: s.buildId } }],
      ]);
    });

    test("group actions broadcast too", async () => {
      const s = await seedGroup();
      await as(s.editor).review.approveGroup.mutate({
        runId: s.runId,
        checkpointId: s.shots.a!.id,
        actionId: newAction(),
      });
      expect(calls().map(([, ev]) => ev.event)).toEqual([
        "testRun_updated",
        "build_updated",
      ]);
    });

    test("a replay broadcasts again (the events are idempotent refresh hints)", async () => {
      const s = await twoPending();
      const input = { runId: s.runId, actionId: newAction() };
      await as(s.editor).review.approve.mutate(input);
      h.broadcasterPublish.mockClear();
      const again = await as(s.editor).review.approve.mutate(input);
      expect(again.replayed).toBe(true);
      expect(calls().map(([, ev]) => ev.event)).toEqual([
        "testRun_updated",
        "build_updated",
      ]);
    });

    test("an action that decided nothing broadcasts nothing", async () => {
      const s = await seed({
        checkpoints: [{ name: "ok", verdict: "passed" }],
      });
      await as(s.editor).review.approve.mutate({
        runId: s.runId,
        actionId: newAction(),
      });
      expect(h.broadcasterPublish).not.toHaveBeenCalled();
    });

    test("events go out only after the decisions are committed", async () => {
      const s = await twoPending();
      const seen: number[] = [];
      h.broadcasterPublish.mockImplementation(async () => {
        // h.db is another connection: it sees committed rows only.
        seen.push((await decisionsOfRun(s.runId)).length);
      });
      await as(s.editor).review.approve.mutate({
        runId: s.runId,
        actionId: newAction(),
      });
      expect(seen).toEqual([2, 2]);
    });
  });
});
