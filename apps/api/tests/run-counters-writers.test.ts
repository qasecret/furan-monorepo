import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";

import {
  and,
  baselines,
  checkpointDecisions,
  computeRunCounters,
  COUNTERS_BACKFILL_SQL,
  count,
  eq,
  healPipelineAbort,
  inArray,
  isNotNull,
  loadRollupInputs,
  markStepDiffFailed,
  recomputeRunStatus,
  recomputeRunTotals,
  screenshots,
  sql,
  testRuns,
  withProjectScope,
  type RunCounters,
} from "@furan/db";
import type { CheckpointVerdict } from "@furan/shared-types";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  pendingCountsByRun,
  pendingStepCondition,
} from "../src/lib/review/pending.js";
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

/**
 * The stored pending counters (`test_runs.pending_steps` / `failed_steps`,
 * spec 2026-10-27 speed-at-scale server reads §3) have one writer,
 * `recomputeRunStatus`, and every write path that changes one of their inputs
 * calls it in its transaction (§3.2). Each test drives one writer through the
 * real API (or, for the diff pipeline's writes, the same `@furan/db` calls the
 * worker makes) and asserts stored = computed: what `computeRunCounters` gives
 * for the run as it now stands, which is also the expected number.
 *
 * The seeds start with consistent counters (`review-fixtures.ts`), so a writer
 * that forgot to recompute leaves the old, now wrong, value behind.
 *
 * The last block binds the stored definition to the API's canonical one:
 * `pendingStepCondition` (Ruling R4).
 */
const skip = !process.env.DATABASE_URL;
const d = skip ? describe.skip : describe;
const needsS3 =
  !process.env.S3_ENDPOINT ||
  !process.env.S3_BUCKET ||
  !process.env.S3_ACCESS_KEY ||
  !process.env.S3_SECRET_KEY;

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII=",
  "base64",
);

