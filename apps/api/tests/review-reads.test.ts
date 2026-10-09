import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";

import {
  builds,
  checkpointDecisions,
  eq,
  inArray,
  screenshots,
  sql,
  testRuns,
  users,
  type DB,
} from "@furan/db";
import type { CheckpointReviewState, RunStatus } from "@furan/shared-types";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";

import {
  buildDisplayName,
  checkpointStatusAlias,
  loadCheckpointReview,
} from "../src/lib/review/reads.js";
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

const newAction = () => randomUUID();

/** Counts the statements a read issues (`select*` / `execute` on the handle). */
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

describe("checkpointStatusAlias", () => {
  const cases: Array<[CheckpointReviewState | null, RunStatus, string]> = [
    ["new", "new", "new"],
    ["unresolved", "unresolved", "unresolved"],
    ["passed", "passed", "passed"],
    ["approved", "passed", "passed"],
    ["rejected", "failed", "failed"],
    [null, "running", "running"],
    // R20: an undiffed checkpoint of a run that ended without diffing it shows
    // the run's lifecycle, not a "Running" spinner that never stops.
    [null, "aborted", "aborted"],
    [null, "empty", "empty"],
    // Any other lifecycle with an undiffed checkpoint: a diff is still due.
    [null, "unresolved", "running"],
    // A diffed checkpoint never takes the run's lifecycle.
    ["unresolved", "aborted", "unresolved"],
  ];
  test.each(cases)("%s in a %s run -> %s", (state, lifecycle, status) => {
    expect(checkpointStatusAlias(state, lifecycle)).toBe(status);
  });
});

describe("buildDisplayName", () => {
  // Mirrors apps/dashboard/src/lib/build-display-name.ts tier for tier.
  test("name, then the single test name, then #number, then ciBuildId[:12], then id[:8]", () => {
    const id = "0123456789ab-cdef";
    const ci = "ci-build-0123456789";
    expect(
      buildDisplayName({
        name: "Release",
        testName: "t",
        number: 4,
        ciBuildId: ci,
        id,
      }),
    ).toBe("Release");
    expect(
      buildDisplayName({
        name: null,
        testName: "login",
        number: 4,
        ciBuildId: ci,
        id,
      }),
    ).toBe("login");
    expect(
      buildDisplayName({
        name: "",
        testName: null,
        number: 4,
        ciBuildId: ci,
        id,
      }),
    ).toBe("#4");
    expect(
      buildDisplayName({
        name: null,
        testName: null,
        number: null,
        ciBuildId: ci,
        id,
      }),
    ).toBe("ci-build-012");
    expect(
      buildDisplayName({
        name: null,
        testName: null,
        number: null,
        ciBuildId: null,
        id,
      }),
    ).toBe("01234567");
  });
});

