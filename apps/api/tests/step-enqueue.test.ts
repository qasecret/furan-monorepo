import type { AddressInfo } from "node:net";

import {
  and,
  asc,
  createDb,
  eq,
  screenshots,
  sql,
  testRuns,
  testVariations,
} from "@furan/db";
import { Registry } from "@furan/telemetry";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";

import { createDeferredSink } from "../src/lib/deferred-sink.js";
import type { DiffTrigger } from "../src/lib/diff-enqueue.js";
import { queueStepDiffs } from "../src/lib/review/enqueue.js";
import type { AppRouter } from "../src/trpc/v1/router.js";

import {
  bulkProducer,
  counterValue,
  createTestApp,
  type DiffJobAdd,
  type TestApp,
} from "./helpers.js";
import {
  addReviewRun,
  cleanupReviewSeeds,
  seedReviewRun,
  type ReviewRun,
  type ReviewRunSpec,
  type ReviewSeed,
} from "./review-fixtures.js";

/**
 * The per-step diff enqueue (spec 2026-10-23 §3, §7): `queueStepDiffs` bumps
 * the versions of the steps it is given and queues one job per step after
 * commit, under the job id `<step>-g<version>`; an SDK upload queues its own
 * new step at version 1. Lock order (Ruling R34): a transaction that would
 * lock a run's variation before a conflicting lock on the run takes the run
 * first, so it never deadlocks with a diff commit (run -> step -> variation).
 */
const skip = !process.env.DATABASE_URL;
const d = skip ? describe.skip : describe;
const withS3 =
  !skip &&
  !!process.env.S3_ENDPOINT &&
  !!process.env.S3_BUCKET &&
  !!process.env.S3_ACCESS_KEY &&
  !!process.env.S3_SECRET_KEY;
const s3 = withS3 ? describe : describe.skip;

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII=",
  "base64",
);

const ENQUEUED = "furan_diff_jobs_enqueued_total";
const FAILURES = "furan_diff_enqueue_failures_total";

/** "ok", or the SQLSTATE drizzle's wrapped driver error carries. */
async function sqlState(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (err) {
    let cur: unknown = err;
    for (let depth = 0; cur && depth < 5; depth++) {
      const code = (cur as { code?: unknown }).code;
      if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
      cur = (cur as { cause?: unknown }).cause;
    }
    return String(err);
  }
}

