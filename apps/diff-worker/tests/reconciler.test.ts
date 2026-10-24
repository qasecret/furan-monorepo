import { randomUUID } from "node:crypto";

import {
  builds,
  bumpStepGenerations,
  createDb,
  eq,
  projects,
  screenshots,
  sql,
  testRuns,
  testVariations,
  type DB,
} from "@furan/db";
import {
  createQueue,
  createWorker,
  diffJobId,
  type DiffJob,
  type Queue,
} from "@furan/queue";
import { Redis } from "ioredis";
import { Registry } from "prom-client";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { commitStep } from "../src/commit-step.js";
import type { StepResult } from "../src/diff-step.js";
import type { HandlerDeps } from "../src/handler.js";
import { reconcileStuckSteps, type ReconcileQueue } from "../src/reconciler.js";

import { counterValue } from "./helpers/metrics.js";

/**
 * The reconciler (spec 2026-10-23 §6, rulings R10 and R23 to R26): every 30 s
 * it re-queues a step whose diff job was lost, fails one it re-queued 3 times
 * with `timeout`, and empties a step-less `running` run. It never turns a step
 * without a result into `passed` by time, and never touches a backlog.
 *
 * The clock is faked through `now`. The queue is a fake whose jobs each test
 * sets; it reports a still-waiting job for any id the test did not name, so a
 * pass leaves alone every step that is not the test's, whatever else the
 * shared database holds.
 */

const skip = !process.env.DATABASE_URL || !process.env.REDIS_URL;
const desc = skip ? describe.skip : describe;

const MIN = 60_000;
const ENQUEUED = "furan_diff_jobs_enqueued_total";

/** A clock `ms` ahead of the real one. */
const later =
  (ms: number): (() => Date) =>
  () =>
    new Date(Date.now() + ms);
/** Past the 10-minute window of a step queued (or claimed) just now. */
const STUCK = later(11 * MIN);
/** A time no real row has: a clock near it sees only what a test dated so. */
const LONG_AGO = new Date("2000-01-01T00:00:00Z");
const longAfter = (minutes: number): Date =>
  new Date(LONG_AGO.getTime() + minutes * MIN);

/** Resolves when `promise` does, or after `ms`, whichever is first. */
async function within(promise: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<void>((resolve) => (timer = setTimeout(resolve, ms))),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const LIVE_STATES = [
  "waiting",
  "active",
  "delayed",
  "prioritized",
  "waiting-children",
];

type FakeJob = {
  getState: () => Promise<string>;
  remove: () => Promise<void>;
};

/** A job in `state`; `remove` succeeds unless the test says otherwise. */
function job(
  state: string,
  remove: () => Promise<void> = vi.fn(async () => undefined),
): FakeJob {
  return { getState: vi.fn(async () => state), remove };
}

/**
 * A queue that knows the jobs in `jobs` (an id mapped to `undefined` is
 * missing, a function is called for each look-up). Any other id is a job still
 * waiting, so the pass leaves its step alone.
 */
function fakeQueue(
  jobs: Record<
    string,
    FakeJob | undefined | (() => Promise<FakeJob | undefined>)
  > = {},
) {
  const foreign = job("waiting");
  return {
    getJob: vi.fn(async (id: string): Promise<FakeJob | undefined> => {
      if (!(id in jobs)) return foreign;
      const entry = jobs[id];
      return typeof entry === "function" ? entry() : entry;
    }),
    add: vi.fn(
      async (
        _name: "diff",
        _data: DiffJob,
        _opts: { jobId: string },
      ): Promise<unknown> => undefined,
    ),
  };
}

/** What a diff of a step with no baseline commits: verdict `new`, nothing else. */
function firstCapture(screenshotId: string): StepResult {
  return {
    screenshotId,
    verdict: "new",
    firstBaseline: true,
    regions: [],
    engineIds: [],
    ranTiers: [],
    diffSignature: null,
    diffImageKey: null,
    diffPercent: null,
    pixelMismatchCount: null,
    baselineSource: null,
    vlmDescription: null,
    ruleResolved: false,
    autoApprove: null,
    ocrAudit: [],
    ruleDecisions: [],
    ruleDiagnostics: null,
  };
}

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
  child: () => logger,
} as unknown as Parameters<typeof reconcileStuckSteps>[0]["logger"];

