import { randomUUID } from "node:crypto";

import {
  builds,
  computeRunCounters,
  createDb,
  eq,
  loadRollupInputs,
  projects,
  screenshots,
  testRuns,
  testVariations,
  type DB,
  type RunCounters,
  type RunStatus,
} from "@furan/db";
import type { DiffJob } from "@furan/queue";
import { createStorage, type Storage } from "@furan/storage";
import { Redis } from "ioredis";
import { Registry } from "prom-client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { commitStep } from "../src/commit-step.js";
import type { StepResult } from "../src/diff-step.js";
import { handleDiffJob, type HandlerDeps } from "../src/handler.js";
import { reconcileStuckSteps, type ReconcileQueue } from "../src/reconciler.js";

/**
 * The diff-worker's writes of a run's inputs keep its stored pending counters
 * (spec 2026-10-27 speed-at-scale server reads §3.2) equal to what their
 * definition gives (`computeRunCounters` over the run as it stands): a diff
 * commit, a step's final failure, an old whole-run job's abort, and the
 * reconciler's empty-run rule.
 */
const skip =
  !process.env.DATABASE_URL ||
  !process.env.REDIS_URL ||
  !process.env.S3_ENDPOINT;
const desc = skip ? describe.skip : describe;

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
  child: () => logger,
} as unknown as Parameters<typeof handleDiffJob>[1];