d("run counters: every writer leaves stored = computed", () => {
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
   * a final failure or a retry finds the version it expects.
   */
  async function seed(spec: ReviewRunSpec): Promise<ReviewSeed> {
    const s = await seedReviewRun(h, spec);
    seeds.push(s);
    await h.db
      .update(screenshots)
      .set({ diffGeneration: 1 })
      .where(eq(screenshots.runId, s.runId));
    return s;
  }

  /** The run's status and stored counters. */
  async function stored(
    runId: string,
  ): Promise<{ status: string } & RunCounters> {
    const [row] = await h.db
      .select({
        status: testRuns.status,
        pendingSteps: testRuns.pendingSteps,
        failedSteps: testRuns.failedSteps,
      })
      .from(testRuns)
      .where(eq(testRuns.id, runId));
    return row!;
  }

  /**
   * Asserts the run's stored counters are what the definition gives for the
   * run as it now stands (judged by its stored status, as
   * `reviewableRunCondition` is), and that they are `expected`.
   */
  async function expectCounters(
    runId: string,
    expected: RunCounters,
  ): Promise<void> {
    const input = (await loadRollupInputs(h.db, [runId])).get(runId)!;
    const computed = computeRunCounters(input, input.lifecycle);
    const { pendingSteps, failedSteps } = await stored(runId);
    expect({ pendingSteps, failedSteps }).toEqual(computed);
    expect(computed).toEqual(expected);
  }

  /**
   * A diff commit's writes, through the calls `commitStep` (diff-worker) makes
   * in its one transaction: the run lock, the step lock, the verdict (a
   * success clears an earlier failure), the totals, the abort heal, and the
   * status and counters last.
   */
  async function commitVerdict(
    s: ReviewSeed,
    runId: string,
    stepId: string,
    verdict: CheckpointVerdict,
  ): Promise<void> {
    await withProjectScope(h.db, s.projectId, async (tx) => {
      await tx
        .select({ id: testRuns.id })
        .from(testRuns)
        .where(eq(testRuns.id, runId))
        .for("no key update");
      await tx
        .select({ id: screenshots.id })
        .from(screenshots)
        .where(eq(screenshots.id, stepId))
        .for("update");
      await tx
        .update(screenshots)
        .set({
          verdict,
          verdictAt: sql`clock_timestamp()`,
          diffFailedAt: null,
          diffError: null,
        })
        .where(eq(screenshots.id, stepId));
      await recomputeRunTotals(tx, runId);
      await healPipelineAbort(tx, runId);
      await recomputeRunStatus(tx, runId);
    });
  }

  /** A diff job's final failure on the step (`markStepDiffFailed`). */
  async function failFinally(
    s: ReviewSeed,
    runId: string,
    stepId: string,
  ): Promise<void> {
    const out = await withProjectScope(h.db, s.projectId, (tx) =>
      markStepDiffFailed(tx, {
        runId,
        stepId,
        generation: 1,
        code: "engine_error",
      }),
    );
    expect(out.applied).toBe(true);
  }

  test("an approve decision, then its undo", async () => {
    const s = await seed({
      checkpoints: [
        { name: "a", verdict: "unresolved" },
        { name: "b", verdict: "unresolved" },
        { name: "c", verdict: "new" },
      ],
    });
    await expectCounters(s.runId, { pendingSteps: 3, failedSteps: 0 });

    const actionId = randomUUID();
    await as(s.editor).review.approve.mutate({
      runId: s.runId,
      actionId,
      checkpointIds: [s.shots.a!.id],
    });
    await expectCounters(s.runId, { pendingSteps: 2, failedSteps: 0 });

    await as(s.editor).review.revert.mutate({ actionId });
    await expectCounters(s.runId, { pendingSteps: 3, failedSteps: 0 });
  });

  test("a reject decision, then its undo", async () => {
    const s = await seed({
      checkpoints: [
        { name: "a", verdict: "unresolved" },
        { name: "b", verdict: "new" },
      ],
    });
    const actionId = randomUUID();
    await as(s.editor).review.reject.mutate({
      runId: s.runId,
      actionId,
      checkpointIds: [s.shots.b!.id],
    });
    await expectCounters(s.runId, { pendingSteps: 1, failedSteps: 0 });
    expect((await stored(s.runId)).status).toBe("failed");

    await as(s.editor).review.revert.mutate({ actionId });
    await expectCounters(s.runId, { pendingSteps: 2, failedSteps: 0 });
  });

  test("a diff commit that turns a step unresolved", async () => {
    const s = await seed({
      checkpoints: [
        { name: "a", verdict: "passed" },
        { name: "b", verdict: "passed" },
      ],
    });
    await expectCounters(s.runId, { pendingSteps: 0, failedSteps: 0 });

    await commitVerdict(s, s.runId, s.shots.b!.id, "unresolved");
    expect((await stored(s.runId)).status).toBe("unresolved");
    await expectCounters(s.runId, { pendingSteps: 1, failedSteps: 0 });

    // And back: a re-diff that passes it.
    await commitVerdict(s, s.runId, s.shots.b!.id, "passed");
    await expectCounters(s.runId, { pendingSteps: 0, failedSteps: 0 });
  });

  test("a final failure, then retryDiff", async () => {
    const s = await seed({
      checkpoints: [
        { name: "a", verdict: "unresolved" },
        { name: "b", verdict: "passed" },
      ],
    });
    await expectCounters(s.runId, { pendingSteps: 1, failedSteps: 0 });

    await failFinally(s, s.runId, s.shots.b!.id);
    await expectCounters(s.runId, { pendingSteps: 2, failedSteps: 1 });

    const out = await as(s.editor).runs.retryDiff.mutate({
      runId: s.runId,
      checkpointId: s.shots.b!.id,
    });
    // The retried step has no verdict: the run is running, and not
    // reviewable until its diff lands.
    expect(out).toEqual({ status: "running" });
    await expectCounters(s.runId, { pendingSteps: 0, failedSteps: 0 });

    // The new diff lands.
    await commitVerdict(s, s.runId, s.shots.b!.id, "unresolved");
    await expectCounters(s.runId, { pendingSteps: 2, failedSteps: 0 });
  });

  test("a status override set, then cleared", async () => {
    const s = await seed({
      checkpoints: [
        { name: "a", verdict: "unresolved" },
        { name: "b", verdict: "new" },
      ],
    });
    await expectCounters(s.runId, { pendingSteps: 2, failedSteps: 0 });

    await as(s.editor).runs.overrideStatus.mutate({
      runId: s.runId,
      status: "passed",
    });
    expect((await stored(s.runId)).status).toBe("passed");
    await expectCounters(s.runId, { pendingSteps: 0, failedSteps: 0 });

    await as(s.editor).runs.overrideStatus.mutate({
      runId: s.runId,
      status: "default",
    });
    expect((await stored(s.runId)).status).toBe("unresolved");
    await expectCounters(s.runId, { pendingSteps: 2, failedSteps: 0 });
  });

  test("branch merge", async () => {
    const s = await seed({
      checkpoints: [
        { name: "a", verdict: "passed" },
        { name: "b", verdict: "unresolved" },
      ],
    });
    // The seed run's steps are the source branch's baselines.
    await h.db.insert(baselines).values(
      s.shotsInOrder.map((shot) => ({
        testVariationId: shot.variationId,
        testRunId: s.runId,
        baselineName: `merge-${shot.name}-${s.tag}`,
        branchName: s.branch,
      })),
    );

    const res = await as(s.editor).projects.mergeBranchBaselines.mutate({
      projectId: s.projectId,
      fromBranch: s.branch,
      toBranch: `main-${s.tag}`,
    });
    expect(res.runCount).toBe(2);

    const merged = await h.db
      .select({ id: testRuns.id })
      .from(testRuns)
      .where(
        and(
          eq(testRuns.projectId, s.projectId),
          eq(testRuns.branchName, `main-${s.tag}`),
        ),
      );
    expect(merged).toHaveLength(2);
    for (const { id } of merged) {
      expect((await stored(id)).status).toBe("running");
      await expectCounters(id, { pendingSteps: 0, failedSteps: 0 });
    }
  });

  test.skipIf(needsS3)(
    "an upload of a new undiffed step into a reviewable run: the counters drop to 0",
    async () => {
      const s = await seed({
        checkpoints: [
          { name: "a", verdict: "unresolved" },
          { name: "b", verdict: "new" },
        ],
      });
      await expectCounters(s.runId, { pendingSteps: 2, failedSteps: 0 });

      const res = await h.app.inject({
        method: "POST",
        url: `/runs/${s.runId}/screenshots/base64`,
        headers: {
          authorization: `Bearer ${s.editor.jwt}`,
          "content-type": "application/json",
        },
        payload: {
          pngBase64: TINY_PNG.toString("base64"),
          name: `late-${s.tag}`,
          viewport: "1280x720",
          browser: "chromium",
        },
      });
      expect(res.statusCode).toBe(200);
      expect((await stored(s.runId)).status).toBe("running");
      await expectCounters(s.runId, { pendingSteps: 0, failedSteps: 0 });

      // Once the new step's diff lands, the run is reviewable again.
      const { screenshotId } = res.json() as { screenshotId: string };
      await h.db
        .update(screenshots)
        .set({ diffGeneration: 1 })
        .where(eq(screenshots.id, screenshotId));
      await commitVerdict(s, s.runId, screenshotId, "new");
      await expectCounters(s.runId, { pendingSteps: 3, failedSteps: 0 });
    },
  );

  test("SDK abort", async () => {
    const s = await seed({
      checkpoints: [
        { name: "a", verdict: "unresolved" },
        { name: "b", verdict: "passed" },
      ],
    });
    await failFinally(s, s.runId, s.shots.b!.id);
    await expectCounters(s.runId, { pendingSteps: 2, failedSteps: 1 });

    const res = await h.app.inject({
      method: "POST",
      url: `/runs/${s.runId}/abort`,
      headers: { authorization: `Bearer ${s.editor.jwt}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ runId: s.runId, status: "aborted" });
    expect((await stored(s.runId)).status).toBe("aborted");
    await expectCounters(s.runId, { pendingSteps: 0, failedSteps: 0 });
  });

  test("SDK /complete: emptying a run with no step, and closing a run with steps", async () => {
    // A run with no step, whose counters are stale: emptying it (a lifecycle
    // write) recomputes them.
    const s = await seed({ checkpoints: [] });
    await h.db
      .update(testRuns)
      .set({ pendingSteps: 2, failedSteps: 1 })
      .where(eq(testRuns.id, s.runId));
    const emptied = await h.app.inject({
      method: "POST",
      url: `/runs/${s.runId}/complete`,
      headers: { authorization: `Bearer ${s.editor.jwt}` },
    });
    expect(emptied.statusCode).toBe(200);
    expect((await stored(s.runId)).status).toBe("empty");
    await expectCounters(s.runId, { pendingSteps: 0, failedSteps: 0 });

    // A run with steps: /complete stamps completion only, no input changes.
    const withSteps = await addReviewRun(h, s, {
      checkpoints: [{ name: "a", verdict: "unresolved" }],
    });
    const closed = await h.app.inject({
      method: "POST",
      url: `/runs/${withSteps.runId}/complete`,
      headers: { authorization: `Bearer ${s.editor.jwt}` },
    });
    expect(closed.statusCode).toBe(200);
    expect((await stored(withSteps.runId)).status).toBe("unresolved");
    await expectCounters(withSteps.runId, { pendingSteps: 1, failedSteps: 0 });
  });

  test("a burst of decisions and commits on one run leaves stored = computed", async () => {
    const approve = Array.from({ length: 10 }, (_, i) => ({
      name: `approve-${i}`,
      verdict: "unresolved" as const,
    }));
    const commit = Array.from({ length: 5 }, (_, i) => ({
      name: `commit-${i}`,
      verdict: "passed" as const,
    }));
    const s = await seed({ checkpoints: [...approve, ...commit] });
    await expectCounters(s.runId, { pendingSteps: 10, failedSteps: 0 });

    const client = as(s.editor);
    await Promise.all([
      // Ten reviewers approve one step each...
      ...approve.map(({ name }) =>
        client.review.approve.mutate({
          runId: s.runId,
          actionId: randomUUID(),
          checkpointIds: [s.shots[name]!.id],
        }),
      ),
      // ...while five diff commits land on the other steps: three new
      // differences and two final failures.
      ...commit
        .slice(0, 3)
        .map(({ name }) =>
          commitVerdict(s, s.runId, s.shots[name]!.id, "unresolved"),
        ),
      ...commit
        .slice(3)
        .map(({ name }) => failFinally(s, s.runId, s.shots[name]!.id)),
    ]);

    // Whatever the order, the end state is one: the ten approved, the five
    // committed steps pending, two of them failed.
    expect((await stored(s.runId)).status).toBe("unresolved");
    await expectCounters(s.runId, { pendingSteps: 5, failedSteps: 2 });
  });

  describe("the stored definition is the API's (Ruling R4)", () => {
    /**
     * Per run, the API's own counts: `pendingStepCondition()` (no facets)
     * grouped per run for `pending_steps`, and the same plus
     * `diff_failed_at IS NOT NULL` for `failed_steps`.
     */
    async function canonical(
      projectId: string,
      runIds: string[],
    ): Promise<Map<string, RunCounters>> {
      const pending = await pendingCountsByRun(h.db, { projectId, runIds });
      const failedRows = await h.db
        .select({ id: screenshots.runId, failed: count() })
        .from(screenshots)
        .innerJoin(testRuns, eq(testRuns.id, screenshots.runId))
        .where(
          and(
            eq(testRuns.projectId, projectId),
            eq(screenshots.projectId, projectId),
            inArray(testRuns.id, runIds),
            pendingStepCondition(),
            isNotNull(screenshots.diffFailedAt),
          ),
        )
        .groupBy(screenshots.runId);
      const failed = new Map(failedRows.map((r) => [r.id, r.failed]));
      return new Map(
        runIds.map((id) => [
          id,
          {
            pendingSteps: pending.get(id) ?? 0,
            failedSteps: failed.get(id) ?? 0,
          },
        ]),
      );
    }

    async function storedCounters(
      runIds: string[],
    ): Promise<Map<string, RunCounters>> {
      const rows = await h.db
        .select({
          id: testRuns.id,
          pendingSteps: testRuns.pendingSteps,
          failedSteps: testRuns.failedSteps,
        })
        .from(testRuns)
        .where(inArray(testRuns.id, runIds));
      return new Map(
        rows.map((r) => [
          r.id,
          { pendingSteps: r.pendingSteps, failedSteps: r.failedSteps },
        ]),
      );
    }

    /** Stale counters on every run, so the next writer must set each one. */
    async function scramble(runIds: string[]): Promise<void> {
      await h.db
        .update(testRuns)
        .set({ pendingSteps: 7, failedSteps: 3 })
        .where(inArray(testRuns.id, runIds));
    }

    test("pending_steps and failed_steps equal pendingStepCondition, after the backfill and after recomputeRunStatus", async () => {
      const s = await seed({
        checkpoints: [
          { name: "new", verdict: "new" },
          { name: "open", verdict: "unresolved" },
          { name: "passed", verdict: "passed" },
          { name: "approved", verdict: "unresolved" },
          { name: "rejected", verdict: "new" },
          { name: "undone", verdict: "unresolved" },
          { name: "failed", verdict: "passed" },
          { name: "failed-rejected", verdict: "passed" },
        ],
      });
      // Decisions, an undone one, and two failed diffs (one decided).
      const decide = async (
        runId: string,
        ids: string[],
        kind: "approve" | "reject",
      ) => {
        const actionId = randomUUID();
        await as(s.editor).review[kind].mutate({
          runId,
          actionId,
          checkpointIds: ids,
        });
        return actionId;
      };
      await failFinally(s, s.runId, s.shots.failed!.id);
      await failFinally(s, s.runId, s.shots["failed-rejected"]!.id);
      await decide(s.runId, [s.shots.approved!.id], "approve");
      await decide(s.runId, [s.shots.rejected!.id], "reject");
      const undone = await decide(s.runId, [s.shots.undone!.id], "approve");
      await as(s.editor).review.revert.mutate({ actionId: undone });
      // A failed step cannot be decided through the API (`diff_failed`); one
      // decided before the rule existed is still not pending.
      await h.db.insert(checkpointDecisions).values({
        projectId: s.projectId,
        runId: s.runId,
        screenshotId: s.shots["failed-rejected"]!.id,
        actionId: randomUUID(),
        decision: "rejected",
        actorId: s.editor.id,
        source: "viewer",
      });
      await recomputeRunStatus(h.db, s.runId);

      const runIds = [
        s.runId,
        (
          await addReviewRun(h, s, {
            checkpoints: [
              { name: "x", verdict: "new" },
              { name: "y", verdict: "new" },
            ],
          })
        ).runId,
        (
          await addReviewRun(h, s, {
            checkpoints: [{ name: "x", verdict: "passed" }],
          })
        ).runId,
        // Not reviewable.
        (
          await addReviewRun(h, s, {
            checkpoints: [
              { name: "x", verdict: "unresolved" },
              { name: "y", verdict: null },
            ],
            lifecycle: "running",
          })
        ).runId,
        (
          await addReviewRun(h, s, {
            checkpoints: [{ name: "x", verdict: "unresolved" }],
            lifecycle: "aborted",
          })
        ).runId,
        (
          await addReviewRun(h, s, {
            checkpoints: [{ name: "x", verdict: "new" }],
            lifecycle: "empty",
          })
        ).runId,
        (
          await addReviewRun(h, s, {
            checkpoints: [{ name: "x", verdict: "unresolved" }],
            override: "failed",
          })
        ).runId,
        // An undiffed step under a stored reviewable status: only the
        // definition's undiffed-step clause keeps it at 0.
        (
          await addReviewRun(h, s, {
            checkpoints: [
              { name: "x", verdict: "unresolved" },
              { name: "y", verdict: null },
            ],
            lifecycle: "unresolved",
          })
        ).runId,
        (await addReviewRun(h, s, { checkpoints: [] })).runId,
      ];

      // The mix: pending and failed steps on the decided run, a plain
      // pending run, and the rest at 0.
      const expected = await canonical(s.projectId, runIds);
      expect(expected.get(s.runId)).toEqual({
        pendingSteps: 4,
        failedSteps: 1,
      });
      expect(expected.get(runIds[1]!)).toEqual({
        pendingSteps: 2,
        failedSteps: 0,
      });
      expect(
        [...expected.values()].filter((c) => c.pendingSteps === 0),
      ).toHaveLength(runIds.length - 2);

      // 1. The migration's backfill.
      await scramble(runIds);
      await h.db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL client_min_messages = warning`);
        await tx.execute(sql.raw(COUNTERS_BACKFILL_SQL));
      });
      expect(await storedCounters(runIds)).toEqual(expected);

      // 2. The writer, run by run. One status moves (the undiffed run's stale
      // `unresolved` becomes `running`), so the canonical counts are taken
      // again on the rows as they now stand; nothing reviewable changed, so
      // they are the same.
      await scramble(runIds);
      for (const runId of runIds) await recomputeRunStatus(h.db, runId);
      expect(await storedCounters(runIds)).toEqual(
        await canonical(s.projectId, runIds),
      );
      expect(await storedCounters(runIds)).toEqual(expected);
    });
  });
});