d("per-step diff enqueue", () => {
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

  async function seed(spec: ReviewRunSpec): Promise<ReviewSeed> {
    const s = await seedReviewRun(h, spec);
    seeds.push(s);
    return s;
  }

  const runOf = (s: ReviewSeed, parentBranchName: string | null = null) => ({
    id: s.runId,
    projectId: s.projectId,
    parentBranchName,
  });

  /** Each step of `runId`: its version, queue time and requeue count. */
  async function versions(runId: string) {
    const rows = await h.db
      .select({
        id: screenshots.id,
        generation: screenshots.diffGeneration,
        queuedAt: screenshots.diffQueuedAt,
        requeues: screenshots.diffRequeues,
        verdict: screenshots.verdict,
      })
      .from(screenshots)
      .where(eq(screenshots.runId, runId))
      .orderBy(asc(screenshots.createdAt), asc(screenshots.id));
    return new Map(rows.map((r) => [r.id, r]));
  }

  /**
   * `queueStepDiffs` in a transaction of its own, then its after-commit
   * effects, as a request scope runs them. The producer's `addBulk` hands
   * each job to `add` (`bulkProducer`), which records the step's version as
   * another connection sees it then: committed rows only.
   */
  async function queueInTx(
    run: { id: string; projectId: string; parentBranchName: string | null },
    stepIds: readonly string[],
    opts: {
      trigger?: DiffTrigger;
      add?: DiffJobAdd;
    } = {},
  ) {
    const seen: number[] = [];
    const add = vi.fn<DiffJobAdd>(async (_name, data, o) => {
      const [row] = await h.db
        .select({ generation: screenshots.diffGeneration })
        .from(screenshots)
        .where(eq(screenshots.id, data.screenshotId!));
      seen.push(row!.generation);
      return opts.add ? opts.add("diff", data, o) : { id: o.jobId };
    });
    const diffQueue = bulkProducer(add);
    const addBulk = vi.spyOn(diffQueue, "addBulk");
    const registry = new Registry();
    const sink = createDeferredSink();
    const onCommit = vi.fn(sink.onCommit);
    await h.db.transaction((tx) =>
      queueStepDiffs(
        {
          db: tx,
          diffQueue,
          telemetry: { metrics: registry },
          onCommit,
        },
        run,
        stepIds,
        opts.trigger ?? "threshold",
      ),
    );
    // Nothing is queued before the transaction commits.
    expect(add).not.toHaveBeenCalled();
    const drained = await sqlState(sink.drain());
    return { add, addBulk, seen, registry, onCommit, drained };
  }

  describe("queueStepDiffs", () => {
    test("queueStepDiffs bumps and queues exactly the named steps with their job ids", async () => {
      const s = await seed({
        checkpoints: [
          { name: "a", verdict: "unresolved" },
          { name: "b", verdict: "passed" },
          { name: "c", verdict: "unresolved" },
        ],
      });
      // Every step already diffed by the per-step pipeline (version 1): no
      // legacy fan-out.
      await h.db
        .update(screenshots)
        .set({ diffGeneration: 1 })
        .where(eq(screenshots.runId, s.runId));
      const [a, b, c] = s.shotsInOrder.map((x) => x.id) as [
        string,
        string,
        string,
      ];

      const { add, addBulk, seen, registry, drained } = await queueInTx(
        runOf(s, "main"),
        [a, c],
      );

      expect(drained).toBe("ok");
      // One round trip for the whole call.
      expect(addBulk).toHaveBeenCalledTimes(1);
      expect(add.mock.calls).toEqual([
        [
          "diff",
          {
            runId: s.runId,
            projectId: s.projectId,
            screenshotId: a,
            generation: 2,
            parentPrBaseBranch: "main",
          },
          { jobId: `${a}-g2` },
        ],
        [
          "diff",
          {
            runId: s.runId,
            projectId: s.projectId,
            screenshotId: c,
            generation: 2,
            parentPrBaseBranch: "main",
          },
          { jobId: `${c}-g2` },
        ],
      ]);
      // Each job was added once its version was committed.
      expect(seen).toEqual([2, 2]);
      expect(
        await counterValue(registry, ENQUEUED, { trigger: "threshold" }),
      ).toBe(2);

      const after = await versions(s.runId);
      for (const id of [a, c]) {
        expect(after.get(id)).toMatchObject({ generation: 2, requeues: 0 });
        expect(after.get(id)!.queuedAt).toBeInstanceOf(Date);
      }
      // A re-diff keeps the step's result until the new one replaces it.
      expect(after.get(a)!.verdict).toBe("unresolved");
      // The step not named is left alone.
      expect(after.get(b)).toMatchObject({
        generation: 1,
        queuedAt: null,
        verdict: "passed",
      });
    });

    test("an empty list queues nothing", async () => {
      // A legacy run (version 0, with verdicts): even its fan-out needs a step.
      const s = await seed({
        checkpoints: [
          { name: "a", verdict: "unresolved" },
          { name: "b", verdict: "passed" },
        ],
      });

      const { add, onCommit, drained } = await queueInTx(runOf(s), []);

      expect(drained).toBe("ok");
      expect(onCommit).not.toHaveBeenCalled();
      expect(add).not.toHaveBeenCalled();
      for (const row of (await versions(s.runId)).values()) {
        expect(row).toMatchObject({ generation: 0, queuedAt: null });
      }
    });

    test("a legacy run's first re-diff of one step queues all its gen-0 steps", async () => {
      const s = await seed({
        checkpoints: [
          { name: "a", verdict: "unresolved" },
          { name: "b", verdict: "passed" },
          { name: "c", verdict: null },
        ],
      });
      const ids = s.shotsInOrder.map((x) => x.id);

      const { add, drained } = await queueInTx(runOf(s), [ids[1]!]);

      expect(drained).toBe("ok");
      // Its totals fold the steps' own columns, which no legacy step has: the
      // whole run is re-diffed once, each step at its new version 1.
      expect(add.mock.calls.map(([, , o]) => o)).toEqual(
        ids.map((id) => ({ jobId: `${id}-g1` })),
      );
      expect(add.mock.calls.map(([, p]) => p.generation)).toEqual([1, 1, 1]);
      for (const row of (await versions(s.runId)).values()) {
        expect(row.generation).toBe(1);
      }
    });

    test("a second re-diff queues only the named step", async () => {
      const s = await seed({
        checkpoints: [
          { name: "a", verdict: "unresolved" },
          { name: "b", verdict: "passed" },
          { name: "c", verdict: "unresolved" },
        ],
      });
      const [a, b, c] = s.shotsInOrder.map((x) => x.id) as [
        string,
        string,
        string,
      ];
      expect((await queueInTx(runOf(s), [a])).add).toHaveBeenCalledTimes(3);

      // No version-0 step is left: the fan-out happened once.
      const { add, drained } = await queueInTx(runOf(s), [c]);

      expect(drained).toBe("ok");
      expect(add.mock.calls).toEqual([
        [
          "diff",
          {
            runId: s.runId,
            projectId: s.projectId,
            screenshotId: c,
            generation: 2,
          },
          { jobId: `${c}-g2` },
        ],
      ]);
      const after = await versions(s.runId);
      expect(after.get(a)!.generation).toBe(1);
      expect(after.get(b)!.generation).toBe(1);
      expect(after.get(c)!.generation).toBe(2);
    });

    test("two re-diffs of a legacy run at once fan out its gen-0 steps once", async () => {
      const s = await seed({
        checkpoints: [
          { name: "a", verdict: "unresolved" },
          { name: "b", verdict: "passed" },
          { name: "c", verdict: "unresolved" },
        ],
      });
      const [a, b, c] = s.shotsInOrder.map((x) => x.id) as [
        string,
        string,
        string,
      ];

      // Neither caller holds the run: `queueStepDiffs` locks it before it
      // reads the run's version-0 steps.
      const [first, second] = await bothAtOnce(s.runId, () => [
        queueInTx(runOf(s), [a]),
        queueInTx(runOf(s), [c]),
      ]);

      expect([first.drained, second.drained]).toEqual(["ok", "ok"]);
      const jobIds = [...first.add.mock.calls, ...second.add.mock.calls].map(
        ([, , o]) => o.jobId,
      );
      // Every legacy step at version 1 exactly once, and one more job: the
      // named step of whichever re-diff went second, at version 2.
      const g2 = jobIds.filter((id) => id.endsWith("-g2"));
      expect(g2).toHaveLength(1);
      expect([`${a}-g2`, `${c}-g2`]).toContain(g2[0]);
      expect(jobIds.filter((id) => id.endsWith("-g1")).sort()).toEqual(
        [a, b, c].map((id) => `${id}-g1`).sort(),
      );
      const after = await versions(s.runId);
      expect(after.get(b)!.generation).toBe(1);
      expect(
        [after.get(a)!.generation, after.get(c)!.generation].sort(),
      ).toEqual([1, 2]);
    });

    test("ids that are not steps of the run are ignored", async () => {
      const s = await seed({
        checkpoints: [{ name: "a", verdict: "unresolved" }],
      });
      const other = await addReviewRun(h, s, {
        checkpoints: [{ name: "x", verdict: "unresolved" }],
      });
      await h.db
        .update(screenshots)
        .set({ diffGeneration: 1 })
        .where(eq(screenshots.projectId, s.projectId));
      const a = s.shots.a!.id;
      const x = other.shots.x!.id;

      const { add } = await queueInTx(runOf(s), [a, x]);

      expect(add.mock.calls.map(([, p]) => p.screenshotId)).toEqual([a]);
      expect((await versions(other.runId)).get(x)!.generation).toBe(1);
    });

    test("a refused bulk surfaces after commit, every job in it counted as refused", async () => {
      const s = await seed({
        checkpoints: [
          { name: "a", verdict: "unresolved" },
          { name: "b", verdict: "unresolved" },
        ],
      });
      await h.db
        .update(screenshots)
        .set({ diffGeneration: 1 })
        .where(eq(screenshots.runId, s.runId));
      const [a, b] = s.shotsInOrder.map((x) => x.id) as [string, string];
      const boom = new Error("queue is down");

      const { add, addBulk, registry, drained } = await queueInTx(
        runOf(s),
        [a, b],
        {
          trigger: "undo",
          add: async (_name, data) => {
            if (data.screenshotId === a) throw boom;
            return {};
          },
        },
      );

      expect(drained).toBe(String(boom));
      expect(addBulk).toHaveBeenCalledTimes(1);
      expect(add).toHaveBeenCalledTimes(2);
      // One round trip: the queue refused the bulk, so neither job counts as
      // added.
      expect(await counterValue(registry, FAILURES, { trigger: "undo" })).toBe(
        2,
      );
      expect(await counterValue(registry, ENQUEUED, { trigger: "undo" })).toBe(
        0,
      );
      // The versions committed: the reconciler re-queues the step left without a job.
      const after = await versions(s.runId);
      expect(after.get(a)!.generation).toBe(2);
      expect(after.get(b)!.generation).toBe(2);
    });
  });

  /**
   * The diff-worker's per-step commit, as far as its locks go (an app never
   * imports another): `commitStep` locks the run `FOR NO KEY UPDATE`
   * (apps/diff-worker/src/commit-step.ts:119-128), then the step `FOR UPDATE`
   * (commit-step.ts:132-145), and an auto-approve then locks the step's
   * variation `FOR NO KEY UPDATE` (apps/diff-worker/src/auto-approve-guard.ts:
   * 52-56). It takes the run lock, waits until `parked()` says the request
   * under test is waiting on it, then takes the step and variation locks.
   */
  async function workerCommit(
    side: ReturnType<typeof createDb>,
    target: { runId: string; stepId: string; variationId: string },
    parked: (workerPid: number) => Promise<boolean>,
    runLocked: () => void,
  ): Promise<{ parked: boolean }> {
    return side.db.transaction(async (tx) => {
      const [me] = await tx.execute<{ pid: number }>(
        sql`select pg_backend_pid() as pid`,
      );
      await tx
        .select({ id: testRuns.id })
        .from(testRuns)
        .where(eq(testRuns.id, target.runId))
        .for("no key update");
      runLocked();
      const wasParked = await parked(me!.pid);
      await tx
        .select({ generation: screenshots.diffGeneration })
        .from(screenshots)
        .where(
          and(
            eq(screenshots.id, target.stepId),
            eq(screenshots.runId, target.runId),
          ),
        )
        .for("update");
      await tx
        .select({ id: testVariations.id })
        .from(testVariations)
        .where(eq(testVariations.id, target.variationId))
        .for("no key update");
      return { parked: wasParked };
    });
  }

  /** Waits (up to 10 s) until a session is blocked by `workerPid`. */
  async function blockedBy(workerPid: number): Promise<boolean> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const r = await h.db.execute<{ n: number }>(sql`
        select count(*)::int as n from pg_stat_activity
        where ${workerPid}::int = any(pg_blocking_pids(pid))
      `);
      if (r[0]!.n > 0) return true;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return false;
  }

  /**
   * Waits (up to 10 s) until `n` sessions wait on `holderPid`, directly or
   * behind another waiter (a second waiter for a row queues on the first's
   * tuple lock).
   */
  async function queuedBehind(holderPid: number, n: number): Promise<boolean> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const r = await h.db.execute<{ n: number }>(sql`
        with recursive waiting(pid) as (
          select ${holderPid}::int
          union
          select a.pid from pg_stat_activity a, waiting w
          where w.pid = any(pg_blocking_pids(a.pid))
        )
        select count(*)::int - 1 as n from waiting
      `);
      if (r[0]!.n >= n) return true;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return false;
  }

  /**
   * Holds `runId`'s row lock (`FOR NO KEY UPDATE`) on a connection of its own
   * while `start()` begins two requests, until both wait on it; then lets
   * them through, one at a time, and returns what they returned. So the two
   * really run at once: neither can have read the run before the other.
   */
  async function bothAtOnce<A, B>(
    runId: string,
    start: () => [Promise<A>, Promise<B>],
  ): Promise<[A, B]> {
    const side = createDb();
    try {
      let release!: () => void;
      const released = new Promise<void>((r) => (release = r));
      let holding!: (pid: number) => void;
      const held = new Promise<number>((r) => (holding = r));
      const holder = side.db.transaction(async (tx) => {
        const [me] = await tx.execute<{ pid: number }>(
          sql`select pg_backend_pid() as pid`,
        );
        await tx
          .select({ id: testRuns.id })
          .from(testRuns)
          .where(eq(testRuns.id, runId))
          .for("no key update");
        holding(me!.pid);
        await released;
      });
      const pid = await held;
      const [a, b] = start();
      const waited = await queuedBehind(pid, 2);
      release();
      await holder;
      const out = await Promise.all([a, b]);
      expect(waited).toBe(true);
      return out;
    } finally {
      await side.close();
    }
  }

  /**
   * A run of `s`'s build whose one step (renamed `<name>-prior`) is on the
   * variation of `<name>`: an upload of `<name>` then adds another step of the
   * same run on the same variation.
   */
  async function runSharingVariation(
    s: ReviewSeed,
    name: string,
  ): Promise<ReviewRun & { stepId: string; variationId: string }> {
    const run = await addReviewRun(h, s, {
      checkpoints: [{ name, verdict: null }],
    });
    const shot = run.shots[name]!;
    await h.db
      .update(screenshots)
      .set({ name: `${name}-prior` })
      .where(eq(screenshots.id, shot.id));
    return { ...run, stepId: shot.id, variationId: shot.variationId };
  }

  s3("the SDK upload", () => {
    beforeEach(() => {
      h.diffQueueAdd.mockClear();
    });

    function upload(runId: string, jwt: string, name: string) {
      return h.app.inject({
        method: "POST",
        url: `/runs/${runId}/screenshots/base64`,
        headers: {
          Authorization: `Bearer ${jwt}`,
          "Content-Type": "application/json",
        },
        payload: {
          pngBase64: TINY_PNG.toString("base64"),
          name,
          viewport: "1280x720",
          browser: "chromium",
        },
      });
    }

    test("upload queues one job for the new step at generation 1", async () => {
      const s = await seed({
        checkpoints: [{ name: "home", verdict: "unresolved" }],
      });
      // A run the per-step pipeline already diffed: no legacy fan-out.
      await h.db
        .update(screenshots)
        .set({ diffGeneration: 1 })
        .where(eq(screenshots.runId, s.runId));
      const before = await counterValue(h.app.telemetry.metrics, ENQUEUED, {
        trigger: "upload",
      });

      const res = await upload(s.runId, s.editor.jwt, "checkout");

      expect(res.statusCode).toBe(200);
      const { screenshotId } = res.json() as { screenshotId: string };
      expect(h.diffQueueAdd.mock.calls).toEqual([
        [
          "diff",
          {
            runId: s.runId,
            projectId: s.projectId,
            screenshotId,
            generation: 1,
          },
          { jobId: `${screenshotId}-g1` },
        ],
      ]);
      expect(
        await counterValue(h.app.telemetry.metrics, ENQUEUED, {
          trigger: "upload",
        }),
      ).toBe(before + 1);
      // The insert set the version the job carries, and its queue time.
      const step = (await versions(s.runId)).get(screenshotId)!;
      expect(step).toMatchObject({ generation: 1, requeues: 0, verdict: null });
      expect(step.queuedAt).toBeInstanceOf(Date);
      // The step already in the run is not re-diffed.
      expect((await versions(s.runId)).get(s.shots.home!.id)).toMatchObject({
        generation: 1,
        queuedAt: null,
      });
    });

    test("an upload into a run whose earlier steps have verdicts at gen 0 queues them at g1 with its own step", async () => {
      const s = await seed({
        checkpoints: [
          { name: "home", verdict: "unresolved" },
          { name: "cart", verdict: "passed" },
          { name: "waiting", verdict: null },
        ],
      });
      const legacy = s.shotsInOrder.map((x) => x.id);
      const before = await counterValue(h.app.telemetry.metrics, ENQUEUED, {
        trigger: "upload",
      });

      const res = await upload(s.runId, s.editor.jwt, "checkout");

      expect(res.statusCode).toBe(200);
      const { screenshotId } = res.json() as { screenshotId: string };
      // Ruling R40: every version-0 step once, in capture order, then the new
      // step, each at version 1 under its job id.
      expect(h.diffQueueAdd.mock.calls).toEqual(
        [...legacy, screenshotId].map((id) => [
          "diff",
          {
            runId: s.runId,
            projectId: s.projectId,
            screenshotId: id,
            generation: 1,
          },
          { jobId: `${id}-g1` },
        ]),
      );
      expect(
        await counterValue(h.app.telemetry.metrics, ENQUEUED, {
          trigger: "upload",
        }),
      ).toBe(before + 4);
      const after = await versions(s.runId);
      for (const id of [...legacy, screenshotId]) {
        expect(after.get(id)!.generation).toBe(1);
        expect(after.get(id)!.queuedAt).toBeInstanceOf(Date);
      }
      // The re-diff keeps the legacy steps' results until the new ones land.
      expect(after.get(legacy[0]!)!.verdict).toBe("unresolved");
    });

    test("a second upload into the same run queues only its own step", async () => {
      const s = await seed({
        checkpoints: [
          { name: "home", verdict: "unresolved" },
          { name: "cart", verdict: "passed" },
        ],
      });
      const first = await upload(s.runId, s.editor.jwt, "checkout");
      expect(first.statusCode).toBe(200);
      expect(h.diffQueueAdd).toHaveBeenCalledTimes(3);
      h.diffQueueAdd.mockClear();

      const res = await upload(s.runId, s.editor.jwt, "payment");

      expect(res.statusCode).toBe(200);
      const { screenshotId } = res.json() as { screenshotId: string };
      expect(h.diffQueueAdd.mock.calls).toEqual([
        [
          "diff",
          {
            runId: s.runId,
            projectId: s.projectId,
            screenshotId,
            generation: 1,
          },
          { jobId: `${screenshotId}-g1` },
        ],
      ]);
      for (const shot of s.shotsInOrder) {
        expect((await versions(s.runId)).get(shot.id)!.generation).toBe(1);
      }
    });

    test("two uploads at once into a legacy run fan out its gen-0 steps once, each queueing its own step", async () => {
      const s = await seed({
        checkpoints: [
          { name: "home", verdict: "unresolved" },
          { name: "cart", verdict: "passed" },
          { name: "waiting", verdict: null },
        ],
      });
      const legacy = s.shotsInOrder.map((x) => x.id);

      const [one, two] = await bothAtOnce(s.runId, () => [
        upload(s.runId, s.editor.jwt, "checkout"),
        upload(s.runId, s.editor.jwt, "payment"),
      ]);

      expect([one.statusCode, two.statusCode]).toEqual([200, 200]);
      const added = [one, two].map(
        (r) => (r.json() as { screenshotId: string }).screenshotId,
      );
      // Each legacy step's job exactly once, at version 1, and each upload's
      // own step at version 1.
      expect(
        h.diffQueueAdd.mock.calls.map(([, , o]) => o.jobId).sort(),
      ).toEqual([...legacy, ...added].map((id) => `${id}-g1`).sort());
      const after = await versions(s.runId);
      for (const id of [...legacy, ...added]) {
        expect(after.get(id)!.generation).toBe(1);
      }
    });

    test("a duplicate upload into a legacy run fans out nothing", async () => {
      const s = await seed({
        checkpoints: [
          { name: "home", verdict: "unresolved" },
          { name: "cart", verdict: "passed" },
        ],
      });

      // `home` at the seed's viewport and browser: the step already there.
      const res = await upload(s.runId, s.editor.jwt, "home");

      expect(res.statusCode).toBe(200);
      expect((res.json() as { screenshotId: string }).screenshotId).toBe(
        s.shots.home!.id,
      );
      expect(h.diffQueueAdd).not.toHaveBeenCalled();
      for (const row of (await versions(s.runId)).values()) {
        expect(row).toMatchObject({ generation: 0, queuedAt: null });
      }
    });

    test("a duplicate upload queues nothing", async () => {
      const s = await seed({
        checkpoints: [{ name: "home", verdict: "unresolved" }],
      });
      const first = await upload(s.runId, s.editor.jwt, "checkout");
      expect(first.statusCode).toBe(200);
      const { screenshotId } = first.json() as { screenshotId: string };
      h.diffQueueAdd.mockClear();

      const again = await upload(s.runId, s.editor.jwt, "checkout");

      expect(again.statusCode).toBe(200);
      expect((again.json() as { screenshotId: string }).screenshotId).toBe(
        screenshotId,
      );
      expect(h.diffQueueAdd).not.toHaveBeenCalled();
      expect((await versions(s.runId)).get(screenshotId)!.generation).toBe(1);
    });

    test("an upload never deadlocks with a diff commit auto-approving another step of its run and variation (20 runs)", async () => {
      const s = await seed({
        checkpoints: [{ name: "seed", verdict: "passed" }],
      });
      const side = createDb();
      try {
        for (let i = 0; i < 20; i++) {
          const name = `dl-${i}`;
          const run = await runSharingVariation(s, name);
          let runLocked!: () => void;
          const locked = new Promise<void>((r) => (runLocked = r));
          // The worker holds the run when the upload starts: the one order
          // in which an upload that locked the variation first would deadlock.
          const worker = workerCommit(
            side,
            {
              runId: run.runId,
              stepId: run.stepId,
              variationId: run.variationId,
            },
            blockedBy,
            runLocked,
          );
          worker.catch(() => runLocked());
          await locked;
          const uploaded = upload(run.runId, s.editor.jwt, name);

          const [workerState, res] = await Promise.all([
            sqlState(worker),
            uploaded,
          ]);
          expect({ i, workerState, upload: res.statusCode }).toEqual({
            i,
            workerState: "ok",
            upload: 200,
          });
          expect((await worker).parked).toBe(true);
          // The upload added a second step of the run on the same variation.
          const steps = await h.db
            .select({ variationId: screenshots.testVariationId })
            .from(screenshots)
            .where(eq(screenshots.runId, run.runId));
          expect(steps).toEqual([
            { variationId: run.variationId },
            { variationId: run.variationId },
          ]);
        }
      } finally {
        await side.close();
      }
    });
  });

  describe("an ignore-area edit locks the run before the variation", () => {
    const region = {
      x: 1,
      y: 1,
      width: 5,
      height: 5,
      viewport: "1280x720",
      paddingPx: 0,
      kind: "ignore" as const,
    };

    function client(jwt: string) {
      return createTRPCClient<AppRouter>({
        links: [
          httpBatchLink({
            url: `${baseUrl}/trpc`,
            headers: { authorization: `Bearer ${jwt}` },
          }),
        ],
      });
    }

    test.each(["setIgnoreAreas", "addIgnoreAreas"] as const)(
      "%s never deadlocks with a diff commit auto-approving a step of that variation",
      async (procedure) => {
        const s = await seed({
          checkpoints: [{ name: "home", verdict: "unresolved" }],
        });
        const step = s.shots.home!;
        const side = createDb();
        try {
          let runLocked!: () => void;
          const locked = new Promise<void>((r) => (runLocked = r));
          const worker = workerCommit(
            side,
            { runId: s.runId, stepId: step.id, variationId: step.variationId },
            blockedBy,
            runLocked,
          );
          worker.catch(() => runLocked());
          await locked;
          const input = {
            runId: s.runId,
            scope: "variation" as const,
            checkpointId: step.id,
            ignoreAreas: [region],
          };
          const c = client(s.editor.jwt);
          const edit =
            procedure === "setIgnoreAreas"
              ? c.runs.setIgnoreAreas.mutate(input)
              : c.runs.addIgnoreAreas.mutate(input);

          const [workerState, editState] = await Promise.all([
            sqlState(worker),
            sqlState(edit),
          ]);
          expect({ workerState, editState }).toEqual({
            workerState: "ok",
            editState: "ok",
          });
          // The edit waited on the run, before it wrote the variation.
          expect((await worker).parked).toBe(true);
          const [v] = await h.db
            .select({ ignoreRegions: testVariations.ignoreRegions })
            .from(testVariations)
            .where(eq(testVariations.id, step.variationId));
          expect(v!.ignoreRegions).toEqual([region]);
        } finally {
          await side.close();
        }
      },
    );
  });
});