/** A step's diff result with no regions and no image. */
function result(
  screenshotId: string,
  verdict: StepResult["verdict"],
): StepResult {
  return {
    screenshotId,
    verdict,
    firstBaseline: verdict === "new",
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

desc("run counters: the diff-worker's writers", () => {
  let db: DB;
  let closeDb: () => Promise<void>;
  let storage: Storage;
  let redis: Redis;
  let projectId: string;
  let buildId: string;

  beforeAll(async () => {
    const created = createDb();
    db = created.db;
    closeDb = created.close;
    storage = createStorage();
    redis = new Redis(process.env.REDIS_URL!);
    const [p] = await db
      .insert(projects)
      .values({ name: `dw-counters-${randomUUID()}` })
      .returning({ id: projects.id });
    projectId = p!.id;
    const [b] = await db
      .insert(builds)
      .values({ projectId, branchName: "feature" })
      .returning({ id: builds.id });
    buildId = b!.id;
  }, 60_000);

  afterAll(async () => {
    // projects cascade to builds / runs / screenshots / variations.
    if (projectId) await db.delete(projects).where(eq(projects.id, projectId));
    await redis.quit();
    await closeDb();
  });

  /**
   * A run with one step per verdict (every step at version 1, its own
   * variation), and the counters a writer would have left for it.
   */
  async function seedRun(
    status: RunStatus,
    verdicts: Array<"new" | "passed" | "unresolved" | null>,
    opts: {
      updatedAt?: Date;
      /** Every step's queue time and re-queue count (default: now, 0). */
      queuedAt?: Date;
      requeues?: number;
    } = {},
  ): Promise<{ runId: string; steps: string[] }> {
    const [r] = await db
      .insert(testRuns)
      .values({
        projectId,
        buildId,
        name: `run-${randomUUID()}`,
        branchName: "feature",
        status,
        ...(opts.updatedAt ? { updatedAt: opts.updatedAt } : {}),
      })
      .returning({ id: testRuns.id });
    const runId = r!.id;
    const steps: string[] = [];
    for (const [i, verdict] of verdicts.entries()) {
      const [v] = await db
        .insert(testVariations)
        .values({
          projectId,
          name: `step-${i}-${randomUUID()}`,
          branchName: "feature",
          browser: "chromium",
          viewport: "1280x720",
        })
        .returning({ id: testVariations.id });
      const [s] = await db
        .insert(screenshots)
        .values({
          runId,
          projectId,
          testVariationId: v!.id,
          name: `step-${i}`,
          viewport: "1280x720",
          browser: "chromium",
          imageKey: `img-${randomUUID()}`,
          verdict,
          verdictAt: verdict === null ? null : new Date(),
          diffGeneration: 1,
          diffQueuedAt: opts.queuedAt ?? new Date(),
          diffRequeues: opts.requeues ?? 0,
        })
        .returning({ id: screenshots.id });
      steps.push(s!.id);
    }
    const seeded = (await loadRollupInputs(db, [runId])).get(runId)!;
    const counters = computeRunCounters(seeded, seeded.lifecycle);
    await db.update(testRuns).set(counters).where(eq(testRuns.id, runId));
    return { runId, steps };
  }

  async function stored(runId: string) {
    const [row] = await db
      .select({
        status: testRuns.status,
        pendingSteps: testRuns.pendingSteps,
        failedSteps: testRuns.failedSteps,
      })
      .from(testRuns)
      .where(eq(testRuns.id, runId));
    return row!;
  }

  /** Stored = computed for the run as it stands, and that is `expected`. */
  async function expectCounters(runId: string, expected: RunCounters) {
    const input = (await loadRollupInputs(db, [runId])).get(runId)!;
    const computed = computeRunCounters(input, input.lifecycle);
    const { pendingSteps, failedSteps } = await stored(runId);
    expect({ pendingSteps, failedSteps }).toEqual(computed);
    expect(computed).toEqual(expected);
  }

  const deps = (): HandlerDeps => ({ db, storage, redis });

  it("a diff commit that turns a step unresolved, then a re-diff that passes it", async () => {
    const { runId, steps } = await seedRun("running", ["passed", null]);
    await expectCounters(runId, { pendingSteps: 0, failedSteps: 0 });

    const job = { runId, projectId, screenshotId: steps[1]!, generation: 1 };
    const committed = await commitStep(
      deps(),
      job,
      result(steps[1]!, "unresolved"),
      logger,
    );
    expect(committed.kind).toBe("committed");
    expect((await stored(runId)).status).toBe("unresolved");
    await expectCounters(runId, { pendingSteps: 1, failedSteps: 0 });

    await commitStep(deps(), job, result(steps[1]!, "passed"), logger);
    expect((await stored(runId)).status).toBe("passed");
    await expectCounters(runId, { pendingSteps: 0, failedSteps: 0 });
  });

  /** A fake diff queue on which every job is lost. */
  const lostJobs = (): ReconcileQueue =>
    ({
      getJob: vi.fn(async () => undefined),
      add: vi.fn(async () => undefined),
    }) as unknown as ReconcileQueue;

  const LONG_AGO = new Date("2000-01-01T00:00:00Z");
  const minutesAfter = (m: number) => new Date(LONG_AGO.getTime() + m * 60_000);

  it("a step's final failure (the reconciler giving up on it): pending and failed", async () => {
    // The undiffed step was re-queued three times and its job is lost again.
    const { runId } = await seedRun("running", ["unresolved", null], {
      queuedAt: LONG_AGO,
      requeues: 3,
    });
    await expectCounters(runId, { pendingSteps: 0, failedSteps: 0 });

    const out = await reconcileStuckSteps({
      db,
      queue: lostJobs(),
      redis,
      logger,
      registry: new Registry(),
      now: () => minutesAfter(11),
    });
    expect(out.failed).toBeGreaterThanOrEqual(1);

    // Failed with `timeout` through `markStepDiffFailed`: an unresolved,
    // failed step, so the run is reviewable again.
    expect((await stored(runId)).status).toBe("unresolved");
    await expectCounters(runId, { pendingSteps: 2, failedSteps: 1 });
  });

  it("an old whole-run job's final failure aborts the run: the counters go to 0", async () => {
    const { runId } = await seedRun("unresolved", ["unresolved", "new"]);
    await expectCounters(runId, { pendingSteps: 2, failedSteps: 0 });

    // No queue to split the job into: its last attempt aborts the run.
    await expect(
      handleDiffJob({ runId, projectId } as DiffJob, logger, deps(), {
        finalAttempt: true,
      }),
    ).rejects.toThrow(/diff_queue_missing/);

    expect((await stored(runId)).status).toBe("aborted");
    await expectCounters(runId, { pendingSteps: 0, failedSteps: 0 });
  });

  it("the reconciler's empty-run rule leaves a step-less run's counters at 0", async () => {
    const { runId } = await seedRun("running", [], { updatedAt: LONG_AGO });
    await expectCounters(runId, { pendingSteps: 0, failedSteps: 0 });

    const out = await reconcileStuckSteps({
      db,
      queue: lostJobs(),
      redis,
      logger,
      registry: new Registry(),
      now: () => minutesAfter(10),
    });
    expect(out.emptied).toBeGreaterThanOrEqual(1);
    expect((await stored(runId)).status).toBe("empty");
    await expectCounters(runId, { pendingSteps: 0, failedSteps: 0 });
  });
});
