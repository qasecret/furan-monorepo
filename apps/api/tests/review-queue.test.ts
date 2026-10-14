import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";

import {
  builds,
  checkpointDecisions,
  eq,
  inArray,
  screenshots,
  testRuns,
  withUserScope,
  type DB,
} from "@furan/db";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  pendingCountsByBuild,
  pendingCountsByRun,
  type StepFacets,
} from "../src/lib/review/pending.js";
import {
  findNext,
  type NextInput,
  type NextResult,
  type QueueAt,
} from "../src/lib/review/queue.js";
import { selectPendingTargets } from "../src/lib/review/targets.js";
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

function makeClient(baseUrl: string, jwt: string) {
  return createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: `${baseUrl}/trpc`,
        headers: { authorization: `Bearer ${jwt}` },
      }),
    ],
  });
}

/** Counts the statements issued on the handle (`select*` / `execute`). */
function countingDb(db: DB): { db: DB; count: () => number } {
  let n = 0;
  const counted = new Set([
    "select",
    "selectDistinct",
    "selectDistinctOn",
    "execute",
  ]);
  const proxy = new Proxy(db, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (counted.has(String(prop))) n++;
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { db: proxy, count: () => n };
}

const MOBILE = "375x812";
const DESKTOP = "1280x720";

/** A step position: the batch, and optionally its run and step. */
function at(buildId: string, runId?: string, step?: { id: string }): QueueAt {
  return {
    buildId,
    ...(runId ? { runId } : {}),
    ...(step ? { checkpointId: step.id } : {}),
  };
}

/** The target a `findNext` result names. */
function tgt(buildId: string, runId: string, step: { id: string }) {
  return { buildId, runId, checkpointId: step.id };
}

const NOTHING_LEFT = { run: 0, batch: 0, batchUnfiltered: 0 };

d("review queue: findNext", () => {
  let h: TestApp;
  let baseUrl: string;
  const seeds: ReviewSeed[] = [];

  beforeAll(async () => {
    h = await createTestApp();
    h.app.log.level = "silent";
    await h.app.listen({ port: 0, host: "127.0.0.1" });
    const addr = h.app.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });
  afterAll(async () => {
    await cleanupReviewSeeds(h, seeds);
    await h.close();
  });

  async function seed(
    spec: ReviewRunSpec,
    opts?: { branch?: string },
  ): Promise<ReviewSeed> {
    const s = await seedReviewRun(h, spec, opts);
    seeds.push(s);
    return s;
  }

  /**
   * `findNext` as the seed's editor would run it: on the app's connection
   * (the non-owner role under TEST_RLS=1), in a user-scoped transaction.
   */
  function next(
    s: ReviewSeed,
    input: Omit<NextInput, "projectId"> = {},
    wrap: (db: DB) => DB = (db) => db,
  ): Promise<NextResult> {
    return withUserScope(
      h.app.db,
      { userId: s.editor.id, role: "editor", projectId: s.projectId },
      (tx) => findNext(wrap(tx), { projectId: s.projectId, ...input }),
    );
  }

  /** An active decision on a step (an approve unless `decision`). */
  async function decide(
    s: ReviewSeed,
    runId: string,
    step: { id: string },
    opts: { reverted?: boolean; decision?: "approved" | "rejected" } = {},
  ): Promise<void> {
    await h.db.insert(checkpointDecisions).values({
      projectId: s.projectId,
      runId,
      screenshotId: step.id,
      actionId: randomUUID(),
      decision: opts.decision ?? "approved",
      actorId: s.editor.id,
      source: "viewer",
      before: null,
      revertedAt: opts.reverted ? new Date() : null,
      revertedBy: opts.reverted ? s.editor.id : null,
    });
  }

  /** Sets the builds' `created_at`, oldest first, 1 s apart. */
  async function orderBuilds(buildIds: string[]): Promise<void> {
    const base = Date.now() - 7_200_000;
    for (const [i, id] of buildIds.entries()) {
      await h.db
        .update(builds)
        .set({ createdAt: new Date(base + i * 1_000) })
        .where(eq(builds.id, id));
    }
  }

  async function runCreatedAt(runId: string): Promise<Date> {
    const [r] = await h.db
      .select({ createdAt: testRuns.createdAt })
      .from(testRuns)
      .where(eq(testRuns.id, runId));
    return r!.createdAt;
  }

  test("next pending step in the same run", async () => {
    const s = await seed({
      checkpoints: [
        { name: "a", verdict: "unresolved" },
        { name: "b", verdict: "passed" },
        { name: "c", verdict: "new" },
        { name: "d", verdict: "unresolved" },
      ],
    });
    const [a, b, c, d2] = s.shotsInOrder;

    expect(await next(s, { at: at(s.buildId, s.runId, a) })).toEqual({
      target: tgt(s.buildId, s.runId, c!),
      scope: "run",
      remaining: { run: 2, batch: 2, batchUnfiltered: 2, projectBatches: 1 },
      nextBatch: null,
    });
    // A step that is not pending itself (b passed) still anchors the walk.
    expect(await next(s, { at: at(s.buildId, s.runId, b) })).toEqual({
      target: tgt(s.buildId, s.runId, c!),
      scope: "run",
      remaining: { run: 3, batch: 3, batchUnfiltered: 3, projectBatches: 1 },
      nextBatch: null,
    });
    expect((await next(s, { at: at(s.buildId, s.runId, c) })).target).toEqual(
      tgt(s.buildId, s.runId, d2!),
    );
  });

  test("crosses into the next run in capture order", async () => {
    const s = await seed({
      checkpoints: [
        { name: "a", verdict: "unresolved" },
        { name: "b", verdict: "passed" },
      ],
    });
    // Runs with no pending step are skipped: one all passed, one still
    // running, one overridden, one with an undiffed sibling step.
    await addReviewRun(h, s, {
      checkpoints: [{ name: "p", verdict: "passed" }],
    });
    await addReviewRun(h, s, {
      lifecycle: "running",
      checkpoints: [{ name: "q", verdict: "unresolved" }],
    });
    await addReviewRun(h, s, {
      override: "failed",
      checkpoints: [{ name: "o", verdict: "unresolved" }],
    });
    await addReviewRun(h, s, {
      checkpoints: [
        { name: "u", verdict: "unresolved" },
        { name: "v", verdict: null },
      ],
    });
    const r3 = await addReviewRun(h, s, {
      checkpoints: [
        { name: "x", verdict: "passed" },
        { name: "y", verdict: "new" },
      ],
    });

    expect(
      await next(s, { at: at(s.buildId, s.runId, s.shotsInOrder[0]) }),
    ).toEqual({
      target: tgt(s.buildId, r3.runId, r3.shots.y!),
      scope: "batch",
      remaining: { run: 0, batch: 1, batchUnfiltered: 1, projectBatches: 1 },
      nextBatch: null,
    });
    // From the last step of the run (not pending), likewise.
    expect(
      (await next(s, { at: at(s.buildId, s.runId, s.shotsInOrder[1]) })).target,
    ).toEqual(tgt(s.buildId, r3.runId, r3.shots.y!));
  });

  test("wraps to earlier skipped steps of the batch", async () => {
    const s = await seed({
      checkpoints: [
        { name: "a", verdict: "unresolved" },
        { name: "b", verdict: "unresolved" },
      ],
    });
    const [a, b] = s.shotsInOrder;
    const r2 = await addReviewRun(h, s, {
      checkpoints: [
        { name: "c", verdict: "new" },
        { name: "z", verdict: "passed" },
      ],
    });
    const c = r2.shots.c!;

    // From the batch's last pending step, back to its first (skipped) one.
    expect(await next(s, { at: at(s.buildId, r2.runId, c) })).toEqual({
      target: tgt(s.buildId, s.runId, a!),
      scope: "batch",
      remaining: { run: 0, batch: 2, batchUnfiltered: 2, projectBatches: 1 },
      nextBatch: null,
    });
    // From the very last step (passed): the same.
    expect(
      (await next(s, { at: at(s.buildId, r2.runId, r2.shots.z) })).target,
    ).toEqual(tgt(s.buildId, s.runId, a!));

    // c decided: from b, the only pending step left is a, earlier in b's run.
    await decide(s, r2.runId, c);
    expect(await next(s, { at: at(s.buildId, s.runId, b) })).toEqual({
      target: tgt(s.buildId, s.runId, a!),
      scope: "run",
      remaining: { run: 1, batch: 1, batchUnfiltered: 1, projectBatches: 1 },
      nextBatch: null,
    });
    // A run position after every pending step wraps to the batch's start.
    expect(await next(s, { at: at(s.buildId, r2.runId) })).toEqual({
      target: tgt(s.buildId, s.runId, a!),
      scope: "batch",
      remaining: { run: 0, batch: 2, batchUnfiltered: 2, projectBatches: 1 },
      nextBatch: null,
    });
  });

  test("never returns the step at 'at'", async () => {
    const s = await seed({
      checkpoints: [
        { name: "only", verdict: "unresolved" },
        { name: "done", verdict: "passed" },
      ],
    });
    const here = at(s.buildId, s.runId, s.shots.only);
    for (const direction of ["next", "prev"] as const) {
      expect(await next(s, { at: here, direction })).toEqual({
        target: null,
        scope: "none",
        remaining: { ...NOTHING_LEFT, projectBatches: 0 },
        nextBatch: null,
      });
    }

    // With another batch pending it hands off, still never back to `at`.
    const other = await addReviewBuild(h, s, {
      spec: { checkpoints: [{ name: "other", verdict: "new" }] },
    });
    for (const direction of ["next", "prev"] as const) {
      expect(await next(s, { at: here, direction })).toEqual({
        target: tgt(other.buildId, other.runId, other.shots.other!),
        scope: "nextBatch",
        remaining: { ...NOTHING_LEFT, projectBatches: 1 },
        nextBatch: {
          buildId: other.buildId,
          name: `run-${s.tag}`,
          number: null,
          branch: s.branch,
          pending: 1,
        },
      });
    }
  });

  test("direction prev walks backwards with wrap", async () => {
    const s = await seed({
      checkpoints: [
        { name: "a", verdict: "unresolved" },
        { name: "b", verdict: "new" },
      ],
    });
    const [a, b] = s.shotsInOrder;
    const r2 = await addReviewRun(h, s, {
      checkpoints: [
        { name: "c", verdict: "unresolved" },
        { name: "x", verdict: "passed" },
        { name: "d", verdict: "unresolved" },
      ],
    });
    const { c, d: d2 } = r2.shots;
    const prev = (where: QueueAt) => next(s, { at: where, direction: "prev" });

    expect(await prev(at(s.buildId, r2.runId, d2))).toEqual({
      target: tgt(s.buildId, r2.runId, c!),
      scope: "run",
      remaining: { run: 1, batch: 3, batchUnfiltered: 3, projectBatches: 1 },
      nextBatch: null,
    });
    // Skips the passed step between them.
    expect(
      (await prev(at(s.buildId, r2.runId, r2.shots.x))).target,
    ).toMatchObject(tgt(s.buildId, r2.runId, c!));
    expect(await prev(at(s.buildId, r2.runId, c))).toMatchObject({
      target: tgt(s.buildId, s.runId, b!),
      scope: "batch",
    });
    expect(await prev(at(s.buildId, s.runId, b))).toMatchObject({
      target: tgt(s.buildId, s.runId, a!),
      scope: "run",
    });
    // From the first pending step it wraps to the batch's last.
    expect(await prev(at(s.buildId, s.runId, a))).toMatchObject({
      target: tgt(s.buildId, r2.runId, d2!),
      scope: "batch",
    });

    // A run position: prev starts after the run's last step, next before its
    // first. A batch position: prev from the end, next from the start.
    expect(await prev(at(s.buildId, r2.runId))).toMatchObject({
      target: tgt(s.buildId, r2.runId, d2!),
      scope: "run",
    });
    expect(await prev(at(s.buildId, s.runId))).toMatchObject({
      target: tgt(s.buildId, s.runId, b!),
      scope: "run",
    });
    expect(await prev(at(s.buildId))).toEqual({
      target: tgt(s.buildId, r2.runId, d2!),
      scope: "batch",
      remaining: { run: 0, batch: 4, batchUnfiltered: 4, projectBatches: 1 },
      nextBatch: null,
    });
    expect(await next(s, { at: at(s.buildId, r2.runId) })).toMatchObject({
      target: tgt(s.buildId, r2.runId, c!),
      scope: "run",
      remaining: { run: 2, batch: 4 },
    });
    expect(await next(s, { at: at(s.buildId) })).toMatchObject({
      target: tgt(s.buildId, s.runId, a!),
      scope: "batch",
    });
  });

  test("facets scope the target and remaining.batch, not batchUnfiltered", async () => {
    const mobile: StepFacets = { viewport: MOBILE };
    const desktop: StepFacets = { viewport: DESKTOP };
    const s = await seed({
      checkpoints: [
        { name: "a", verdict: "unresolved", viewport: DESKTOP },
        { name: "b", verdict: "unresolved", viewport: MOBILE },
      ],
    });
    const { a, b } = s.shots;
    const r2 = await addReviewRun(h, s, {
      checkpoints: [
        { name: "c", verdict: "new", viewport: MOBILE },
        { name: "d", verdict: "unresolved", viewport: DESKTOP },
      ],
    });
    const { c, d: d2 } = r2.shots;
    await addReviewRun(h, s, {
      checkpoints: [
        { name: "e", verdict: "unresolved", viewport: DESKTOP },
        { name: "f", verdict: "passed", viewport: MOBILE },
      ],
    });

    expect(
      await next(s, { at: at(s.buildId, s.runId, b), facets: mobile }),
    ).toEqual({
      target: tgt(s.buildId, r2.runId, c!),
      scope: "batch",
      // run: R1's mobile steps but b (none); batch: c; unfiltered: a c d e.
      remaining: { run: 0, batch: 1, batchUnfiltered: 4, projectBatches: 1 },
      nextBatch: null,
    });
    // No mobile step after c (f is passed): wraps to b.
    expect(
      await next(s, { at: at(s.buildId, r2.runId, c), facets: mobile }),
    ).toEqual({
      target: tgt(s.buildId, s.runId, b!),
      scope: "batch",
      remaining: { run: 0, batch: 1, batchUnfiltered: 4, projectBatches: 1 },
      nextBatch: null,
    });
    // A step outside the facets anchors the walk too.
    expect(
      await next(s, { at: at(s.buildId, s.runId, a), facets: mobile }),
    ).toEqual({
      target: tgt(s.buildId, s.runId, b!),
      scope: "run",
      remaining: { run: 1, batch: 2, batchUnfiltered: 4, projectBatches: 1 },
      nextBatch: null,
    });
    // The desktop facet skips the mobile steps b and c.
    expect(
      await next(s, { at: at(s.buildId, s.runId, a), facets: desktop }),
    ).toEqual({
      target: tgt(s.buildId, r2.runId, d2!),
      scope: "batch",
      remaining: { run: 0, batch: 2, batchUnfiltered: 4, projectBatches: 1 },
      nextBatch: null,
    });
    // Facets given together hold on one step.
    expect(
      await next(s, {
        at: at(s.buildId),
        facets: { viewport: MOBILE, browser: "firefox" },
      }),
    ).toMatchObject({ target: null, scope: "none" });
    expect(
      (
        await next(s, {
          at: at(s.buildId, s.runId, a),
          facets: { viewport: DESKTOP, browser: "chromium" },
        })
      ).target,
    ).toEqual(tgt(s.buildId, r2.runId, d2!));

    // b decided: nothing left inside the facets but c, the step at hand.
    await decide(s, s.runId, b!);
    const fromC = at(s.buildId, r2.runId, c);
    expect(await next(s, { at: fromC, facets: mobile })).toEqual({
      target: null,
      scope: "none",
      remaining: { run: 0, batch: 0, batchUnfiltered: 3, projectBatches: 0 },
      nextBatch: null,
    });
    // Another batch pending on desktop only does not qualify under them...
    const desk = await addReviewBuild(h, s, {
      spec: {
        checkpoints: [{ name: "g", verdict: "unresolved", viewport: DESKTOP }],
      },
    });
    expect(await next(s, { at: fromC, facets: mobile })).toEqual({
      target: null,
      scope: "none",
      remaining: { run: 0, batch: 0, batchUnfiltered: 3, projectBatches: 0 },
      nextBatch: null,
    });
    expect(await next(s, { at: fromC })).toMatchObject({
      target: tgt(s.buildId, r2.runId, d2!),
      nextBatch: { buildId: desk.buildId, pending: 1 },
    });
    // ...one with a mobile pending step does, and its first pending step
    // INSIDE the facets is the target (not its earlier desktop step).
    const mob = await addReviewBuild(h, s, {
      spec: {
        checkpoints: [
          { name: "h", verdict: "unresolved", viewport: DESKTOP },
          { name: "i", verdict: "unresolved", viewport: MOBILE },
          { name: "j", verdict: "new", viewport: DESKTOP },
        ],
      },
    });
    expect(await next(s, { at: fromC, facets: mobile })).toEqual({
      target: tgt(mob.buildId, mob.runId, mob.shots.i!),
      scope: "nextBatch",
      remaining: { run: 0, batch: 0, batchUnfiltered: 3, projectBatches: 1 },
      nextBatch: {
        buildId: mob.buildId,
        name: `run-${s.tag}`,
        number: null,
        branch: s.branch,
        pending: 1,
      },
    });
  });

  test("nextBatch prefers the same branch, then the newest any branch", async () => {
    const s = await seed(
      { checkpoints: [{ name: "cur", verdict: "unresolved" }] },
      { branch: "main" },
    );
    const here = at(s.buildId, s.runId, s.shots.cur);
    const spec = (name: string): { spec: ReviewRunSpec } => ({
      spec: { checkpoints: [{ name, verdict: "unresolved" }] },
    });
    const mainOld = await addReviewBuild(h, s, {
      branch: "main",
      ...spec("m-old"),
    });
    const featureNew = await addReviewBuild(h, s, {
      branch: "feature",
      ...spec("f-new"),
    });
    const mainNewer = await addReviewBuild(h, s, {
      branch: "main",
      ...spec("m-newer"),
    });
    await orderBuilds([
      s.buildId,
      mainOld.buildId,
      featureNew.buildId,
      mainNewer.buildId,
    ]);
    await h.db
      .update(builds)
      .set({ name: "Main newer", number: 43 })
      .where(eq(builds.id, mainNewer.buildId));

    expect(await next(s, { at: here })).toEqual({
      target: tgt(
        mainNewer.buildId,
        mainNewer.runId,
        mainNewer.shots["m-newer"]!,
      ),
      scope: "nextBatch",
      remaining: { ...NOTHING_LEFT, projectBatches: 3 },
      nextBatch: {
        buildId: mainNewer.buildId,
        name: "Main newer",
        number: 43,
        branch: "main",
        pending: 1,
      },
    });
    // From the feature batch, no other feature batch: the newest of any.
    expect(
      (
        await next(s, {
          at: at(
            featureNew.buildId,
            featureNew.runId,
            featureNew.shots["f-new"],
          ),
        })
      ).nextBatch,
    ).toMatchObject({ buildId: mainNewer.buildId });

    // A batch without a branch prefers another without one.
    await h.db
      .update(builds)
      .set({ branchName: null })
      .where(inArray(builds.id, [s.buildId, mainOld.buildId]));
    expect((await next(s, { at: here })).nextBatch).toMatchObject({
      buildId: mainOld.buildId,
      branch: null,
    });
    await h.db
      .update(builds)
      .set({ branchName: "main" })
      .where(inArray(builds.id, [s.buildId, mainOld.buildId]));

    // The same branch wins over a newer batch of another branch...
    await decide(s, mainNewer.runId, mainNewer.shots["m-newer"]!);
    expect(await next(s, { at: here })).toMatchObject({
      target: tgt(mainOld.buildId, mainOld.runId, mainOld.shots["m-old"]!),
      scope: "nextBatch",
      remaining: { projectBatches: 2 },
      nextBatch: { buildId: mainOld.buildId, branch: "main" },
    });
    // ...and with none left on it, any branch does.
    await decide(s, mainOld.runId, mainOld.shots["m-old"]!);
    expect(await next(s, { at: here })).toMatchObject({
      target: tgt(
        featureNew.buildId,
        featureNew.runId,
        featureNew.shots["f-new"]!,
      ),
      scope: "nextBatch",
      remaining: { projectBatches: 1 },
      nextBatch: { buildId: featureNew.buildId, branch: "feature" },
    });
  });

  test("excludeBuildIds is honoured", async () => {
    const s = await seed({ checkpoints: [{ name: "cur", verdict: "new" }] });
    const here = at(s.buildId, s.runId, s.shots.cur);
    const older = await addReviewBuild(h, s, {
      spec: { checkpoints: [{ name: "o", verdict: "unresolved" }] },
    });
    const newer = await addReviewBuild(h, s, {
      spec: { checkpoints: [{ name: "n", verdict: "unresolved" }] },
    });
    await orderBuilds([s.buildId, older.buildId, newer.buildId]);

    expect((await next(s, { at: here })).nextBatch).toMatchObject({
      buildId: newer.buildId,
    });
    expect(
      await next(s, { at: here, excludeBuildIds: [newer.buildId] }),
    ).toMatchObject({
      target: tgt(older.buildId, older.runId, older.shots.o!),
      scope: "nextBatch",
      nextBatch: { buildId: older.buildId },
    });
    // Excluded batches are skipped, not uncounted.
    expect(
      await next(s, {
        at: here,
        excludeBuildIds: [newer.buildId, older.buildId],
      }),
    ).toEqual({
      target: null,
      scope: "none",
      remaining: { ...NOTHING_LEFT, projectBatches: 2 },
      nextBatch: null,
    });
    // Without `at`, the excluded batch is not the one started either.
    expect(await next(s, { excludeBuildIds: [newer.buildId] })).toMatchObject({
      target: tgt(older.buildId, older.runId, older.shots.o!),
      scope: "batch",
      nextBatch: { buildId: s.buildId },
    });
  });

  test("no at → first pending step of the newest batch with one (any branch)", async () => {
    const s = await seed({
      checkpoints: [{ name: "old", verdict: "unresolved" }],
    });
    const ff = await addReviewRun(h, s, {
      checkpoints: [{ name: "ff", verdict: "new", browser: "firefox" }],
    });
    const mainB = await addReviewBuild(h, s, {
      branch: "main",
      spec: {
        checkpoints: [
          { name: "x", verdict: "passed" },
          { name: "y", verdict: "new" },
          { name: "z", verdict: "unresolved" },
        ],
      },
    });
    // The newest batch has nothing pending.
    const done = await addReviewBuild(h, s, {
      spec: { checkpoints: [{ name: "p", verdict: "passed" }] },
    });
    await orderBuilds([s.buildId, mainB.buildId, done.buildId]);

    const expected: NextResult = {
      target: tgt(mainB.buildId, mainB.runId, mainB.shots.y!),
      scope: "batch",
      remaining: { run: 0, batch: 2, batchUnfiltered: 2, projectBatches: 2 },
      nextBatch: {
        buildId: s.buildId,
        name: `run-${s.tag}`,
        number: null,
        branch: s.branch,
        pending: 2,
      },
    };
    expect(await next(s)).toEqual(expected);
    // Another batch is opened at its first pending step, whatever the direction.
    expect(await next(s, { direction: "prev" })).toEqual(expected);

    // With facets, the newest batch with a pending step inside them.
    expect(await next(s, { facets: { browser: "firefox" } })).toEqual({
      target: tgt(s.buildId, ff.runId, ff.shots.ff!),
      scope: "batch",
      remaining: { run: 0, batch: 1, batchUnfiltered: 2, projectBatches: 1 },
      nextBatch: null,
    });
  });

  test("nothing pending → target null, scope none, projectBatches 0", async () => {
    const s = await seed({
      checkpoints: [
        { name: "a", verdict: "passed" },
        { name: "b", verdict: "unresolved" },
      ],
    });
    await decide(s, s.runId, s.shots.b!);
    // Pending verdicts in runs that cannot be reviewed do not count.
    await addReviewRun(h, s, {
      lifecycle: "running",
      checkpoints: [{ name: "c", verdict: "unresolved" }],
    });
    await addReviewBuild(h, s, {
      spec: {
        lifecycle: "aborted",
        checkpoints: [{ name: "d", verdict: "new" }],
      },
    });
    const none: NextResult = {
      target: null,
      scope: "none",
      remaining: { ...NOTHING_LEFT, projectBatches: 0 },
      nextBatch: null,
    };
    expect(await next(s)).toEqual(none);
    expect(await next(s, { at: at(s.buildId) })).toEqual(none);
    expect(
      await next(s, {
        at: at(s.buildId, s.runId, s.shots.a),
        direction: "prev",
      }),
    ).toEqual(none);
  });

  test("ties broken by id", async () => {
    const s = await seed({
      checkpoints: [{ name: "a1", verdict: "unresolved" }],
    });
    const r2 = await addReviewRun(h, s, {
      checkpoints: [{ name: "b1", verdict: "unresolved" }],
    });
    const r3 = await addReviewRun(h, s, {
      checkpoints: [{ name: "c1", verdict: "new" }],
    });
    // r2 and r3 captured at the same instant: capture order falls back to id.
    await h.db
      .update(testRuns)
      .set({ createdAt: await runCreatedAt(r2.runId) })
      .where(eq(testRuns.id, r3.runId));
    const [lo, hi] = [r2, r3].sort((x, y) =>
      x.runId < y.runId ? -1 : x.runId > y.runId ? 1 : 0,
    );
    const loStep = lo!.shotsInOrder[0]!;
    const hiStep = hi!.shotsInOrder[0]!;
    const a1 = s.shots.a1!;

    expect((await next(s, { at: at(s.buildId, s.runId, a1) })).target).toEqual(
      tgt(s.buildId, lo!.runId, loStep),
    );
    expect(
      await next(s, { at: at(s.buildId, lo!.runId, loStep) }),
    ).toMatchObject({
      target: tgt(s.buildId, hi!.runId, hiStep),
      scope: "batch",
    });
    expect(
      (await next(s, { at: at(s.buildId, hi!.runId, hiStep) })).target,
    ).toEqual(tgt(s.buildId, s.runId, a1));
    expect(
      (
        await next(s, {
          at: at(s.buildId, hi!.runId, hiStep),
          direction: "prev",
        })
      ).target,
    ).toEqual(tgt(s.buildId, lo!.runId, loStep));
    expect(
      (
        await next(s, {
          at: at(s.buildId, lo!.runId, loStep),
          direction: "prev",
        })
      ).target,
    ).toEqual(tgt(s.buildId, s.runId, a1));

    // prev from the batch's end: the tied pair backwards, greater id first.
    expect(
      (await next(s, { at: at(s.buildId), direction: "prev" })).target,
    ).toEqual(tgt(s.buildId, hi!.runId, hiStep));

    // Two steps of one run captured at the same instant: by id.
    const r4 = await addReviewRun(h, s, {
      checkpoints: [
        { name: "d1", verdict: "unresolved" },
        { name: "d2", verdict: "unresolved" },
      ],
    });
    const [s1, s2] = r4.shotsInOrder;
    const [firstShot] = await h.db
      .select({ createdAt: screenshots.createdAt })
      .from(screenshots)
      .where(eq(screenshots.id, s1!.id));
    await h.db
      .update(screenshots)
      .set({ createdAt: firstShot!.createdAt })
      .where(eq(screenshots.id, s2!.id));
    const [loShot, hiShot] = [s1!, s2!].sort((x, y) =>
      x.id < y.id ? -1 : x.id > y.id ? 1 : 0,
    );
    expect(await next(s, { at: at(s.buildId, r4.runId) })).toMatchObject({
      target: tgt(s.buildId, r4.runId, loShot!),
      scope: "run",
    });
    expect(
      await next(s, { at: at(s.buildId, r4.runId, loShot) }),
    ).toMatchObject({
      target: tgt(s.buildId, r4.runId, hiShot!),
      scope: "run",
    });
    expect(
      await next(s, { at: at(s.buildId, r4.runId), direction: "prev" }),
    ).toMatchObject({
      target: tgt(s.buildId, r4.runId, hiShot!),
      scope: "run",
    });
    expect(
      await next(s, {
        at: at(s.buildId, r4.runId, hiShot),
        direction: "prev",
      }),
    ).toMatchObject({
      target: tgt(s.buildId, r4.runId, loShot!),
      scope: "run",
    });

    // Two batches created at the same instant (after the seed's): the
    // greater id is the newer.
    const b1 = await addReviewBuild(h, s, {
      spec: { checkpoints: [{ name: "e1", verdict: "new" }] },
    });
    const b2 = await addReviewBuild(h, s, {
      spec: { checkpoints: [{ name: "e2", verdict: "new" }] },
    });
    await h.db
      .update(builds)
      .set({ createdAt: new Date(Date.now() + 60_000) })
      .where(inArray(builds.id, [b1.buildId, b2.buildId]));
    const newerId = b1.buildId > b2.buildId ? b1.buildId : b2.buildId;
    expect((await next(s, { at: at(s.buildId) })).nextBatch).toMatchObject({
      buildId: newerId,
    });
    expect((await next(s)).target).toMatchObject({ buildId: newerId });
  });

  test("counts equal pendingCountsByBuild / selectPendingTargets", async () => {
    const s = await seed({
      checkpoints: [
        { name: "a", verdict: "unresolved" },
        { name: "b", verdict: "new", viewport: MOBILE },
        { name: "c", verdict: "passed" },
        { name: "d", verdict: "unresolved" },
        { name: "e", verdict: "unresolved", browser: "firefox" },
        { name: "f", verdict: "new", browser: "firefox", viewport: MOBILE },
      ],
    });
    await decide(s, s.runId, s.shots.d!);
    await decide(s, s.runId, s.shots.e!, { decision: "rejected" });
    // Undone: pending again.
    await decide(s, s.runId, s.shots.f!, { reverted: true });
    await addReviewRun(h, s, {
      lifecycle: "running",
      checkpoints: [{ name: "g", verdict: "unresolved" }],
    });
    await addReviewRun(h, s, {
      override: "passed",
      checkpoints: [{ name: "h", verdict: "unresolved" }],
    });
    await addReviewRun(h, s, {
      checkpoints: [
        { name: "i", verdict: "unresolved" },
        { name: "j", verdict: null },
      ],
    });
    await addReviewRun(h, s, {
      checkpoints: [
        { name: "k", verdict: "unresolved", browser: "firefox" },
        { name: "l", verdict: "new", viewport: MOBILE },
      ],
    });
    const b2 = await addReviewBuild(h, s, {
      spec: {
        checkpoints: [
          { name: "m", verdict: "unresolved", viewport: MOBILE },
          { name: "n", verdict: "passed" },
        ],
      },
    });
    const b3 = await addReviewBuild(h, s, {
      spec: { checkpoints: [{ name: "o", verdict: "passed" }] },
    });
    const b4 = await addReviewBuild(h, s, {
      spec: {
        lifecycle: "aborted",
        checkpoints: [{ name: "p", verdict: "unresolved" }],
      },
    });
    const buildRuns = new Map<string, string[]>([
      [s.buildId, s.runIds],
      ...s.extraBuilds.map((b) => [b.buildId, b.runIds] as [string, string[]]),
    ]);
    const buildIds = [...buildRuns.keys()];
    expect(buildIds).toEqual(
      expect.arrayContaining([b2.buildId, b3.buildId, b4.buildId]),
    );

    const facetSets: Array<StepFacets | undefined> = [
      undefined,
      { browser: "firefox" },
      { viewport: MOBILE },
      { browser: "firefox", viewport: MOBILE },
    ];
    const unfiltered = await pendingCountsByBuild(h.db, {
      projectId: s.projectId,
      buildIds,
    });
    // The fixture spans pending and non-pending batches.
    expect(unfiltered.get(s.buildId)).toBe(5); // a b f k l
    expect(unfiltered.get(b2.buildId)).toBe(1);
    expect(unfiltered.has(b3.buildId)).toBe(false);
    expect(unfiltered.has(b4.buildId)).toBe(false);

    for (const facets of facetSets) {
      const byBuild = await pendingCountsByBuild(h.db, {
        projectId: s.projectId,
        buildIds,
        ...(facets ? { facets } : {}),
      });
      const projectBatches = [...byBuild.values()].filter((n) => n > 0).length;
      for (const buildId of buildIds) {
        const r = await next(s, {
          at: at(buildId),
          ...(facets ? { facets } : {}),
        });
        const { preview } = await selectPendingTargets(
          h.db,
          { projectId: s.projectId, buildId },
          0,
        );
        expect([buildId, facets, r.remaining]).toEqual([
          buildId,
          facets,
          {
            run: 0,
            batch: byBuild.get(buildId) ?? 0,
            batchUnfiltered: preview.pendingCheckpoints,
            projectBatches,
          },
        ]);
        expect(preview.pendingCheckpoints).toBe(unfiltered.get(buildId) ?? 0);
        if (r.nextBatch) {
          expect(r.nextBatch.pending).toBe(byBuild.get(r.nextBatch.buildId));
        }

        // remaining.run from a run position is the run's pending count.
        const runIds = buildRuns.get(buildId)!;
        const byRun = await pendingCountsByRun(h.db, {
          projectId: s.projectId,
          runIds,
          ...(facets ? { facets } : {}),
        });
        for (const runId of runIds) {
          const rr = await next(s, {
            at: at(buildId, runId),
            ...(facets ? { facets } : {}),
          });
          expect([runId, rr.remaining.run]).toEqual([
            runId,
            byRun.get(runId) ?? 0,
          ]);
        }
      }
    }

    // Walking the batch from its start reaches exactly the steps "approve
    // pending" would act on, each once.
    const { targets } = await selectPendingTargets(
      h.db,
      { projectId: s.projectId, buildId: s.buildId },
      Number.MAX_SAFE_INTEGER,
    );
    const visited: Array<{ runId: string; screenshotId: string }> = [];
    let where: QueueAt = at(s.buildId);
    for (let i = 0; i < targets.length; i++) {
      const { target } = await next(s, { at: where });
      expect(target?.buildId).toBe(s.buildId);
      visited.push({
        runId: target!.runId,
        screenshotId: target!.checkpointId,
      });
      where = target!;
    }
    const key = (t: { runId: string; screenshotId: string }) =>
      `${t.runId}/${t.screenshotId}`;
    expect(new Set(visited.map(key)).size).toBe(targets.length);
    expect(visited.map(key).sort()).toEqual(targets.map(key).sort());
  });

  test('walking with no at, then from each target in turn, visits a batch\'s steps in the same run order as runs.list({ buildId, order: "capture" })', async () => {
    const s = await seed({
      checkpoints: [
        { name: "a1", verdict: "unresolved" },
        { name: "a2", verdict: "passed" },
        { name: "a3", verdict: "new" },
      ],
    });
    const r2 = await addReviewRun(h, s, {
      checkpoints: [{ name: "b1", verdict: "passed" }],
    });
    const r3 = await addReviewRun(h, s, {
      checkpoints: [
        { name: "c1", verdict: "unresolved" },
        { name: "c2", verdict: "unresolved" },
      ],
    });
    const r4 = await addReviewRun(h, s, {
      checkpoints: [{ name: "d1", verdict: "new" }],
    });
    const r5 = await addReviewRun(h, s, {
      checkpoints: [
        { name: "e1", verdict: "unresolved" },
        { name: "e2", verdict: "unresolved" },
      ],
    });
    // Capture order is not insertion order: r5 moves between r1 and r2, and
    // r4 ties with r3 (id decides).
    const t1 = await runCreatedAt(s.runId);
    await h.db
      .update(testRuns)
      .set({ createdAt: new Date(t1.getTime() + 500) })
      .where(eq(testRuns.id, r5.runId));
    await h.db
      .update(testRuns)
      .set({ createdAt: await runCreatedAt(r3.runId) })
      .where(eq(testRuns.id, r4.runId));
    const runs = new Map(
      [{ runId: s.runId, shotsInOrder: s.shotsInOrder }, r2, r3, r4, r5].map(
        (r) => [r.runId, r],
      ),
    );

    const pendingTotal =
      (
        await pendingCountsByBuild(h.db, {
          projectId: s.projectId,
          buildIds: [s.buildId],
        })
      ).get(s.buildId) ?? 0;
    expect(pendingTotal).toBe(7);

    const walk: Array<{ runId: string; checkpointId: string }> = [];
    let res = await next(s);
    for (let i = 0; i < pendingTotal; i++) {
      expect(res.target?.buildId).toBe(s.buildId);
      walk.push({
        runId: res.target!.runId,
        checkpointId: res.target!.checkpointId,
      });
      res = await next(s, { at: res.target! });
    }
    // One more wraps back to the first step.
    expect(res.target).toEqual({ buildId: s.buildId, ...walk[0] });
    expect(new Set(walk.map((w) => w.checkpointId)).size).toBe(pendingTotal);

    // The run order matches the batch page's list in capture order.
    const runOrder = walk
      .map((w) => w.runId)
      .filter((id, i, all) => i === 0 || all[i - 1] !== id);
    expect(new Set(runOrder).size).toBe(runOrder.length);
    const client = makeClient(baseUrl, s.editor.jwt);
    const listed = await client.runs.list.query({
      projectId: s.projectId,
      buildId: s.buildId,
      order: "capture",
      limit: 100,
    });
    expect(runOrder).toEqual(
      listed.items.filter((r) => r.pendingCount > 0).map((r) => r.id),
    );
    const listedPending = await client.runs.list.query({
      projectId: s.projectId,
      buildId: s.buildId,
      order: "capture",
      pending: true,
      limit: 100,
    });
    expect(runOrder).toEqual(listedPending.items.map((r) => r.id));
    // ...and each run's steps come in their capture order.
    for (const runId of runOrder) {
      const pendingOfRun = runs
        .get(runId)!
        .shotsInOrder.filter((sh) => !["a2", "b1"].includes(sh.name))
        .map((sh) => sh.id);
      expect(
        walk.filter((w) => w.runId === runId).map((w) => w.checkpointId),
      ).toEqual(pendingOfRun);
    }
    const [lo, hi] = [r3.runId, r4.runId].sort();
    expect(runOrder).toEqual([s.runId, r5.runId, lo, hi]);

    // prev walks the same order backwards.
    const back: string[] = [];
    let where: QueueAt = at(s.buildId);
    for (let i = 0; i < pendingTotal; i++) {
      const { target } = await next(s, { at: where, direction: "prev" });
      back.push(target!.checkpointId);
      where = target!;
    }
    expect(back).toEqual(walk.map((w) => w.checkpointId).reverse());
  });

  /**
   * The statements `findNext` issues from the last pending step of a batch of
   * `runs` runs, with a newer batch next to it. `onlyAt`: the batch's only
   * pending step is `at` itself, so neither the keyset nor the wrap finds
   * anything and the next batch is opened (`nextBatch`, one more statement);
   * otherwise the wrap finds the first run's step (`batch`).
   */
  async function statements(runs: number, onlyAt: boolean): Promise<number> {
    const s = await seed({
      checkpoints: [{ name: "first", verdict: "unresolved" }],
    });
    let last = s.shots.first!;
    let lastRun = s.runId;
    for (let i = 1; i < runs; i++) {
      const r = await addReviewRun(h, s, {
        checkpoints: [
          { name: `x${i}`, verdict: "passed" },
          { name: `y${i}`, verdict: onlyAt ? "passed" : "unresolved" },
        ],
      });
      if (!onlyAt) {
        last = r.shotsInOrder[1]!;
        lastRun = r.runId;
      }
    }
    await addReviewBuild(h, s, {
      spec: { checkpoints: [{ name: "other", verdict: "new" }] },
    });
    const counting = { n: () => 0 };
    const r = await next(s, { at: at(s.buildId, lastRun, last) }, (db) => {
      const c = countingDb(db);
      counting.n = c.count;
      return c.db;
    });
    expect(r.scope).toBe(onlyAt || runs === 1 ? "nextBatch" : "batch");
    return counting.n();
  }

  test("a constant number of statements however many runs the batch has", async () => {
    // The worst case with a pending step left in the batch: the keyset finds
    // nothing, the wrap does, and the next batch is looked up too.
    const small = await statements(2, false);
    const large = await statements(12, false);
    expect(large).toBe(small);
    expect(small).toBeLessThanOrEqual(6);
  });

  test("the same bound holds when the batch's only pending step is `at`", async () => {
    // The longest path: keyset, wrap, next batch, its first step, the counts.
    const small = await statements(2, true);
    const large = await statements(12, true);
    expect(large).toBe(small);
    expect(small).toBeLessThanOrEqual(6);
  });
});
