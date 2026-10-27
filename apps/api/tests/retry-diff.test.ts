import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";

import {
  checkpointDecisions,
  eq,
  inArray,
  screenshots,
  testRuns,
} from "@furan/db";
import type { ReviewErrorDetails } from "@furan/shared-types";
import { createTRPCClient, httpBatchLink, TRPCClientError } from "@trpc/client";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";

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

/**
 * `runs.retryDiff` and what a failed step does to review (spec 2026-10-23 §6,
 * §7, §9): an editor retries a step whose diff failed for good, the review
 * actions refuse a failed step (`diff_failed`) or skip it when they select
 * their own targets, and the per-step result reaches the viewer: the failure
 * through `listCheckpoints` (the step list draws it), the numbers through
 * `getStep`.
 */
const skip = !process.env.DATABASE_URL;
const d = skip ? describe.skip : describe;

d("retry a failed step's diff", () => {
  let h: TestApp;
  let baseUrl: string;
  const seeds: ReviewSeed[] = [];

  beforeAll(async () => {
    h = await createTestApp();
    h.app.log.level = "silent";
    await h.app.listen({ host: "127.0.0.1", port: 0 });
    const { port } = h.app.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await cleanupReviewSeeds(h, seeds);
    await h.close();
  });

  beforeEach(() => {
    h.diffQueueAdd.mockClear();
    h.broadcasterPublish.mockClear();
  });

  const as = (u: ReviewUser) =>
    createTRPCClient<AppRouter>({
      links: [
        httpBatchLink({
          url: `${baseUrl}/trpc`,
          headers: { authorization: `Bearer ${u.jwt}` },
        }),
      ],
    });

  /**
   * A run the per-step pipeline already diffed (every step at version 1), so
   * no legacy fan-out (Ruling R6) widens what a retry queues.
   */
  async function seed(spec: ReviewRunSpec): Promise<ReviewSeed> {
    const rs = await seedReviewRun(h, spec);
    seeds.push(rs);
    await h.db
      .update(screenshots)
      .set({ diffGeneration: 1 })
      .where(eq(screenshots.runId, rs.runId));
    return rs;
  }

  /** What the worker leaves on a step whose diff failed for good. */
  async function failStep(stepId: string, code = "engine_error") {
    await h.db
      .update(screenshots)
      .set({
        verdict: "unresolved",
        verdictAt: new Date(),
        diffFailedAt: new Date(),
        diffError: code,
      })
      .where(eq(screenshots.id, stepId));
  }

  const stepRow = async (id: string) =>
    (await h.db.select().from(screenshots).where(eq(screenshots.id, id)))[0]!;

  const runRow = async (id: string) =>
    (await h.db.select().from(testRuns).where(eq(testRuns.id, id)))[0]!;

  const decisionsOf = (runIds: string[]) =>
    h.db
      .select()
      .from(checkpointDecisions)
      .where(inArray(checkpointDecisions.runId, runIds));

  /** The refusal a call fails with: tRPC code, message and review details. */
  async function refusal(call: Promise<unknown>) {
    try {
      await call;
    } catch (err) {
      if (err instanceof TRPCClientError) {
        const data = err.data as {
          code?: string;
          details?: ReviewErrorDetails;
        } | null;
        return {
          code: data?.code,
          message: err.message,
          details: data?.details,
        };
      }
      throw err;
    }
    throw new Error("expected the call to be refused");
  }

  describe("runs.retryDiff", () => {
    test("retryDiff clears the failure, queues the step, and the run is running", async () => {
      const rs = await seed({
        checkpoints: [
          { name: "home", verdict: "unresolved" },
          { name: "cart", verdict: "passed" },
        ],
      });
      const home = rs.shots.home!.id;
      const cart = rs.shots.cart!.id;
      // `cart` was compared (2%); `home`'s failure left no numbers of its own.
      await h.db
        .update(screenshots)
        .set({
          diffPercent: 2,
          pixelMismatchCount: 40,
          baselineSource: "default_branch",
        })
        .where(eq(screenshots.id, cart));
      await failStep(home);
      // The run total that went stale when `home` last changed.
      await h.db
        .update(testRuns)
        .set({ diffPercent: 50, status: "unresolved" })
        .where(eq(testRuns.id, rs.runId));
      const retriedBefore = await diffJobsEnqueued(
        h.telemetry.metrics,
        "retry",
      );

      const out = await as(rs.editor).runs.retryDiff.mutate({
        runId: rs.runId,
        checkpointId: home,
      });

      expect(out).toEqual({ status: "running" });
      const step = await stepRow(home);
      expect(step.verdict).toBeNull();
      expect(step.verdictAt).toBeNull();
      expect(step.diffFailedAt).toBeNull();
      expect(step.diffError).toBeNull();
      expect(step.diffGeneration).toBe(2);
      // The other step keeps its result and its version.
      const other = await stepRow(cart);
      expect([other.verdict, other.diffGeneration]).toEqual(["passed", 1]);
      // The run's status and totals were recomputed in the same transaction.
      const run = await runRow(rs.runId);
      expect(run.status).toBe("running");
      expect(run.diffPercent).toBe(2);
      // One job, for that step at its new version, counted as a retry.
      expect(
        h.diffQueueAdd.mock.calls.map(([, p]) => [
          p.screenshotId,
          p.generation,
        ]),
      ).toEqual([[home, 2]]);
      expect(await diffJobsEnqueued(h.telemetry.metrics, "retry")).toBe(
        retriedBefore + 1,
      );
      expect(h.broadcasterPublish).toHaveBeenCalledWith(rs.projectId, {
        event: "testRun_updated",
        data: { id: rs.runId },
      });
    });

    test("retryDiff refuses a step that hasn't failed (PRECONDITION_FAILED)", async () => {
      const rs = await seed({
        checkpoints: [
          { name: "home", verdict: "unresolved" },
          { name: "cart", verdict: "passed" },
        ],
      });
      // A failed step of ANOTHER run is no more retryable through this one.
      const other = await seed({
        checkpoints: [{ name: "other", verdict: "unresolved" }],
      });
      await failStep(other.shots.other!.id);
      const c = as(rs.editor);

      for (const [runId, checkpointId] of [
        [rs.runId, rs.shots.home!.id],
        [rs.runId, rs.shots.cart!.id],
        [rs.runId, other.shots.other!.id],
        [rs.runId, randomUUID()],
      ] as const) {
        expect(
          await refusal(c.runs.retryDiff.mutate({ runId, checkpointId })),
        ).toMatchObject({
          code: "PRECONDITION_FAILED",
          message: "step_not_failed",
        });
      }

      // Nothing changed: versions, the failure, the queue.
      expect((await stepRow(rs.shots.home!.id)).diffGeneration).toBe(1);
      expect((await stepRow(rs.shots.home!.id)).verdict).toBe("unresolved");
      const stillFailed = await stepRow(other.shots.other!.id);
      expect([stillFailed.diffGeneration, stillFailed.diffError]).toEqual([
        1,
        "engine_error",
      ]);
      expect(h.diffQueueAdd).not.toHaveBeenCalled();
    });

    test("retryDiff requires write access (guest FORBIDDEN)", async () => {
      const rs = await seed({
        checkpoints: [{ name: "home", verdict: "unresolved" }],
      });
      await failStep(rs.shots.home!.id);
      const input = { runId: rs.runId, checkpointId: rs.shots.home!.id };

      for (const user of [rs.guest, rs.outsider]) {
        expect(
          await refusal(as(user).runs.retryDiff.mutate(input)),
        ).toMatchObject({ code: "FORBIDDEN" });
      }

      const step = await stepRow(rs.shots.home!.id);
      expect([step.diffError, step.diffGeneration]).toEqual([
        "engine_error",
        1,
      ]);
      expect(h.diffQueueAdd).not.toHaveBeenCalled();

      // An admin (who bypasses membership) can.
      await as(rs.admin).runs.retryDiff.mutate(input);
      expect((await stepRow(rs.shots.home!.id)).diffFailedAt).toBeNull();
    });

    test("two concurrent retries of one step: one wins, the step is queued once", async () => {
      const rs = await seed({
        checkpoints: [{ name: "home", verdict: "unresolved" }],
      });
      await failStep(rs.shots.home!.id);
      const input = { runId: rs.runId, checkpointId: rs.shots.home!.id };
      const c = as(rs.editor);

      const results = await Promise.allSettled([
        c.runs.retryDiff.mutate(input),
        c.runs.retryDiff.mutate(input),
      ]);

      expect(results.map((r) => r.status).sort()).toEqual([
        "fulfilled",
        "rejected",
      ]);
      // The loser found the failure already cleared; it didn't fail some
      // other way (a deadlock, say).
      const lost = results.find(
        (r): r is PromiseRejectedResult => r.status === "rejected",
      )!;
      expect(await refusal(Promise.reject(lost.reason))).toMatchObject({
        code: "PRECONDITION_FAILED",
        message: "step_not_failed",
      });
      expect((await stepRow(rs.shots.home!.id)).diffGeneration).toBe(2);
      expect(h.diffQueueAdd).toHaveBeenCalledTimes(1);
    });
  });

  describe("a failed step in review", () => {
    test.each(["approve", "reject"] as const)(
      "%s refuses a failed step with diff_failed",
      async (action) => {
        const rs = await seed({
          checkpoints: [
            { name: "broken", verdict: "unresolved" },
            { name: "home", verdict: "unresolved" },
          ],
        });
        const broken = rs.shots.broken!.id;
        await failStep(broken);
        const c = as(rs.editor);

        // Named on its own, or with a legal sibling: the whole action is refused.
        for (const checkpointIds of [[broken], [rs.shots.home!.id, broken]]) {
          const input = {
            runId: rs.runId,
            actionId: randomUUID(),
            checkpointIds,
          };
          const out = await refusal(
            action === "approve"
              ? c.review.approve.mutate(input)
              : c.review.reject.mutate(input),
          );
          expect(out).toMatchObject({
            code: "PRECONDITION_FAILED",
            message: "diff_failed",
          });
          expect(out.details?.reasons).toEqual([
            { checkpointId: broken, reason: "diff_failed" },
          ]);
        }
        expect(await decisionsOf([rs.runId])).toHaveLength(0);
      },
    );

    test("approve and reject without ids skip the failed step", async () => {
      const rs = await seed({
        checkpoints: [
          { name: "broken", verdict: "unresolved" },
          { name: "home", verdict: "unresolved" },
        ],
      });
      await failStep(rs.shots.broken!.id);

      const out = await as(rs.editor).review.approve.mutate({
        runId: rs.runId,
        actionId: randomUUID(),
      });

      expect(out.decided.map((x) => x.checkpointId)).toEqual([
        rs.shots.home!.id,
      ]);
      // Nothing else is pending, so a reject with no ids falls back to every
      // undecided step, and that is still not the failed one.
      const rejected = await as(rs.editor).review.reject.mutate({
        runId: rs.runId,
        actionId: randomUUID(),
      });
      expect(rejected.decided).toEqual([]);
      expect(await decisionsOf([rs.runId])).toHaveLength(1);
    });

    test("approveBuild skips failed steps", async () => {
      const rs = await seed({
        checkpoints: [
          { name: "broken", verdict: "unresolved" },
          { name: "home", verdict: "unresolved" },
        ],
      });
      // A second run of the build whose only pending step failed.
      const other = await addReviewRun(h, rs, {
        checkpoints: [{ name: "lost", verdict: "unresolved" }],
      });
      await failStep(rs.shots.broken!.id);
      await failStep(other.shots.lost!.id);
      const c = as(rs.editor);

      const preview = await c.review.previewApproveBuild.query({
        buildId: rs.buildId,
      });
      // One approvable step; both runs have a step that can't be reviewed.
      expect(preview).toMatchObject({
        pendingCheckpoints: 1,
        tests: 1,
        notReviewableTests: 2,
      });

      const out = await c.review.approveBuild.mutate({
        buildId: rs.buildId,
        actionId: randomUUID(),
        expectedCount: 1,
      });

      expect(out.decided.map((x) => x.checkpointId)).toEqual([
        rs.shots.home!.id,
      ]);
      const decisions = await decisionsOf([rs.runId, other.runId]);
      expect(decisions.map((x) => x.screenshotId)).toEqual([rs.shots.home!.id]);
      // The failed steps stay failed and pending; their runs still need review.
      expect((await stepRow(rs.shots.broken!.id)).diffError).toBe(
        "engine_error",
      );
      expect((await runRow(rs.runId)).status).toBe("unresolved");
      expect((await runRow(other.runId)).status).toBe("unresolved");
    });

    test.each([
      ["approveGroup", "approved"],
      ["rejectGroup", "rejected"],
    ] as const)(
      "%s skips a failed step of the group",
      async (action, state) => {
        const signature = `sig-${randomUUID()}`;
        const rs = await seed({
          checkpoints: [{ name: "seed", verdict: "unresolved" }],
        });
        const b = await addReviewRun(h, rs, {
          checkpoints: [{ name: "broken", verdict: "unresolved" }],
        });
        const c2 = await addReviewRun(h, rs, {
          checkpoints: [{ name: "third", verdict: "unresolved" }],
        });
        await h.db
          .update(screenshots)
          .set({ diffSignature: signature, diffGeneration: 1 })
          .where(
            inArray(screenshots.id, [
              rs.shots.seed!.id,
              b.shots.broken!.id,
              c2.shots.third!.id,
            ]),
          );
        await failStep(b.shots.broken!.id);
        // A failed step carries no signature in practice; keep it in the group
        // here so the skip is the legality rule's, not an empty selection.

        const out = await as(rs.editor).review[action].mutate({
          runId: rs.runId,
          checkpointId: rs.shots.seed!.id,
          actionId: randomUUID(),
        });

        expect(
          out.decided.map((x) => [x.checkpointId, x.state]).sort(),
        ).toEqual(
          [
            [rs.shots.seed!.id, state],
            [c2.shots.third!.id, state],
          ].sort(),
        );
        expect(await decisionsOf([b.runId])).toHaveLength(0);
      },
    );

    test("inbox.approve refuses a run with a failed step (diff_failed)", async () => {
      const rs = await seed({
        checkpoints: [
          { name: "broken", verdict: "unresolved" },
          { name: "home", verdict: "unresolved" },
        ],
      });
      const broken = rs.shots.broken!.id;
      await failStep(broken);

      const out = await refusal(
        as(rs.editor).inbox.approve.mutate({ runId: rs.runId }),
      );

      // The run-level approve is refused whole: the healthy step is not
      // approved short, and the failed one is named.
      expect(out).toMatchObject({
        code: "PRECONDITION_FAILED",
        message: "diff_failed",
      });
      expect(out.details?.reasons).toEqual([
        { checkpointId: broken, reason: "diff_failed" },
      ]);
      expect(await decisionsOf([rs.runId])).toHaveLength(0);

      // Once the step is retried and diffed again, the approve goes through.
      await h.db
        .update(screenshots)
        .set({ verdict: "unresolved", diffFailedAt: null, diffError: null })
        .where(eq(screenshots.id, broken));
      const ok = await as(rs.editor).inbox.approve.mutate({ runId: rs.runId });
      expect(ok).toEqual({ runId: rs.runId, approved: true });
      expect(await decisionsOf([rs.runId])).toHaveLength(2);
    });

    test("listCheckpoints returns diffFailedAt and diffError per step; getStep the step's numbers", async () => {
      const rs = await seed({
        checkpoints: [
          { name: "broken", verdict: "unresolved" },
          { name: "home", verdict: "unresolved" },
          { name: "fresh", verdict: "new" },
          { name: "legacy", verdict: "passed" },
        ],
      });
      // A step diffed before the per-step columns is still at version 0.
      await h.db
        .update(screenshots)
        .set({ diffGeneration: 0 })
        .where(eq(screenshots.id, rs.shots.legacy!.id));
      const failedAt = new Date("2026-10-20T10:00:00.000Z");
      await h.db
        .update(screenshots)
        .set({ diffFailedAt: failedAt, diffError: "timeout" })
        .where(eq(screenshots.id, rs.shots.broken!.id));
      await h.db
        .update(screenshots)
        .set({ diffPercent: 3.5, vlmDescription: "The header moved." })
        .where(eq(screenshots.id, rs.shots.home!.id));

      const { items: listed } = await as(rs.editor).runs.listCheckpoints.query({
        runId: rs.runId,
      });
      // The step list carries the failure; the step's numbers and version are
      // getStep's (spec 2026-10-27 §5): each item with its step's row.
      const items = await Promise.all(
        listed.map(async (item) => {
          const { step } = await as(rs.editor).runs.getStep.query({
            runId: rs.runId,
            checkpointId: item.id,
          });
          expect(step).toMatchObject({
            diffFailedAt: item.diffFailedAt,
            diffError: item.diffError,
          });
          return { ...item, ...step };
        }),
      );

      const byName = new Map(items.map((i) => [i.name, i]));
      expect(byName.get("broken")).toMatchObject({
        // Over the wire (no transformer) a timestamp is its ISO string.
        diffFailedAt: failedAt.toISOString(),
        diffError: "timeout",
        diffPercent: null,
        vlmDescription: null,
      });
      expect(byName.get("home")).toMatchObject({
        diffFailedAt: null,
        diffError: null,
        diffPercent: 3.5,
        vlmDescription: "The header moved.",
      });
      // A step with no per-step result reads null everywhere.
      expect(byName.get("fresh")).toMatchObject({
        diffFailedAt: null,
        diffError: null,
        diffPercent: null,
        vlmDescription: null,
      });
      // The version tells a legacy step (0: the run's numbers stand in for
      // its own) from one the per-step pipeline queued (>= 1: NULL means no
      // result), which is what the viewer's fallback keys on (Ruling R46).
      expect(items.map((i) => [i.name, i.diffGeneration])).toEqual([
        ["broken", 1],
        ["home", 1],
        ["fresh", 1],
        ["legacy", 0],
      ]);
    });
  });
});