desc("reconcileStuckSteps", () => {
  let db: DB;
  let closeDb: () => Promise<void>;
  let redis: Redis;
  let registry: Registry;
  let projectId: string;
  let buildId: string;
  let variationId: string;

  beforeAll(async () => {
    const created = createDb();
    db = created.db;
    closeDb = created.close;
    redis = new Redis(process.env.REDIS_URL!);
    const [p] = await db
      .insert(projects)
      .values({ name: `reconciler-${randomUUID()}`, mainBranchName: "main" })
      .returning();
    projectId = p!.id;
    const [b] = await db
      .insert(builds)
      .values({ projectId, isRunning: true })
      .returning();
    buildId = b!.id;
    const [v] = await db
      .insert(testVariations)
      .values({ name: "home", projectId, branchName: "feature" })
      .returning();
    variationId = v!.id;
  });

  beforeEach(() => {
    registry = new Registry();
    vi.mocked(logger.error).mockClear();
    vi.mocked(logger.warn).mockClear();
  });

  // Each test sees only its own runs.
  afterEach(async () => {
    await db.delete(testRuns).where(eq(testRuns.projectId, projectId));
  });

  afterAll(async () => {
    try {
      if (projectId) {
        await db.delete(projects).where(eq(projects.id, projectId));
      }
    } finally {
      await redis.quit();
      await closeDb();
    }
  });

  /** A run of the shared project with `steps` steps, none diffed yet. */
  async function seedRun(
    opts: {
      steps?: number;
      status?: "running" | "passed" | "aborted";
      parentBranchName?: string | null;
      updatedAt?: Date;
      checkpointCount?: number;
      /** The steps' upload time (default: now). */
      createdAt?: Date;
    } = {},
  ): Promise<{ runId: string; steps: string[] }> {
    const [r] = await db
      .insert(testRuns)
      .values({
        projectId,
        buildId,
        name: `run-${randomUUID()}`,
        branchName: "feature",
        status: opts.status ?? "running",
        parentBranchName: opts.parentBranchName ?? null,
        checkpointCount: opts.checkpointCount ?? 0,
        ...(opts.updatedAt ? { updatedAt: opts.updatedAt } : {}),
      })
      .returning();
    const runId = r!.id;
    const steps: string[] = [];
    for (let i = 0; i < (opts.steps ?? 1); i++) {
      const [s] = await db
        .insert(screenshots)
        .values({
          runId,
          projectId,
          testVariationId: variationId,
          name: `step-${i}`,
          viewport: "1280x720",
          browser: "chromium",
          imageKey: randomUUID(),
          ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
        })
        .returning();
      steps.push(s!.id);
    }
    return { runId, steps };
  }

  /** Queues steps for a diff as the pipeline does; their versions, in order. */
  async function queueSteps(runId: string, steps: string[]): Promise<number[]> {
    const bumped = await db.transaction((tx) =>
      bumpStepGenerations(tx, runId, steps),
    );
    const of = new Map(bumped.map((b) => [b.id, b.generation]));
    return steps.map((id) => of.get(id)!);
  }

  async function stepRow(id: string) {
    const [row] = await db
      .select({
        verdict: screenshots.verdict,
        diffGeneration: screenshots.diffGeneration,
        diffRequeues: screenshots.diffRequeues,
        diffFailedAt: screenshots.diffFailedAt,
        diffError: screenshots.diffError,
        // Full precision: a claim compares it exactly.
        queuedAt: sql<string | null>`${screenshots.diffQueuedAt}::text`,
      })
      .from(screenshots)
      .where(eq(screenshots.id, id));
    return row!;
  }

  async function runRow(id: string) {
    const [row] = await db
      .select({
        status: testRuns.status,
        checkpointCount: testRuns.checkpointCount,
        completedAt: testRuns.completedAt,
      })
      .from(testRuns)
      .where(eq(testRuns.id, id));
    return row!;
  }

  const updateSteps = () => db.update(screenshots);
  /** Sets columns of one step (a value or SQL, as `set` takes them). */
  const setStep = (
    id: string,
    values: Parameters<ReturnType<typeof updateSteps>["set"]>[0],
  ) => updateSteps().set(values).where(eq(screenshots.id, id));

  const pass = (
    queue: ReturnType<typeof fakeQueue>,
    over: Partial<Parameters<typeof reconcileStuckSteps>[0]> = {},
  ) =>
    reconcileStuckSteps({
      db,
      queue,
      redis,
      logger,
      registry,
      now: STUCK,
      ...over,
    });

  const enqueued = () =>
    counterValue(registry, ENQUEUED, { trigger: "reconcile" });

  /** The frames published on `channel` while `fn` ran. */
  async function framesOn(
    channel: string,
    fn: () => Promise<unknown>,
  ): Promise<Array<Record<string, unknown>>> {
    const frames: Array<Record<string, unknown>> = [];
    const sub = new Redis(process.env.REDIS_URL!);
    let done!: () => void;
    const settled = new Promise<void>((resolve) => (done = resolve));
    sub.on("message", (_channel, message) => {
      const frame = JSON.parse(message) as Record<string, unknown>;
      if (frame.type === "test.sentinel") done();
      else frames.push(frame);
    });
    await sub.subscribe(channel);
    try {
      await fn();
      // Redis delivers a channel in publish order: once this arrives, nothing
      // `fn` published is still in flight.
      await redis.publish(channel, JSON.stringify({ type: "test.sentinel" }));
      await settled;
    } finally {
      sub.disconnect();
    }
    return frames;
  }

  it("re-adds a stuck step whose job is missing", async () => {
    const { runId, steps } = await seedRun({ parentBranchName: "release" });
    const [step] = steps as [string];
    const [generation] = (await queueSteps(runId, steps)) as [number];
    const queuedAt = (await stepRow(step)).queuedAt;
    const jobId = diffJobId(step, generation);
    const queue = fakeQueue({ [jobId]: undefined });
    // Ruling R26: the claim has committed by the time the job is added.
    let requeuesAtAdd: number | undefined;
    queue.add.mockImplementation(async () => {
      requeuesAtAdd = (await stepRow(step)).diffRequeues;
    });

    const result = await pass(queue);

    expect(result).toMatchObject({ requeued: 1, failed: 0, errors: 0 });
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledWith(
      "diff",
      {
        runId,
        projectId,
        screenshotId: step,
        generation,
        parentPrBaseBranch: "release",
      },
      { jobId },
    );
    expect(requeuesAtAdd).toBe(1);
    const row = await stepRow(step);
    expect(row.diffRequeues).toBe(1);
    expect(row.diffGeneration).toBe(generation);
    expect(row.queuedAt).not.toBe(queuedAt);
    expect(row.verdict).toBeNull();
    expect(await enqueued()).toBe(1);
  });

  it("leaves a step whose job is still waiting alone", async () => {
    const { runId, steps } = await seedRun();
    const [step] = steps as [string];
    const [generation] = (await queueSteps(runId, steps)) as [number];
    const jobId = diffJobId(step, generation);
    const waiting = job("waiting");
    const queue = fakeQueue({ [jobId]: waiting });
    const before = await stepRow(step);

    // A backlog an hour deep is still a backlog, not a lost job.
    const result = await pass(queue, { now: later(60 * MIN) });

    expect(result).toMatchObject({ requeued: 0, failed: 0, errors: 0 });
    expect(queue.getJob).toHaveBeenCalledWith(jobId);
    expect(waiting.remove).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
    expect(await stepRow(step)).toEqual(before);
    expect(await enqueued()).toBe(0);
  });

  it.each(LIVE_STATES.filter((s) => s !== "waiting"))(
    "leaves a step whose job is %s alone",
    async (state) => {
      const { runId, steps } = await seedRun();
      const [step] = steps as [string];
      const [generation] = (await queueSteps(runId, steps)) as [number];
      const live = job(state);
      const queue = fakeQueue({ [diffJobId(step, generation)]: live });
      const before = await stepRow(step);

      const result = await pass(queue);

      expect(result).toMatchObject({ requeued: 0, failed: 0, errors: 0 });
      expect(live.remove).not.toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();
      expect(await stepRow(step)).toEqual(before);
    },
  );

  it("fails the step with timeout after 3 re-queues", async () => {
    const { runId, steps } = await seedRun();
    const [step] = steps as [string];
    const [generation] = (await queueSteps(runId, steps)) as [number];
    const queue = fakeQueue({ [diffJobId(step, generation)]: undefined });

    // Each pass runs 10 minutes after the previous claim, and the job never
    // shows up.
    for (const requeues of [1, 2, 3]) {
      const result = await pass(queue);
      expect(result).toMatchObject({ requeued: 1, failed: 0, errors: 0 });
      expect((await stepRow(step)).diffRequeues).toBe(requeues);
    }
    const last = await pass(queue);

    expect(last).toMatchObject({ requeued: 0, failed: 1, errors: 0 });
    expect(queue.add).toHaveBeenCalledTimes(3);
    expect(await enqueued()).toBe(3);
    const row = await stepRow(step);
    expect(row.verdict).toBe("unresolved");
    expect(row.diffError).toBe("timeout");
    expect(row.diffFailedAt).toBeInstanceOf(Date);
    expect(row.diffGeneration).toBe(generation);
    expect((await runRow(runId)).status).toBe("unresolved");

    // A failed step no longer awaits a diff: nothing is left to do.
    expect(await pass(queue)).toMatchObject({ requeued: 0, failed: 0 });
  });

  it("never marks a step passed by time", async () => {
    // Two steps without a region, stuck for an hour: A's job is lost, B's
    // still waits behind a backlog.
    const { runId, steps } = await seedRun({ steps: 2 });
    const [a, b] = steps as [string, string];
    const [genA, genB] = (await queueSteps(runId, steps)) as [number, number];
    const queue = fakeQueue({
      [diffJobId(a, genA)]: undefined,
      [diffJobId(b, genB)]: job("waiting"),
    });

    for (let i = 0; i < 6; i++) {
      await pass(queue, { now: later(60 * MIN) });
      const verdicts = (await Promise.all(steps.map(stepRow))).map(
        (r) => r.verdict,
      );
      expect(verdicts).not.toContain("passed");
      expect((await runRow(runId)).status).not.toBe("passed");
    }

    expect(await stepRow(a)).toMatchObject({
      verdict: "unresolved",
      diffError: "timeout",
    });
    expect(await stepRow(b)).toMatchObject({
      verdict: null,
      diffRequeues: 0,
      diffFailedAt: null,
    });
    // B has no result yet, so the run still waits for it.
    expect((await runRow(runId)).status).toBe("running");
  });

  it("empties a running run with no steps after 5 min", async () => {
    const now = longAfter(60);
    const stale = await seedRun({
      steps: 0,
      updatedAt: longAfter(54),
      checkpointCount: 2,
    });
    const fresh = await seedRun({ steps: 0, updatedAt: longAfter(56) });
    const withStep = await seedRun({ steps: 1, updatedAt: longAfter(54) });
    const finished = await seedRun({
      steps: 0,
      status: "passed",
      updatedAt: longAfter(54),
    });

    const result = await pass(fakeQueue(), { now: () => now });

    expect(result).toEqual({ requeued: 0, failed: 0, emptied: 1, errors: 0 });
    expect(await runRow(stale.runId)).toEqual({
      status: "empty",
      checkpointCount: 0,
      completedAt: now,
    });
    expect(await runRow(fresh.runId)).toMatchObject({
      status: "running",
      completedAt: null,
    });
    expect((await runRow(withStep.runId)).status).toBe("running");
    expect((await runRow(finished.runId)).status).toBe("passed");
  });

  it("ignores a failed step and a diffed step", async () => {
    const { runId, steps } = await seedRun({ steps: 2 });
    const [failedStep, diffedStep] = steps as [string, string];
    const gens = await queueSteps(runId, steps);
    await setStep(failedStep, {
      verdict: "unresolved",
      verdictAt: sql`clock_timestamp()`,
      diffFailedAt: sql`clock_timestamp()`,
      diffError: "engine_error",
    });
    await setStep(diffedStep, {
      verdict: "passed",
      verdictAt: sql`clock_timestamp()`,
    });
    const queue = fakeQueue({
      [diffJobId(failedStep, gens[0]!)]: undefined,
      [diffJobId(diffedStep, gens[1]!)]: undefined,
    });
    const before = await Promise.all(steps.map(stepRow));

    const result = await pass(queue, { now: later(60 * MIN) });

    expect(result).toMatchObject({ requeued: 0, failed: 0, errors: 0 });
    expect(queue.getJob).not.toHaveBeenCalledWith(
      diffJobId(failedStep, gens[0]!),
    );
    expect(queue.getJob).not.toHaveBeenCalledWith(
      diffJobId(diffedStep, gens[1]!),
    );
    expect(queue.add).not.toHaveBeenCalled();
    expect(await Promise.all(steps.map(stepRow))).toEqual(before);
  });

  it("re-queues a lost re-diff (old verdict, verdict_at < diff_queued_at)", async () => {
    const { runId, steps } = await seedRun();
    const [step] = steps as [string];
    // Diffed once, then queued again (an ignore-area change): it keeps its
    // old result until the new one lands, and that job was lost.
    await setStep(step, {
      verdict: "passed",
      verdictAt: sql`now() - interval '1 minute'`,
    });
    const [generation] = (await queueSteps(runId, steps)) as [number];
    const queue = fakeQueue({ [diffJobId(step, generation)]: undefined });

    const result = await pass(queue);

    expect(result).toMatchObject({ requeued: 1, failed: 0, errors: 0 });
    expect(queue.add).toHaveBeenCalledWith(
      "diff",
      expect.objectContaining({ screenshotId: step, generation }),
      { jobId: diffJobId(step, generation) },
    );
    const row = await stepRow(step);
    expect(row.diffRequeues).toBe(1);
    // The re-diff replaces the old result; the reconciler does not clear it.
    expect(row.verdict).toBe("passed");
  });

  it("does not touch a re-diffed step whose new result landed", async () => {
    const { runId, steps } = await seedRun();
    const [step] = steps as [string];
    const [generation] = (await queueSteps(runId, steps)) as [number];
    // The re-diff committed after it was queued, as `commitStep` stamps it.
    await setStep(step, {
      verdict: "unresolved",
      verdictAt: sql`clock_timestamp()`,
    });
    const jobId = diffJobId(step, generation);
    const queue = fakeQueue({ [jobId]: job("completed") });
    const before = await stepRow(step);

    const result = await pass(queue, { now: later(60 * MIN) });

    expect(result).toMatchObject({ requeued: 0, failed: 0, errors: 0 });
    expect(queue.getJob).not.toHaveBeenCalledWith(jobId);
    expect(await stepRow(step)).toEqual(before);
  });

  it("removes a failed job of the same version and re-adds it", async () => {
    const { runId, steps } = await seedRun();
    const [step] = steps as [string];
    const [generation] = (await queueSteps(runId, steps)) as [number];
    const jobId = diffJobId(step, generation);
    // The version's job died for good, and its failure was never written.
    const dead = job("failed");
    const queue = fakeQueue({ [jobId]: dead });

    const result = await pass(queue);

    expect(result).toMatchObject({ requeued: 1, failed: 0, errors: 0 });
    expect(dead.remove).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledWith(
      "diff",
      expect.objectContaining({ screenshotId: step, generation }),
      { jobId },
    );
    // BullMQ ignores an add whose id it still holds: the old job goes first.
    expect(vi.mocked(dead.remove).mock.invocationCallOrder[0]).toBeLessThan(
      queue.add.mock.invocationCallOrder[0]!,
    );
    expect((await stepRow(step)).diffRequeues).toBe(1);
  });

  it.each(["completed", "unknown"])(
    "removes a %s job of the same version and re-adds it",
    async (state) => {
      const { runId, steps } = await seedRun();
      const [step] = steps as [string];
      const [generation] = (await queueSteps(runId, steps)) as [number];
      const finished = job(state);
      const queue = fakeQueue({ [diffJobId(step, generation)]: finished });

      const result = await pass(queue);

      expect(result).toMatchObject({ requeued: 1, errors: 0 });
      expect(finished.remove).toHaveBeenCalledTimes(1);
      expect(queue.add).toHaveBeenCalledTimes(1);
    },
  );

  it("skips a step whose finished job cannot be removed this pass", async () => {
    const { runId, steps } = await seedRun();
    const [step] = steps as [string];
    const [generation] = (await queueSteps(runId, steps)) as [number];
    const locked = job(
      "failed",
      vi.fn(async () => {
        throw new Error("Job could not be removed because it is locked");
      }),
    );
    const queue = fakeQueue({ [diffJobId(step, generation)]: locked });
    const before = await stepRow(step);

    const result = await pass(queue);

    expect(result).toMatchObject({ requeued: 0, failed: 0, errors: 0 });
    expect(queue.add).not.toHaveBeenCalled();
    // Skipped before the claim: the step keeps its re-queue budget.
    expect(await stepRow(step)).toEqual(before);
  });

  it("a racing claim (another replica claimed first) skips without double-counting diff_requeues", async () => {
    const { runId, steps } = await seedRun();
    const [step] = steps as [string];
    const [generation] = (await queueSteps(runId, steps)) as [number];
    // Two replicas' passes both scan the step before either claims it: each
    // one's job look-up waits until the other has made its own.
    let arrived = 0;
    let bothScanned!: () => void;
    const barrier = new Promise<void>((resolve) => (bothScanned = resolve));
    const queue = fakeQueue({
      [diffJobId(step, generation)]: async () => {
        if (++arrived === 2) bothScanned();
        await barrier;
        return undefined;
      },
    });

    const [first, second] = await Promise.all([pass(queue), pass(queue)]);

    expect(arrived).toBe(2);
    expect(first.requeued + second.requeued).toBe(1);
    expect(first.errors + second.errors).toBe(0);
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect((await stepRow(step)).diffRequeues).toBe(1);
    expect(await enqueued()).toBe(1);
  });

  it("a timeout publishes run.checkpoint_diffed with failed: true", async () => {
    const { runId, steps } = await seedRun();
    const [step] = steps as [string];
    const [generation] = (await queueSteps(runId, steps)) as [number];
    // Already re-queued 3 times at this version.
    await setStep(step, { diffRequeues: 3 });
    const queue = fakeQueue({ [diffJobId(step, generation)]: undefined });

    let result: Awaited<ReturnType<typeof pass>> | undefined;
    const frames = await framesOn(`run:${runId}:events`, async () => {
      result = await pass(queue);
    });

    expect(result).toMatchObject({ requeued: 0, failed: 1, errors: 0 });
    expect(queue.add).not.toHaveBeenCalled();
    expect(frames).toContainEqual({
      type: "run.checkpoint_diffed",
      runId,
      screenshotId: step,
      verdict: "unresolved",
      failed: true,
    });
    // The failure moved the run from `running`, which integrations announce.
    expect(frames).toContainEqual(
      expect.objectContaining({
        type: "run.completed",
        runId,
        projectId,
        status: "unresolved",
      }),
    );
  });

  it("a pre-per-step step (diff_queued_at NULL, old created_at) is found and claimed at its first version", async () => {
    // Uploaded by an API that queued whole-run jobs: version 0, no queue
    // time. Its upload time is its clock, and its run is still `running`.
    const old = await seedRun({ createdAt: new Date(Date.now() - 60 * MIN) });
    const fresh = await seedRun({ createdAt: new Date(Date.now() - MIN) });
    const [oldStep] = old.steps as [string];
    const [freshStep] = fresh.steps as [string];
    const queue = fakeQueue({
      [diffJobId(oldStep, 0)]: undefined,
      [diffJobId(freshStep, 0)]: undefined,
    });
    const freshBefore = await stepRow(freshStep);

    const result = await pass(queue, { now: () => new Date() });

    expect(result).toMatchObject({ requeued: 1, failed: 0, errors: 0 });
    // Its job is the version the claim gave it, so the result it commits is
    // a per-step one: the step no longer reads as a row from before per-step
    // diffs (generation 0).
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledWith(
      "diff",
      {
        runId: old.runId,
        projectId,
        screenshotId: oldStep,
        generation: 1,
        parentPrBaseBranch: null,
      },
      { jobId: diffJobId(oldStep, 1) },
    );
    const row = await stepRow(oldStep);
    expect(row.queuedAt).not.toBeNull();
    expect(row.diffRequeues).toBe(1);
    expect(row.diffGeneration).toBe(1);
    expect(await stepRow(freshStep)).toEqual(freshBefore);

    // The job commits (not stale), and the step stays at its new version.
    const added = queue.add.mock.calls[0]![1];
    const commit = await commitStep(
      { db, redis } as unknown as HandlerDeps,
      {
        runId: added.runId,
        projectId: added.projectId,
        screenshotId: added.screenshotId!,
        generation: added.generation!,
      },
      firstCapture(oldStep),
      logger,
    );
    expect(commit.kind).toBe("committed");
    const committed = await stepRow(oldStep);
    expect(committed.verdict).toBe("new");
    expect(committed.diffGeneration).toBe(1);
  });

  it("a pre-per-step step claimed by two replicas at once is re-queued once, at one version", async () => {
    const { steps } = await seedRun({
      createdAt: new Date(Date.now() - 60 * MIN),
    });
    const [step] = steps as [string];
    const queues = [
      fakeQueue({ [diffJobId(step, 0)]: undefined }),
      fakeQueue({ [diffJobId(step, 0)]: undefined }),
    ];

    const results = await Promise.all(
      queues.map((queue) => pass(queue, { now: () => new Date() })),
    );

    expect(results.reduce((n, r) => n + r.requeued, 0)).toBe(1);
    const adds = queues.flatMap((q) => q.add.mock.calls);
    expect(adds).toHaveLength(1);
    expect(adds[0]![2]).toEqual({ jobId: diffJobId(step, 1) });
    const row = await stepRow(step);
    expect(row.diffGeneration).toBe(1);
    expect(row.diffRequeues).toBe(1);
  });

  it.each(["aborted", "passed"] as const)(
    "a pre-per-step step of a run that is %s is NOT re-queued",
    async (status) => {
      // Ruling R35: a run that is no longer `running` is left as it ended. A
      // re-diff of its old, never-diffed step would heal it and announce a
      // months-old run.
      const { steps } = await seedRun({
        status,
        createdAt: new Date(Date.now() - 60 * MIN),
      });
      const [step] = steps as [string];
      const jobId = diffJobId(step, 0);
      const queue = fakeQueue({ [jobId]: undefined });
      const before = await stepRow(step);

      const result = await pass(queue, { now: () => new Date() });

      expect(result).toMatchObject({ requeued: 0, failed: 0, errors: 0 });
      expect(queue.getJob).not.toHaveBeenCalledWith(jobId);
      expect(queue.add).not.toHaveBeenCalled();
      expect(await stepRow(step)).toEqual(before);
    },
  );

  it("a stuck step of an aborted run WITH a queue time is re-queued", async () => {
    // Queued after the upgrade (an old whole-run job split, say), then its
    // run was aborted: the re-diff still lands, and may heal the run.
    const { runId, steps } = await seedRun({ status: "aborted" });
    const [step] = steps as [string];
    const [generation] = (await queueSteps(runId, steps)) as [number];
    const queue = fakeQueue({ [diffJobId(step, generation)]: undefined });

    const result = await pass(queue);

    expect(result).toMatchObject({ requeued: 1, failed: 0, errors: 0 });
    expect(queue.add).toHaveBeenCalledWith(
      "diff",
      expect.objectContaining({ runId, screenshotId: step, generation }),
      { jobId: diffJobId(step, generation) },
    );
    expect((await stepRow(step)).diffRequeues).toBe(1);
  });

  it("one step's error doesn't stop the pass", async () => {
    const { runId, steps } = await seedRun({ steps: 2 });
    const [broken, healthy] = steps as [string, string];
    // The broken step is queued first, so the pass reaches it first.
    const [genBroken] = (await queueSteps(runId, [broken])) as [number];
    const [genHealthy] = (await queueSteps(runId, [healthy])) as [number];
    const queue = fakeQueue({
      [diffJobId(broken, genBroken)]: () =>
        Promise.reject(new Error("redis_blip")),
      [diffJobId(healthy, genHealthy)]: undefined,
    });

    const result = await pass(queue);

    expect(result).toMatchObject({ requeued: 1, failed: 0, errors: 1 });
    expect(vi.mocked(queue.getJob).mock.calls.map(([id]) => id)).toEqual(
      expect.arrayContaining([
        diffJobId(broken, genBroken),
        diffJobId(healthy, genHealthy),
      ]),
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ runId, screenshotId: broken }),
      "reconciler_step_failed",
    );
    expect((await stepRow(broken)).diffRequeues).toBe(0);
    expect((await stepRow(healthy)).diffRequeues).toBe(1);
  });

  it("an add that fails after the claim is logged, not counted, and found again next window", async () => {
    const { runId, steps } = await seedRun();
    const [step] = steps as [string];
    const [generation] = (await queueSteps(runId, steps)) as [number];
    const queue = fakeQueue({ [diffJobId(step, generation)]: undefined });
    queue.add.mockRejectedValueOnce(new Error("redis_blip"));

    const first = await pass(queue);

    expect(first).toMatchObject({ requeued: 0, failed: 0, errors: 1 });
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ runId, screenshotId: step, generation }),
      "reconciler_requeue_failed",
    );
    expect(await enqueued()).toBe(0);
    // The claim stands: the step waits out another window.
    expect((await stepRow(step)).diffRequeues).toBe(1);
    expect(await pass(queue, { now: later(5 * MIN) })).toMatchObject({
      requeued: 0,
      errors: 0,
    });

    const next = await pass(queue);

    expect(next).toMatchObject({ requeued: 1, errors: 0 });
    expect((await stepRow(step)).diffRequeues).toBe(2);
    expect(await enqueued()).toBe(1);
  });

  /**
   * Runs `fn` with a real BullMQ queue under its own prefix that holds `jobId`
   * as a job that ran once and failed for good (BullMQ keeps it 24 h). The
   * queue and its keys are gone afterwards.
   */
  async function withFailedJob(
    jobId: string,
    data: DiffJob,
    fn: (queue: Queue<DiffJob>) => Promise<void>,
  ): Promise<void> {
    const prefix = `furan-test-${randomUUID().slice(0, 8)}`;
    const queue = createQueue("diff", { prefix });
    try {
      const worker = createWorker(
        "diff",
        async () => {
          throw new Error("boom");
        },
        { prefix, concurrency: 1 },
      );
      const failed = new Promise<void>((resolve) =>
        worker.on("failed", (j) => {
          if (j?.id === jobId) resolve();
        }),
      );
      await queue.add("diff", data, { jobId, attempts: 1 });
      await failed;
      const workerClient = await worker.client;
      await worker.close();
      workerClient.disconnect();
      expect(await (await queue.getJob(jobId))!.getState()).toBe("failed");
      await fn(queue);
    } finally {
      const client = await queue.client;
      await queue.obliterate({ force: true });
      await queue.close();
      client.disconnect();
    }
  }

  it("with a real queue, removes the version's failed job and re-adds it as waiting", async () => {
    const { runId, steps } = await seedRun();
    const [step] = steps as [string];
    const [generation] = (await queueSteps(runId, steps)) as [number];
    // Queued long ago, so it is the only step a clock near then can find.
    await setStep(step, { diffQueuedAt: LONG_AGO });
    const jobId = diffJobId(step, generation);
    const data = { runId, projectId, screenshotId: step, generation };

    await withFailedJob(jobId, data, async (queue) => {
      const result = await reconcileStuckSteps({
        db,
        queue,
        redis,
        logger,
        registry,
        now: () => longAfter(11),
      });

      expect(result).toEqual({ requeued: 1, failed: 0, emptied: 0, errors: 0 });
      const requeued = await queue.getJob(jobId);
      expect(await requeued!.getState()).toBe("waiting");
      expect(requeued!.attemptsMade).toBe(0);
      expect(requeued!.data).toEqual({ ...data, parentPrBaseBranch: null });
      expect((await stepRow(step)).diffRequeues).toBe(1);
    });
  });

  // Either replica may be the one that removes last; which one wins the run
  // lock is up to timing, so both are run.
  it.each(["a", "b"] as const)(
    "two replicas racing on a step whose job failed leave exactly one waiting job (%s removes last)",
    async (last) => {
      const { runId, steps } = await seedRun();
      const [step] = steps as [string];
      const [generation] = (await queueSteps(runId, steps)) as [number];
      await setStep(step, { diffQueuedAt: LONG_AGO });
      const jobId = diffJobId(step, generation);

      await withFailedJob(
        jobId,
        { runId, projectId, screenshotId: step, generation },
        async (queue) => {
          // Both replicas find the job failed before either acts on it. Then
          // `last` removes it only once the other has re-added it (or after a
          // second, when the other is the one held up behind its locks): the
          // order in which a remove made outside the claim's locks deletes the
          // other's new job, since BullMQ removes by id whatever the job's state.
          let looked = 0;
          let bothLooked!: () => void;
          const lookedGate = new Promise<void>((r) => (bothLooked = r));
          let otherAdded!: () => void;
          const otherAddedGate = new Promise<void>((r) => (otherAdded = r));
          const replica = (name: "a" | "b"): ReconcileQueue => ({
            getJob: async (id) => {
              const found = await queue.getJob(id);
              if (id !== jobId) return found;
              if (++looked === 2) bothLooked();
              await lookedGate;
              if (!found) return undefined;
              return {
                getState: () => found.getState(),
                remove: async () => {
                  if (name === last) await within(otherAddedGate, 1_000);
                  await found.remove();
                },
              };
            },
            add: async (jobName, data, opts) => {
              const added = await queue.add(jobName, data, opts);
              if (name !== last) otherAdded();
              return added;
            },
          });
          const now = () => longAfter(11);

          const [a, b] = await Promise.all([
            reconcileStuckSteps({
              db,
              queue: replica("a"),
              redis,
              logger,
              registry,
              now,
            }),
            reconcileStuckSteps({
              db,
              queue: replica("b"),
              redis,
              logger,
              registry,
              now,
            }),
          ]);

          expect(looked).toBe(2);
          expect(a.requeued + b.requeued).toBe(1);
          expect(a.errors + b.errors).toBe(0);
          // The step has its job: one, waiting, at its version.
          const requeued = await queue.getJob(jobId);
          expect(requeued).toBeDefined();
          expect(await requeued!.getState()).toBe("waiting");
          expect(await queue.getJobCounts("waiting", "failed")).toMatchObject({
            waiting: 1,
            failed: 0,
          });
          expect((await stepRow(step)).diffRequeues).toBe(1);
          expect(await enqueued()).toBe(1);
        },
      );
    },
  );
});