d("review read model", () => {
  let h: TestApp;
  let baseUrl: string;
  const seeds: ReviewSeed[] = [];

  const as = (u: ReviewUser | null) => makeClient(baseUrl, u?.jwt);

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

  /** Approves `shotIds` of `runId` through the router; returns the actionId. */
  async function approve(
    s: ReviewSeed,
    runId: string,
    shotIds: string[],
    user: ReviewUser = s.editor,
  ): Promise<string> {
    const actionId = newAction();
    await as(user).review.approve.mutate({
      runId,
      actionId,
      checkpointIds: shotIds,
    });
    return actionId;
  }

  async function reject(
    s: ReviewSeed,
    runId: string,
    shotIds: string[],
  ): Promise<string> {
    const actionId = newAction();
    await as(s.editor).review.reject.mutate({
      runId,
      actionId,
      checkpointIds: shotIds,
    });
    return actionId;
  }

  /** A decision as the backfill (or a pre-undo build) wrote it: no snapshot. */
  async function insertLegacyDecision(
    s: ReviewSeed,
    shotId: string,
    over: Partial<typeof checkpointDecisions.$inferInsert> = {},
  ) {
    const [row] = await h.db
      .insert(checkpointDecisions)
      .values({
        projectId: s.projectId,
        runId: s.runId,
        screenshotId: shotId,
        actionId: randomUUID(),
        decision: "approved",
        actorId: null,
        source: "backfill",
        before: null,
        ...over,
      })
      .returning();
    return row!;
  }

  beforeAll(async () => {
    h = await createTestApp();
    // Quiet the request log; outcomes are asserted through responses and rows.
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
  // runs.listCheckpoints
  // -------------------------------------------------------------------------

  describe("runs.listCheckpoints", () => {
    test("after approving 1 of 3, the states are [approved, unresolved, unresolved] with the approver as the actor", async () => {
      const s = await seed({
        checkpoints: [
          { name: "a", verdict: "unresolved", withBaseline: true },
          { name: "b", verdict: "unresolved", withBaseline: true },
          { name: "c", verdict: "unresolved", withBaseline: true },
        ],
      });
      const actionId = await approve(s, s.runId, [s.shots.a!.id]);

      const { items } = await as(s.editor).runs.listCheckpoints.query({
        runId: s.runId,
      });

      expect(items.map((i) => i.state)).toEqual([
        "approved",
        "unresolved",
        "unresolved",
      ]);
      expect(items.map((i) => i.verdict)).toEqual([
        "unresolved",
        "unresolved",
        "unresolved",
      ]);
      const [a, b, c] = items;
      expect(a!.decision).toEqual({
        id: expect.any(String),
        actionId,
        kind: "approved",
        actor: { id: s.editor.id, name: s.editor.name },
        at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
        source: "viewer",
        legacy: false,
      });
      expect(b!.decision).toBeNull();
      expect(c!.decision).toBeNull();
      // The decision row's own id is what the read reports.
      const [row] = await h.db
        .select({ id: checkpointDecisions.id })
        .from(checkpointDecisions)
        .where(eq(checkpointDecisions.screenshotId, s.shots.a!.id));
      expect(a!.decision!.id).toBe(row!.id);
    });

    test("`status` stays as an alias of `state`: approved -> passed, rejected -> failed, no verdict -> running", async () => {
      const s = await seed({
        checkpoints: [
          { name: "a", verdict: "unresolved", withBaseline: true },
          { name: "b", verdict: "unresolved", withBaseline: true },
          { name: "c", verdict: "new" },
          { name: "d", verdict: "passed", withBaseline: true },
        ],
      });
      await approve(s, s.runId, [s.shots.a!.id]);
      await reject(s, s.runId, [s.shots.b!.id]);

      const { items } = await as(s.editor).runs.listCheckpoints.query({
        runId: s.runId,
      });
      expect(items.map((i) => [i.state, i.status])).toEqual([
        ["approved", "passed"],
        ["rejected", "failed"],
        ["new", "new"],
        ["passed", "passed"],
      ]);

      const running = await seed({
        checkpoints: [{ name: "r", verdict: null }],
        lifecycle: "running",
      });
      const res = await as(running.editor).runs.listCheckpoints.query({
        runId: running.runId,
      });
      expect(res.items).toMatchObject([
        { verdict: null, state: null, status: "running", decision: null },
      ]);
    });

    test.each(["aborted", "empty"] as const)(
      "an undiffed checkpoint of an %s run reads as that lifecycle, not running (R20)",
      async (lifecycle) => {
        const s = await seed({
          checkpoints: [
            { name: "done", verdict: "unresolved", withBaseline: true },
            { name: "never-diffed", verdict: null },
          ],
          lifecycle,
        });
        const { items } = await as(s.editor).runs.listCheckpoints.query({
          runId: s.runId,
        });
        expect(items.map((i) => [i.state, i.status])).toEqual([
          ["unresolved", "unresolved"],
          [null, lifecycle],
        ]);
      },
    );

    test("the state follows each checkpoint's own verdict and decision, not the run's status", async () => {
      // The run was forced to `passed` (as the old run-level approve left it),
      // but nothing decided its checkpoints: they are still unresolved.
      const s = await seed({
        checkpoints: [
          { name: "a", verdict: "unresolved", withBaseline: true },
          { name: "b", verdict: "passed", withBaseline: true },
        ],
      });
      await h.db
        .update(testRuns)
        .set({ status: "passed" })
        .where(eq(testRuns.id, s.runId));

      const { items } = await as(s.editor).runs.listCheckpoints.query({
        runId: s.runId,
      });
      expect(items.map((i) => i.state)).toEqual(["unresolved", "passed"]);
    });

    test("the verdict is what the diff-worker wrote: no baseline lookup decides new vs unresolved", async () => {
      // `new` WITH a baseline row and `unresolved` WITHOUT one: the reverse of
      // what the old inference would have said for both.
      const s = await seed({
        checkpoints: [
          { name: "has-baseline", verdict: "new", withBaseline: true },
          { name: "no-baseline", verdict: "unresolved" },
        ],
      });
      const { items } = await as(s.editor).runs.listCheckpoints.query({
        runId: s.runId,
      });
      expect(items.map((i) => i.state)).toEqual(["new", "unresolved"]);
    });

    test("a rejected checkpoint reports the rejecter and a legacy decision reports legacy:true with no actor", async () => {
      const s = await seed({
        checkpoints: [
          { name: "a", verdict: "unresolved", withBaseline: true },
          { name: "b", verdict: "unresolved", withBaseline: true },
          { name: "c", verdict: "unresolved", withBaseline: true },
        ],
      });
      await reject(s, s.runId, [s.shots.a!.id]);
      // Backfilled: no actor, no snapshot.
      await insertLegacyDecision(s, s.shots.b!.id, {
        decision: "rejected",
        actorId: null,
        source: "backfill",
      });
      // A decision with an actor but no snapshot is still not undoable.
      await insertLegacyDecision(s, s.shots.c!.id, {
        decision: "approved",
        actorId: s.admin.id,
        source: "inbox",
      });

      const { items } = await as(s.editor).runs.listCheckpoints.query({
        runId: s.runId,
      });
      expect(items.map((i) => i.state)).toEqual([
        "rejected",
        "rejected",
        "approved",
      ]);
      expect(items[0]!.decision).toMatchObject({
        kind: "rejected",
        legacy: false,
        actor: { id: s.editor.id },
      });
      expect(items[1]!.decision).toMatchObject({
        kind: "rejected",
        legacy: true,
        actor: null,
        source: "backfill",
      });
      expect(items[2]!.decision).toMatchObject({
        kind: "approved",
        legacy: true,
        actor: { id: s.admin.id, name: s.admin.name },
        source: "inbox",
      });
    });

    test("an undone decision is gone from the read: the checkpoint is back to its verdict", async () => {
      const s = await seed({
        checkpoints: [{ name: "a", verdict: "unresolved", withBaseline: true }],
      });
      await approve(s, s.runId, [s.shots.a!.id]);
      await h.db
        .update(checkpointDecisions)
        .set({ revertedAt: new Date(), revertedBy: s.editor.id })
        .where(eq(checkpointDecisions.screenshotId, s.shots.a!.id));

      const { items } = await as(s.editor).runs.listCheckpoints.query({
        runId: s.runId,
      });
      expect(items[0]).toMatchObject({ state: "unresolved", decision: null });
    });

    test("the actor's name is 'First Last', else their email", async () => {
      const s = await seed({
        checkpoints: [{ name: "a", verdict: "unresolved", withBaseline: true }],
      });
      await approve(s, s.runId, [s.shots.a!.id]);
      const actorName = async () =>
        (await as(s.editor).runs.listCheckpoints.query({ runId: s.runId }))
          .items[0]!.decision!.actor!.name;

      expect(await actorName()).toBe(s.editor.name);
      await h.db
        .update(users)
        .set({ firstName: "Solo", lastName: "" })
        .where(eq(users.id, s.editor.id));
      expect(await actorName()).toBe("Solo");
      await h.db
        .update(users)
        .set({ firstName: "", lastName: "" })
        .where(eq(users.id, s.editor.id));
      expect(await actorName()).toBe(s.editor.email);
    });

    test("a newer run capturing the same variation sets newerCapture on the older checkpoint only", async () => {
      const s = await seed({
        checkpoints: [
          { name: "a", verdict: "unresolved", withBaseline: true },
          { name: "b", verdict: "unresolved", withBaseline: true },
          { name: "c", verdict: "unresolved", withBaseline: true },
        ],
      });
      // Run 2 captures `a` again (same variation); `b` and `c` are not recaptured.
      const run2 = await addReviewRun(h, s, {
        checkpoints: [{ name: "a", verdict: "unresolved" }],
      });

      const older = await as(s.editor).runs.listCheckpoints.query({
        runId: s.runId,
      });
      const [a, b, c] = older.items;
      expect(a!.newerCapture).toEqual({
        runId: run2.runId,
        buildId: s.buildId,
        buildName: `run-${s.tag}`,
      });
      expect(b!.newerCapture).toBeNull();
      expect(c!.newerCapture).toBeNull();

      // The newer run's own checkpoint has nothing newer.
      const newer = await as(s.editor).runs.listCheckpoints.query({
        runId: run2.runId,
      });
      expect(newer.items.map((i) => i.newerCapture)).toEqual([null]);
    });

    test("newerCapture is the NEWEST later capture, in whatever build it landed, named like the dashboard names it", async () => {
      const s = await seed({
        checkpoints: [{ name: "a", verdict: "unresolved", withBaseline: true }],
      });
      const run2 = await addReviewRun(h, s, {
        checkpoints: [{ name: "a", verdict: "unresolved" }],
      });
      const run3 = await addReviewRun(h, s, {
        checkpoints: [{ name: "a", verdict: "unresolved" }],
      });
      // Run 3 lives in another, named build.
      const [other] = await h.db
        .insert(builds)
        .values({
          projectId: s.projectId,
          branchName: "feature/review",
          name: "Release 42",
        })
        .returning({ id: builds.id });
      await h.db
        .update(testRuns)
        .set({ buildId: other!.id })
        .where(eq(testRuns.id, run3.runId));

      const first = await as(s.editor).runs.listCheckpoints.query({
        runId: s.runId,
      });
      expect(first.items[0]!.newerCapture).toEqual({
        runId: run3.runId,
        buildId: other!.id,
        buildName: "Release 42",
      });
      // From run 2, only run 3 is newer.
      const second = await as(s.editor).runs.listCheckpoints.query({
        runId: run2.runId,
      });
      expect(second.items[0]!.newerCapture?.runId).toBe(run3.runId);
      const third = await as(s.editor).runs.listCheckpoints.query({
        runId: run3.runId,
      });
      expect(third.items[0]!.newerCapture).toBeNull();
    });

    test("capture order is (created_at, id) at microsecond resolution: a run 300us later is newer, a tie goes to the larger id", async () => {
      const s = await seed({
        checkpoints: [{ name: "a", verdict: "unresolved", withBaseline: true }],
      });
      const run2 = await addReviewRun(h, s, {
        checkpoints: [{ name: "a", verdict: "unresolved" }],
      });
      const stamp = async (runId: string, ts: string) => {
        await h.db.execute(
          sql`update test_runs set created_at = ${ts}::timestamptz where id = ${runId}`,
        );
      };
      const newerOf = async (runId: string) =>
        (await as(s.editor).runs.listCheckpoints.query({ runId })).items[0]!
          .newerCapture?.runId ?? null;

      // 300us apart inside one millisecond: a JS Date would call them equal.
      await stamp(s.runId, "2026-01-01T00:00:00.000100Z");
      await stamp(run2.runId, "2026-01-01T00:00:00.000400Z");
      expect(await newerOf(s.runId)).toBe(run2.runId);
      expect(await newerOf(run2.runId)).toBeNull();

      // Exactly equal: the larger id is the later capture.
      await stamp(s.runId, "2026-01-01T00:00:00.000400Z");
      const [low, high] = [s.runId, run2.runId].sort() as [string, string];
      expect(await newerOf(low)).toBe(high);
      expect(await newerOf(high)).toBeNull();
    });

    test("a capture in another project's run is never reported, even if it names this variation", async () => {
      const s = await seed({
        checkpoints: [{ name: "a", verdict: "unresolved", withBaseline: true }],
      });
      const foreign = await seed({
        checkpoints: [{ name: "z", verdict: "unresolved" }],
      });
      // Corrupt data: a foreign project's screenshot pointing at s's variation.
      await h.db.insert(screenshots).values({
        runId: foreign.runId,
        projectId: foreign.projectId,
        testVariationId: s.shots.a!.variationId,
        name: "alias",
        viewport: "1280x720",
        browser: "chromium",
        imageKey: `alias-${s.tag}.png`,
        verdict: "unresolved",
      });
      const { items } = await as(s.editor).runs.listCheckpoints.query({
        runId: s.runId,
      });
      expect(items[0]!.newerCapture).toBeNull();
    });

    test("a build with no name and several test names falls back to its number, then its ci id", async () => {
      const s = await seed({
        checkpoints: [{ name: "a", verdict: "unresolved", withBaseline: true }],
      });
      const run2 = await addReviewRun(h, s, {
        checkpoints: [{ name: "a", verdict: "unresolved" }],
      });
      const [other] = await h.db
        .insert(builds)
        .values({
          projectId: s.projectId,
          branchName: "feature/review",
          number: 9,
          ciBuildId: "ci-0123456789abcdef",
        })
        .returning({ id: builds.id });
      await h.db
        .update(testRuns)
        .set({ buildId: other!.id })
        .where(eq(testRuns.id, run2.runId));
      // Two distinct test names in the build: no single test name to show.
      await h.db.insert(testRuns).values({
        buildId: other!.id,
        projectId: s.projectId,
        name: "another-test",
        status: "passed",
      });

      const res = await as(s.editor).runs.listCheckpoints.query({
        runId: s.runId,
      });
      expect(res.items[0]!.newerCapture?.buildName).toBe("#9");

      await h.db
        .update(builds)
        .set({ number: null })
        .where(eq(builds.id, other!.id));
      const res2 = await as(s.editor).runs.listCheckpoints.query({
        runId: s.runId,
      });
      expect(res2.items[0]!.newerCapture?.buildName).toBe("ci-012345678");
    });

    test("a project-less outsider is refused as before", async () => {
      const s = await seed({
        checkpoints: [{ name: "a", verdict: "unresolved" }],
      });
      await expect(
        as(s.outsider).runs.listCheckpoints.query({ runId: s.runId }),
      ).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
    });
  });

  // -------------------------------------------------------------------------
  // loadCheckpointReview
  // -------------------------------------------------------------------------

  describe("loadCheckpointReview", () => {
    test("issues a constant number of statements however many checkpoints the run has", async () => {
      const small = await seed({
        checkpoints: [
          { name: "a", verdict: "unresolved", withBaseline: true },
          { name: "b", verdict: "new" },
        ],
      });
      const big = await seed({
        checkpoints: Array.from({ length: 40 }, (_, i) => ({
          name: `s${i}`,
          verdict: (i % 2 === 0 ? "unresolved" : "new") as "unresolved" | "new",
        })),
      });
      // Decisions and a newer capture, so every branch of the read runs.
      await approve(big, big.runId, [big.shots.s0!.id, big.shots.s2!.id]);
      await reject(big, big.runId, [big.shots.s4!.id]);
      await addReviewRun(h, big, {
        checkpoints: [
          { name: "s0", verdict: "unresolved" },
          { name: "s1", verdict: "new" },
        ],
      });
      await addReviewRun(h, small, {
        checkpoints: [{ name: "a", verdict: "unresolved" }],
      });

      const a = countingDb(h.db);
      const smallView = await loadCheckpointReview(a.db, small.runId);
      const b = countingDb(h.db);
      const bigView = await loadCheckpointReview(b.db, big.runId);

      expect(smallView.size).toBe(2);
      expect(bigView.size).toBe(40);
      expect(a.count()).toBe(b.count());
      expect(b.count()).toBeLessThanOrEqual(4);
      // A run with no checkpoints costs one statement.
      const empty = await seed({ checkpoints: [], lifecycle: "empty" });
      const c = countingDb(h.db);
      expect((await loadCheckpointReview(c.db, empty.runId)).size).toBe(0);
      expect(c.count()).toBe(1);
    });

    test("has an entry for every checkpoint, decided or not", async () => {
      const s = await seed({
        checkpoints: [
          { name: "a", verdict: "unresolved", withBaseline: true },
          { name: "b", verdict: "passed", withBaseline: true },
          { name: "c", verdict: null },
        ],
        lifecycle: "running",
      });
      const view = await loadCheckpointReview(h.db, s.runId);
      expect([...view.keys()].sort()).toEqual(
        Object.values(s.shots)
          .map((x) => x.id)
          .sort(),
      );
      expect(view.get(s.shots.c!.id)).toEqual({
        verdict: null,
        state: null,
        decision: null,
        newerCapture: null,
      });
      expect(view.get(s.shots.b!.id)).toMatchObject({
        verdict: "passed",
        state: "passed",
      });
    });
  });

  // -------------------------------------------------------------------------
  // runs.getById
  // -------------------------------------------------------------------------

  describe("runs.getById", () => {
    test("checkpointContexts carry the review fields beside the baseline context", async () => {
      const s = await seed({
        checkpoints: [
          { name: "a", verdict: "unresolved", withBaseline: true },
          { name: "b", verdict: "new" },
        ],
      });
      const actionId = await approve(s, s.runId, [s.shots.a!.id]);
      const run2 = await addReviewRun(h, s, {
        checkpoints: [{ name: "b", verdict: "new" }],
      });

      const run = await as(s.editor).runs.getById.query({ runId: s.runId });
      const ctxA = run.checkpointContexts[s.shots.a!.id]!;
      const ctxB = run.checkpointContexts[s.shots.b!.id]!;

      // The pre-existing context is still there.
      expect(ctxA).toHaveProperty("baselineScreenshot");
      expect(ctxA).toHaveProperty("baselineSource");
      expect(ctxA).toHaveProperty("variationIgnoreAreas");
      // And the review fields.
      expect(ctxA).toMatchObject({
        verdict: "unresolved",
        state: "approved",
        decision: {
          actionId,
          kind: "approved",
          actor: { id: s.editor.id, name: s.editor.name },
          legacy: false,
          source: "viewer",
        },
        newerCapture: null,
      });
      expect(ctxB).toMatchObject({
        verdict: "new",
        state: "new",
        decision: null,
        newerCapture: { runId: run2.runId, buildId: s.buildId },
      });
    });
  });

  // -------------------------------------------------------------------------
  // builds.getById
  // -------------------------------------------------------------------------

  describe("builds.getById pendingCheckpoints", () => {
    test("counts the pending checkpoints across the whole build, by the same rule as approve-pending", async () => {
      // run 1: a (unresolved), b (new), c (passed)    -> 2 pending
      // run 2: d (unresolved), e (unresolved)         -> 2 pending, e rejected below
      // run 3: still diffing                          -> not reviewable
      // run 4: force-failed override                  -> not reviewable
      const s = await seed({
        checkpoints: [
          { name: "a", verdict: "unresolved", withBaseline: true },
          { name: "b", verdict: "new" },
          { name: "c", verdict: "passed", withBaseline: true },
        ],
      });
      const run2 = await addReviewRun(h, s, {
        checkpoints: [
          { name: "d", verdict: "unresolved" },
          { name: "e", verdict: "unresolved" },
        ],
      });
      await addReviewRun(h, s, {
        checkpoints: [{ name: "f", verdict: null }],
        lifecycle: "running",
      });
      await addReviewRun(h, s, {
        checkpoints: [{ name: "g", verdict: "unresolved" }],
        override: "failed",
      });
      await reject(s, run2.runId, [run2.shots.e!.id]);

      const build = await as(s.editor).builds.getById.query({
        buildId: s.buildId,
      });
      expect(build.pendingCheckpoints).toBe(3);
      const preview = await as(s.editor).review.previewApproveBuild.query({
        buildId: s.buildId,
      });
      expect(build.pendingCheckpoints).toBe(preview.pendingCheckpoints);

      // Approving some drops the count.
      await approve(s, s.runId, [s.shots.a!.id]);
      const after = await as(s.editor).builds.getById.query({
        buildId: s.buildId,
      });
      expect(after.pendingCheckpoints).toBe(2);
      // The run-level counts keep their meaning (run status based).
      expect(after).toMatchObject({
        runCount: 4,
        runningCount: 1,
        failedCount: 2,
      });
    });

    test("is 0 for a build with nothing to review", async () => {
      const s = await seed({
        checkpoints: [{ name: "ok", verdict: "passed", withBaseline: true }],
      });
      const build = await as(s.editor).builds.getById.query({
        buildId: s.buildId,
      });
      expect(build.pendingCheckpoints).toBe(0);
    });

    test("ignores another project's run that sits in the build", async () => {
      const s = await seed({
        checkpoints: [{ name: "a", verdict: "unresolved", withBaseline: true }],
      });
      const foreign = await seed({
        checkpoints: [{ name: "x", verdict: "unresolved", withBaseline: true }],
      });
      await h.db
        .update(testRuns)
        .set({ buildId: s.buildId })
        .where(eq(testRuns.id, foreign.runId));
      const build = await as(s.editor).builds.getById.query({
        buildId: s.buildId,
      });
      expect(build.pendingCheckpoints).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // The group procedures pick members by the pending rule.
  // -------------------------------------------------------------------------

  describe("group procedures select pending members", () => {
    /**
     * run 1: a (seed), b, c(new), d(passed), e(other signature), all but e share
     * one signature. run 2: g, h share it too.
     */
    async function seedGroupBuild() {
      const s = await seed({
        checkpoints: [
          { name: "a", verdict: "unresolved", withBaseline: true },
          { name: "b", verdict: "unresolved", withBaseline: true },
          { name: "c", verdict: "new" },
          { name: "d", verdict: "passed", withBaseline: true },
          { name: "e", verdict: "unresolved", withBaseline: true },
        ],
      });
      const run2 = await addReviewRun(h, s, {
        checkpoints: [
          { name: "g", verdict: "unresolved" },
          { name: "h", verdict: "unresolved" },
        ],
      });
      const sig = `sig-${s.tag}`;
      await setSignature(
        [
          s.shots.a!.id,
          s.shots.b!.id,
          s.shots.c!.id,
          s.shots.d!.id,
          run2.shots.g!.id,
          run2.shots.h!.id,
        ],
        sig,
      );
      await setSignature([s.shots.e!.id], `other-${s.tag}`);
      return { s, run2 };
    }

    test("getCheckpointGroup lists the pending members except the seed: not decided, passed or differently-signed ones", async () => {
      const { s, run2 } = await seedGroupBuild();
      await reject(s, s.runId, [s.shots.b!.id]);
      await approve(s, run2.runId, [run2.shots.h!.id]);

      const res = await as(s.editor).runs.getCheckpointGroup.query({
        runId: s.runId,
        checkpointId: s.shots.a!.id,
      });
      expect(res.checkpoints.map((c) => c.id)).toEqual([
        s.shots.c!.id,
        run2.shots.g!.id,
      ]);
      expect(res).toMatchObject({
        checkpointCount: 2,
        runCount: 2,
        capped: false,
      });
      expect(res.checkpoints[0]).toMatchObject({
        runId: s.runId,
        testName: `run-${s.tag}`,
        name: "c",
        viewport: "1280x720",
      });
    });

    test("getCheckpointGroup skips the members of a run that cannot be reviewed", async () => {
      const { s, run2 } = await seedGroupBuild();
      // A forced status: run 1's checkpoints stay `unresolved` but cannot be decided.
      await h.db
        .update(testRuns)
        .set({ statusOverride: "failed", status: "failed" })
        .where(eq(testRuns.id, s.runId));
      const res = await as(s.editor).runs.getCheckpointGroup.query({
        runId: s.runId,
        checkpointId: s.shots.a!.id,
      });
      expect(res.checkpoints.map((c) => c.id)).toEqual([
        run2.shots.g!.id,
        run2.shots.h!.id,
      ]);
    });

    test("approveCheckpointGroup approves only the pending members, the seed included", async () => {
      const { s, run2 } = await seedGroupBuild();
      await reject(s, s.runId, [s.shots.b!.id]);
      await approve(s, run2.runId, [run2.shots.h!.id]);

      const res = await as(s.editor).runs.approveCheckpointGroup.mutate({
        runId: s.runId,
        checkpointId: s.shots.a!.id,
      });
      // a, c, g are pending; b is rejected, d passed, h approved, e other signature.
      expect(res).toMatchObject({ approved: 3, runCount: 2, capped: false });
    });

    test("rejectCheckpointGroup fails only the runs that still have a pending member", async () => {
      const { s, run2 } = await seedGroupBuild();
      // Every member of run 2 is already decided; run 1 still has pending ones.
      await approve(s, run2.runId, [run2.shots.g!.id, run2.shots.h!.id]);

      const res = await as(s.editor).runs.rejectCheckpointGroup.mutate({
        runId: s.runId,
        checkpointId: s.shots.a!.id,
      });
      expect(res).toMatchObject({ rejected: 1, runCount: 1, capped: false });
      const [r1] = await h.db
        .select({ status: testRuns.status })
        .from(testRuns)
        .where(eq(testRuns.id, s.runId));
      const [r2] = await h.db
        .select({ status: testRuns.status })
        .from(testRuns)
        .where(eq(testRuns.id, run2.runId));
      expect(r1!.status).toBe("failed");
      expect(r2!.status).toBe("passed");
    });
  });
});
