import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import {
  diffRegions,
  eq,
  projects,
  screenshots,
  sql,
  testRuns,
  testVariations,
  type DB,
} from "@furan/db";

import type { Measurement } from "../budgets.js";
import { mintJwt, trpc, type TrpcResult } from "../clients/http.js";
import { readHistogram } from "../clients/metrics.js";
import {
  complete,
  createBuild,
  createRun,
  seedPat,
  uploadPng,
} from "../clients/sdk.js";
import { InterruptedError, describeError } from "../errors.js";
import {
  changeRect,
  generatePng,
  pipelineStep,
  type ImageChange,
  type ImageKind,
  type PipelineSet,
  type Seeded,
  type Shape,
} from "../seed/index.js";
import type { Stack } from "../stack/api.js";
import { WORKER_CONCURRENCY } from "../stack/constants.js";
import { percentile } from "../stats.js";

import {
  amplification,
  changeMix,
  excessEvents,
  latencySamples,
  formatSequence,
  formatSteps,
  meanJobSeconds,
  mixCounts,
  mixSeed,
  overlappingUploads,
  pairedSteps,
  raceLosses,
  raceSchedule,
  ratePerSec,
  singleStepChanges,
  statusSequence,
  stepDifferences,
  throughputRatio,
  type RegionRow,
  type RunSnapshot,
  type Span,
  type StepRow,
} from "./pipeline-math.js";
import {
  POLL_MS,
  RunWatcher,
  STEP_TIMEOUT_MS,
  openQueueProbe,
  subscribeProjectEvents,
  subscribeRunStatuses,
  type QueueProbe,
  type StepTiming,
} from "./pipeline-probes.js";

export {
  amplification,
  changeMix,
  excessEvents,
  findDuplicates,
  formatSequence,
  formatSteps,
  latencySamples,
  meanJobSeconds,
  mixCounts,
  mixSeed,
  overlappingUploads,
  pairedSteps,
  raceLosses,
  raceSchedule,
  ratePerSec,
  runCompletedStatus,
  SINGLE_STEP_RUNS,
  singleStepChanges,
  statusSequence,
  stepDifferences,
  throughputRatio,
} from "./pipeline-math.js";

/**
 * The pipeline suite (spec §5.2): P1–P6, measured by driving the real SDK
 * upload route and the real diff worker of the in-process stack.
 *
 * Order: the 50-step run (P1, P2, P6), the 500-step run (P1, P2, P3), the
 * throughput runs (P4), then the race (P5), each starting on an idle queue.
 * Every pipeline run is a new run in a new batch on `main`, uploading
 * `generatePng` images under `pipelineStep`'s identities, so it diffs against
 * its set's seeded baselines. A phase that fails marks only its own budgets
 * `error`; the others are still measured.
 */

/** How long the suite waits for the diff queue to empty (or a run to end). */
const DRAIN_TIMEOUT_MS = 30 * 60_000;
/** After dropping waiting jobs, how long the active ones may take. */
const ACTIVE_TIMEOUT_MS = 5 * 60_000;
/** Pub/sub delivery after the last job ended, before events are counted. */
const EVENT_GRACE_MS = 250;
/** P4: uploads in flight at once. */
const UPLOAD_CONCURRENCY = 8;
/** P5's ignore region reaches this far past the change it covers. */
const IGNORE_PADDING_PX = 2;
const CHECKPOINTS_METRIC = "furan_diff_job_checkpoints";
const DURATION_METRIC = "furan_diff_job_duration_seconds";
const IDS = ["P1", "P2", "P3", "P4", "P5", "P6"] as const;

interface Driver {
  stack: Stack;
  projectId: string;
  /** The SDK's personal access token (a member of the project). */
  pat: string;
  /** A reviewer's minted JWT (P5's review mutations). */
  reviewerToken: string;
  queue: QueueProbe;
  /**
   * Set once the queue would not empty even with its waiting jobs dropped:
   * every later phase fails at once instead of waiting again.
   */
  stuck?: string;
  /** Throws once the harness has begun tearing down. */
  alive: () => void;
  close: () => Promise<void>;
}

interface PlannedStep {
  name: string;
  viewport: string;
  browser: string;
  kind: ImageKind;
  seed: number;
  change: ImageChange;
  png: Buffer;
}

/** One measured run of a set: P1's diffs, P2's latencies, P3's end, P6's events. */
interface MeasuredRun {
  set: PipelineSet;
  steps: number;
  /**
   * Change in `furan_diff_job_checkpoints` sum over the run: 1 per committed
   * step job, 0 per stale one.
   */
  diffs: number;
  latency: { samples: number[]; capped: number };
  /** Last upload response to the final status; null if it never came. */
  finalMs: number | null;
  /** Status changes seen by the 100 ms poll. */
  polledChanges: number;
  /**
   * The status sequence inferred from the event stream (only when
   * subscribed): upload responses (`running`) merged with each status the
   * worker announced in a `run.completed`, one per status change (ruling
   * R24; `run.checkpoint_diffed` names no run status and is ignored).
   */
  inferred: string[];
  /** `testRun_updated` events for the run (only when subscribed). */
  updatedEvents: number;
  /** The queue had to be cut short, so `diffs` is a lower bound. */
  cutShort: boolean;
}

export async function runPipelineSuite(
  stack: Stack,
  seeded: Seeded,
  shape: Shape,
): Promise<Measurement[]> {
  const d = await openDriver(stack, seeded);
  const out = new Map<string, Measurement>();
  const failed = (ids: readonly string[], error: unknown): void => {
    if (error instanceof InterruptedError || stack.teardown.closing) {
      throw error;
    }
    for (const id of ids) {
      out.set(id, { id, value: null, error: describeError(error) });
    }
  };
  try {
    const runs: MeasuredRun[] = [];
    for (const [set, events] of [
      ["pipeline-50", true],
      ["pipeline-500", false],
    ] as const) {
      try {
        runs.push(await measuredRun(d, set, shape, events));
      } catch (error) {
        failed(
          [set === "pipeline-50" ? "P6" : "P3", "P1", "P2"],
          error instanceof InterruptedError
            ? error
            : new Error(`${set} run: ${describeError(error)}`),
        );
      }
    }
    // Only what the completed runs support: P1 and P2 need both.
    for (const m of fromMeasuredRuns(runs)) out.set(m.id, m);

    try {
      out.set("P4", await measureThroughput(d, shape));
    } catch (error) {
      failed(["P4"], error);
    }
    try {
      out.set("P5", await measureRace(d, seeded, shape));
    } catch (error) {
      failed(["P5"], error);
    }
  } finally {
    await d.close();
  }
  return IDS.map(
    (id) => out.get(id) ?? { id, value: null, error: "not measured" },
  );
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

async function openDriver(stack: Stack, seeded: Seeded): Promise<Driver> {
  const reviewer = seeded.reviewers[0];
  const sdkUser = seeded.reviewers[seeded.reviewers.length - 1];
  if (reviewer === undefined || sdkUser === undefined) {
    throw new Error("the seed has no reviewers");
  }
  const alive = (): void => {
    if (stack.teardown.closing) throw new InterruptedError();
  };
  const pat = await seedPat(stack.db, sdkUser.id);
  const queue = openQueueProbe(alive);
  // Also on the teardown, so an interrupt mid-suite closes it.
  stack.teardown.add("close the pipeline suite's queue probe", queue.close);
  return {
    stack,
    projectId: seeded.projectId,
    pat,
    reviewerToken: mintJwt(stack.app, { id: reviewer.id, role: "editor" }),
    queue,
    alive,
    close: queue.close,
  };
}

/**
 * Waits for the diff queue to empty. If it does not within `timeoutMs`, drops
 * the waiting jobs so the next phase starts on an idle queue, and reports that
 * it cut the queue short.
 */
async function drain(
  d: Driver,
  timeoutMs = DRAIN_TIMEOUT_MS,
): Promise<{ cutShort: boolean }> {
  if (d.stuck !== undefined) throw new Error(d.stuck);
  if (await d.queue.waitIdle(timeoutMs)) return { cutShort: false };
  await d.queue.dropWaiting();
  if (await d.queue.waitIdle(ACTIVE_TIMEOUT_MS)) return { cutShort: true };
  d.stuck = `the diff queue did not empty within ${DRAIN_TIMEOUT_MS / 60_000} min, even with its waiting jobs dropped`;
  throw new Error(d.stuck);
}

/** Like `drain`, but a queue that does not empty in time is an error. */
async function drainFully(d: Driver): Promise<void> {
  if (d.stuck !== undefined) throw new Error(d.stuck);
  if (!(await d.queue.waitIdle(DRAIN_TIMEOUT_MS))) {
    throw new Error(
      `the diff queue did not empty within ${DRAIN_TIMEOUT_MS / 60_000} min`,
    );
  }
}

async function checkpointDiffs(d: Driver): Promise<number> {
  return (await readHistogram(d.stack.registries.worker, CHECKPOINTS_METRIC))
    .sum;
}

/** A new batch and run on `main`, as the SDK opens them. */
async function newRun(
  d: Driver,
  name: string,
  buildId?: string,
): Promise<{ runId: string; status: string }> {
  const batch =
    buildId ??
    (
      await createBuild(d.stack.apiUrl, d.pat, d.projectId, {
        branchName: "main",
        name,
      })
    ).id;
  return createRun(d.stack.apiUrl, d.pat, {
    projectId: d.projectId,
    buildId: batch,
    name,
    branchName: "main",
  });
}

/** The images of a run's steps, drawn before the run starts uploading. */
async function planSteps(
  set: PipelineSet,
  changes: readonly ImageChange[],
): Promise<PlannedStep[]> {
  const planned: PlannedStep[] = [];
  for (const [i, change] of changes.entries()) {
    const step = pipelineStep(set, i);
    planned.push({
      ...step,
      change,
      png: await generatePng(step.kind, step.seed, change),
    });
  }
  return planned;
}

function upload(
  d: Driver,
  runId: string,
  step: PlannedStep,
): Promise<{ screenshotId: string }> {
  d.alive();
  return uploadPng(d.stack.apiUrl, d.pat, runId, {
    name: step.name,
    viewport: step.viewport,
    browser: step.browser,
    png: step.png,
  });
}

/** Runs `fn` on every item, at most `limit` at once (p-limit, inline). */
async function forEachLimit<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  let failed = false;
  const lane = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const item = items[next] as T;
      next += 1;
      try {
        await fn(item);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, lane),
  );
}

// ---------------------------------------------------------------------------
// P1, P2, P3, P6: the 50-step and 500-step runs
// ---------------------------------------------------------------------------

/**
 * Uploads the set's steps one at a time, in order (as the SDK sends them),
 * on an idle queue, then closes the run, and waits for its final status and
 * for the queue to empty.
 */
async function measuredRun(
  d: Driver,
  set: PipelineSet,
  shape: Shape,
  subscribe: boolean,
): Promise<MeasuredRun> {
  const plan = await planSteps(
    set,
    changeMix(shape.pipelineSets[set], mixSeed(set)),
  );
  await drain(d);
  const before = await checkpointDiffs(d);
  const events = subscribe
    ? await subscribeProjectEvents(d.stack.redis, d.projectId)
    : undefined;
  if (events !== undefined) {
    d.stack.teardown.add("close the pipeline suite's subscriber", events.close);
  }
  let statuses: Awaited<ReturnType<typeof subscribeRunStatuses>> | undefined;
  try {
    const run = await newRun(d, `scale-${set}`);
    // Subscribed before the first upload, so no status the worker announces
    // is missed.
    statuses = subscribe
      ? await subscribeRunStatuses(d.stack.redis, run.runId)
      : undefined;
    if (statuses !== undefined) {
      d.stack.teardown.add(
        "close the pipeline suite's run subscriber",
        statuses.close,
      );
    }
    const watcher = new RunWatcher(d.stack.db, run.runId, run.status, d.alive);
    // Each upload answers after its transaction made the run `running`.
    const uploadsSeen: { at: number; status: string }[] = [];
    try {
      let lastUploadAt = performance.now();
      for (const step of plan) {
        const { screenshotId } = await upload(d, run.runId, step);
        lastUploadAt = performance.now();
        watcher.uploaded(screenshotId, lastUploadAt);
        uploadsSeen.push({ at: lastUploadAt, status: "running" });
      }
      watcher.armFinal(lastUploadAt);
      // One budget for the final status and the queue to empty after it.
      const endBy = lastUploadAt + DRAIN_TIMEOUT_MS;
      const left = (): number => Math.max(0, endBy - performance.now());
      await complete(d.stack.apiUrl, d.pat, run.runId);
      const final = await watcher.finalStatus(left());
      await watcher.settled();
      const { cutShort } = await drain(d, left());
      await sleep(EVENT_GRACE_MS);
      const after = await checkpointDiffs(d);
      return {
        set,
        steps: plan.length,
        diffs: after - before,
        latency: latencySamples(watcher.timings(), STEP_TIMEOUT_MS),
        finalMs: final === null ? null : final.at - lastUploadAt,
        polledChanges: watcher.changes.length,
        inferred:
          statuses === undefined
            ? []
            : statusSequence(run.status, [...uploadsSeen, ...statuses.seen()]),
        updatedEvents: events?.count("testRun_updated", run.runId) ?? 0,
        cutShort,
      };
    } finally {
      await watcher.stop();
    }
  } finally {
    await statuses?.close();
    await events?.close();
  }
}

const label = (run: MeasuredRun): string => `${run.set} (${run.steps} steps)`;

/**
 * P6's status changes (ruling R24): the poll misses a status shorter than
 * its interval, so the larger of the polled and the event-inferred count.
 */
const statusChanges = (run: MeasuredRun): number =>
  Math.max(run.polledChanges, run.inferred.length - 1);
const round = (n: number, places = 2): number =>
  Math.round(n * 10 ** places) / 10 ** places;

/** P1, P2, P3 and P6 from whichever measured runs completed. */
function fromMeasuredRuns(runs: readonly MeasuredRun[]): Measurement[] {
  const out: Measurement[] = [];
  const small = runs.find((r) => r.set === "pipeline-50");
  const big = runs.find((r) => r.set === "pipeline-500");
  if (small !== undefined && big !== undefined) {
    const cut = runs.some((r) => r.cutShort)
      ? "; lower bound: the queue was cut short"
      : "";
    out.push({
      id: "P1",
      value: Math.max(...runs.map((r) => amplification(r.diffs, r.steps))),
      samples: runs.length,
      note: `${runs
        .map(
          (r) =>
            `${label(r)}: ${r.diffs} checkpoint diffs, ${round(amplification(r.diffs, r.steps))} per step`,
        )
        .join("; ")}${cut}`,
    });

    const samples = runs.flatMap((r) => r.latency.samples);
    const capped = runs.reduce((n, r) => n + r.latency.capped, 0);
    out.push({
      id: "P2",
      value: percentile(
        [...samples].sort((a, b) => a - b),
        95,
      ),
      samples: samples.length,
      note: `p95 over ${samples.length} steps of ${runs.map(label).join(" and ")}${
        capped > 0
          ? `; ${capped} had no result within ${STEP_TIMEOUT_MS / 1000} s (counted at ${STEP_TIMEOUT_MS / 1000} s)`
          : ""
      }`,
    });
  }
  if (big !== undefined) {
    out.push(
      big.finalMs === null
        ? {
            id: "P3",
            value: DRAIN_TIMEOUT_MS,
            note: `${label(big)}: no final status within ${DRAIN_TIMEOUT_MS / 60_000} min (lower bound)`,
          }
        : { id: "P3", value: round(big.finalMs), note: label(big) },
    );
  }
  if (small !== undefined) {
    out.push({
      id: "P6",
      value: excessEvents(small.updatedEvents, statusChanges(small)),
      note: `${label(small)}: ${small.updatedEvents} testRun_updated events, ${statusChanges(small)} status changes (the larger of ${small.polledChanges} polled every ${POLL_MS} ms and ${small.inferred.length - 1} inferred from the events: ${formatSequence(small.inferred)})`,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// P4: throughput
// ---------------------------------------------------------------------------

/** Screens, pages and changes of a set's planned steps, for a note. */
function composition(set: PipelineSet, steps: readonly PlannedStep[]): string {
  const c = mixCounts(
    set,
    steps.map((s) => s.change),
  );
  return `${c.screen} screens / ${c.page} pages; ${c.none} none / ${c.small} small / ${c.large} large`;
}

/**
 * The worker's ideal (rulings R19, R19a): `SINGLE_STEP_RUNS[shape]` fresh
 * one-step runs (20 on large, 10 on smoke), one at a time on an idle queue
 * (each waits for its job to finish), whose mix is exactly `pipeline-200`'s. Each job diffs exactly one checkpoint, so
 * the mean of `furan_diff_job_duration_seconds{outcome="completed"}` over
 * them is the time per step, and the ideal is 4 (the concurrency) over it.
 *
 * Then `pipeline-200` uploaded eight at a time, and the rate at which its
 * results land from the first to the last, as a share of that ideal.
 */
async function measureThroughput(
  d: Driver,
  shape: Shape,
): Promise<Measurement> {
  const set = "pipeline-200";
  const worker = d.stack.registries.worker;
  const singles = await planSteps(set, singleStepChanges(shape));
  const plan = await planSteps(
    set,
    changeMix(shape.pipelineSets[set], mixSeed(set)),
  );

  await drain(d);
  const durationsBefore = await readHistogram(worker, DURATION_METRIC, {
    outcome: "completed",
  });
  const diffsBefore = await checkpointDiffs(d);
  const batch = await createBuild(d.stack.apiUrl, d.pat, d.projectId, {
    branchName: "main",
    name: "scale-single-steps",
  });
  for (const [i, step] of singles.entries()) {
    const run = await newRun(d, `scale-single-step-${i + 1}`, batch.id);
    await upload(d, run.runId, step);
    await complete(d.stack.apiUrl, d.pat, run.runId);
    if (!(await d.queue.waitIdle(STEP_TIMEOUT_MS))) {
      throw new Error(
        `single step ${i + 1} was not diffed within ${STEP_TIMEOUT_MS / 1000} s`,
      );
    }
  }
  const durationsAfter = await readHistogram(worker, DURATION_METRIC, {
    outcome: "completed",
  });
  const jobs = durationsAfter.count - durationsBefore.count;
  const diffs = (await checkpointDiffs(d)) - diffsBefore;
  if (jobs !== singles.length || diffs !== singles.length) {
    throw new Error(
      `${singles.length} one-step runs gave ${jobs} completed diff jobs over ${diffs} checkpoints, expected ${singles.length} of each`,
    );
  }
  const stepSec = meanJobSeconds(durationsBefore, durationsAfter);

  await drain(d);
  const run = await newRun(d, `scale-${set}`);
  const watcher = new RunWatcher(d.stack.db, run.runId, run.status, d.alive);
  let timings: StepTiming[];
  try {
    await forEachLimit(plan, UPLOAD_CONCURRENCY, async (step) => {
      const { screenshotId } = await upload(d, run.runId, step);
      watcher.uploaded(screenshotId, performance.now());
    });
    await complete(d.stack.apiUrl, d.pat, run.runId);
    await watcher.settled();
    timings = watcher.timings();
  } finally {
    await watcher.stop();
  }

  // A step with no result counts as landing at its timeout, which makes the
  // rate an upper bound (the note says so).
  const late = timings.filter((t) => t.resultAt === undefined).length;
  const observed = ratePerSec(
    timings.map((t) => t.resultAt ?? t.uploadedAt + STEP_TIMEOUT_MS),
    POLL_MS,
  );
  return {
    id: "P4",
    value: throughputRatio(observed, stepSec, WORKER_CONCURRENCY),
    samples: timings.length,
    note: `ideal ${round(WORKER_CONCURRENCY / stepSec)} steps/s = ${WORKER_CONCURRENCY} / ${round(stepSec * 1000)} ms, the mean completed job of ${singles.length} one-step runs (${composition(set, singles)}); observed ${round(observed)} results/s, (n − 1) results over the first-to-last span, of ${set} (${plan.length} steps, ${composition(set, plan)}, ${UPLOAD_CONCURRENCY} uploads at once)${
      late > 0
        ? `; ${late} had no result within ${STEP_TIMEOUT_MS / 1000} s (counted at ${STEP_TIMEOUT_MS / 1000} s: an upper bound)`
        : ""
    }`,
  };
}

// ---------------------------------------------------------------------------
// P5: the race
// ---------------------------------------------------------------------------

function trpcFailure(path: string, res: TrpcResult): Error {
  const message = (res.error as { message?: unknown } | undefined)?.message;
  return new Error(
    `${path} answered ${res.status}${typeof message === "string" ? `: ${message.slice(0, 200)}` : ""}`,
  );
}

async function runStatus(db: DB, runId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ status: testRuns.status })
    .from(testRuns)
    .where(eq(testRuns.id, runId));
  return row?.status;
}

/** The run's steps and regions, as the race checks compare them. */
async function snapshotRun(db: DB, runId: string): Promise<RunSnapshot> {
  const steps: StepRow[] = (
    await db
      .select({
        id: screenshots.id,
        verdict: screenshots.verdict,
        diffFailedAt: screenshots.diffFailedAt,
      })
      .from(screenshots)
      .where(eq(screenshots.runId, runId))
  ).map((s) => ({
    id: s.id,
    verdict: s.verdict,
    failed: s.diffFailedAt !== null,
  }));
  const rows = await db
    .select({
      screenshotId: diffRegions.screenshotId,
      severity: diffRegions.severity,
      bbox: sql<string>`${diffRegions.bbox}::text`,
      source: diffRegions.source,
    })
    .from(diffRegions)
    .where(eq(diffRegions.runId, runId));
  const regions: RegionRow[] = rows.map((r) => ({
    ...r,
    screenshotId: r.screenshotId ?? "",
  }));
  return { steps, regions };
}

/** The threshold the worker diffs the run with: its override, else the project's. */
async function effectiveThreshold(db: DB, runId: string): Promise<number> {
  const [row] = await db
    .select({
      threshold: sql<number>`coalesce(${testRuns.diffThresholdOverride}, ${projects.diffThreshold})`,
    })
    .from(testRuns)
    .innerJoin(projects, eq(projects.id, testRuns.projectId))
    .where(eq(testRuns.id, runId));
  if (row === undefined) throw new Error(`run ${runId} is gone`);
  return Number(row.threshold);
}

async function verdictOf(
  db: DB,
  screenshotId: string,
): Promise<string | null | undefined> {
  const [row] = await db
    .select({ verdict: screenshots.verdict })
    .from(screenshots)
    .where(eq(screenshots.id, screenshotId));
  return row?.verdict;
}

/**
 * Approves one step: waits for its verdict (only a diffed step can be
 * approved), then approves as soon as the run is reviewable (a decision is
 * refused while the run is `running` or any of its steps is undiffed),
 * retrying; each wait is up to `STEP_TIMEOUT_MS`. Returns the action id, for
 * the undo.
 */
async function approveWhenReviewable(
  d: Driver,
  runId: string,
  checkpointId: string,
): Promise<string> {
  const reviewer = trpc(d.stack.apiUrl, d.reviewerToken);
  const diffedBy = performance.now() + STEP_TIMEOUT_MS;
  while ((await verdictOf(d.stack.db, checkpointId)) == null) {
    d.alive();
    if (performance.now() >= diffedBy) {
      throw new Error(
        `the step to approve had no verdict within ${STEP_TIMEOUT_MS / 1000} s`,
      );
    }
    await sleep(POLL_MS);
  }
  const deadline = performance.now() + STEP_TIMEOUT_MS;
  let last = "the run stayed running";
  while (performance.now() < deadline) {
    d.alive();
    if ((await runStatus(d.stack.db, runId)) !== "running") {
      const actionId = randomUUID();
      const res = await reviewer.mutation("review.approve", {
        runId,
        actionId,
        checkpointIds: [checkpointId],
      });
      if (res.status !== 200) {
        last = trpcFailure("review.approve", res).message;
      } else if (
        (res.data as { decided?: { checkpointId: string }[] }).decided?.some(
          (x) => x.checkpointId === checkpointId,
        )
      ) {
        return actionId;
      } else {
        last = "review.approve decided nothing";
      }
    }
    await sleep(POLL_MS);
  }
  throw new Error(
    `the step to approve was not approvable within ${STEP_TIMEOUT_MS / 1000} s (${last})`,
  );
}

/**
 * The race of spec §5.2 on a fresh `pipeline-50` run, uploaded one step at a
 * time (ruling R20b):
 * - after `ignoreAfter`, an ignore region is saved on step 3 over its change,
 *   as a branch concurrent with the uploads, which go on at once;
 * - after `approveAfter`, the uploads pause until step 5 is diffed and its
 *   approve lands (a decision needs a reviewable run); then the uploads
 *   resume at once and the undo runs as a branch concurrent with them, so its
 *   re-diff of step 5 overlaps the later uploads' jobs.
 * Both branches are awaited after the last upload; the note names the
 * uploads each branch overlapped. Steps 3 and 5 carry a small change, so both
 * actions have something to act on.
 *
 * Once the queue is empty: duplicate regions, steps with no verdict,
 * unresolved steps with no region and steps whose diff failed; then a quiet
 * re-diff (`runs.setDiffThresholdOverride` to the threshold already in force,
 * which queues one job per step whose verdict is not `new`) must leave every
 * step's verdict and regions as they were. It must also have run: the
 * checkpoint diffs it adds are at least the steps it queued.
 *
 * Step 3's variation gets its ignore regions back afterwards, so the seed is
 * the same for the next run (`--reuse`).
 */
async function measureRace(
  d: Driver,
  seeded: Seeded,
  shape: Shape,
): Promise<Measurement> {
  const set = "pipeline-50";
  const n = shape.pipelineSets[set];
  const at = raceSchedule(n);
  const changes = changeMix(n, mixSeed(set));
  changes[at.ignoreStep - 1] = "small";
  changes[at.approveStep - 1] = "small";
  const plan = await planSteps(set, changes);

  const ignored = plan[at.ignoreStep - 1]!;
  const rect = changeRect(ignored.kind, ignored.seed, ignored.change)!;
  const x = Math.max(0, rect.x - IGNORE_PADDING_PX);
  const y = Math.max(0, rect.y - IGNORE_PADDING_PX);
  const ignoreArea = {
    x,
    y,
    width: rect.x + rect.width + IGNORE_PADDING_PX - x,
    height: rect.y + rect.height + IGNORE_PADDING_PX - y,
    viewport: ignored.viewport,
    kind: "ignore" as const,
  };
  const variationId = seeded.pipeline[set].variationIds[at.ignoreStep - 1];
  if (variationId === undefined) throw new Error(`${set} has no step 3`);
  const reviewer = trpc(d.stack.apiUrl, d.reviewerToken);

  await drain(d);
  const [original] = await d.stack.db
    .select({ ignoreRegions: testVariations.ignoreRegions })
    .from(testVariations)
    .where(eq(testVariations.id, variationId));
  try {
    const run = await newRun(d, `scale-${set}-race`);
    const ids: string[] = [];
    const sideErrors: unknown[] = [];
    const side: Promise<void>[] = [];
    // Started now, awaited at the end; a failure is kept, never unhandled.
    const inBackground = (task: Promise<void>): void => {
      side.push(task.catch((error: unknown) => void sideErrors.push(error)));
    };
    // When each upload and each branch was in flight, for the note.
    const uploads: Span[] = [];
    const ignoreSpan: Span = { start: Infinity, end: Infinity };
    const undoSpan: Span = { start: Infinity, end: Infinity };
    let undone = "";

    try {
      for (const [i, step] of plan.entries()) {
        const start = performance.now();
        ids.push((await upload(d, run.runId, step)).screenshotId);
        uploads.push({ start, end: performance.now() });
        if (i + 1 === at.ignoreAfter) {
          ignoreSpan.start = performance.now();
          inBackground(
            reviewer
              .mutation("runs.setIgnoreAreas", {
                runId: run.runId,
                scope: "variation",
                checkpointId: ids[at.ignoreStep - 1],
                ignoreAreas: [ignoreArea],
              })
              .then((res) => {
                if (res.status !== 200) {
                  throw trpcFailure("runs.setIgnoreAreas", res);
                }
              })
              .finally(() => {
                ignoreSpan.end = performance.now();
              }),
          );
        }
        if (i + 1 === at.approveAfter) {
          // The uploads wait here for the approve only, never for the undo.
          const actionId = await approveWhenReviewable(
            d,
            run.runId,
            ids[at.approveStep - 1]!,
          );
          undoSpan.start = performance.now();
          inBackground(
            reviewer
              .mutation("review.revert", { actionId })
              .then((res) => {
                if (res.status !== 200) throw trpcFailure("review.revert", res);
                undone = ` (reverted ${(res.data as { reverted?: number }).reverted ?? "?"})`;
              })
              .finally(() => {
                undoSpan.end = performance.now();
              }),
          );
        }
      }
      await complete(d.stack.apiUrl, d.pat, run.runId);
    } finally {
      // Never leave a branch running behind a failed upload: the restore in
      // the outer `finally` must come after the ignore save. The branches
      // never reject (their failures are kept), so this is an allSettled.
      await Promise.all(side);
    }
    if (sideErrors.length > 0) throw sideErrors[0];

    await drainFully(d);
    const raced = await snapshotRun(d.stack.db, run.runId);
    const losses = raceLosses(raced.steps, raced.regions);

    const threshold = await effectiveThreshold(d.stack.db, run.runId);
    const diffsBefore = await checkpointDiffs(d);
    const rediff = await reviewer.mutation("runs.setDiffThresholdOverride", {
      runId: run.runId,
      threshold,
    });
    if (rediff.status !== 200) {
      throw trpcFailure("runs.setDiffThresholdOverride", rediff);
    }
    await drainFully(d);
    // The ground truth must not go vacuous: the re-diff has to have run, one
    // committed job per paired step.
    const paired = pairedSteps(raced.steps);
    const rediffed = (await checkpointDiffs(d)) - diffsBefore;
    if (paired === 0 || rediffed < paired) {
      throw new Error(
        `the ground-truth re-diff did not run: ${rediffed} checkpoint diffs for ${paired} paired steps (of ${raced.steps.length})`,
      );
    }
    const differences = stepDifferences(
      raced,
      await snapshotRun(d.stack.db, run.runId),
    );

    return {
      id: "P5",
      value:
        losses.duplicates +
        losses.nullVerdicts +
        losses.unresolvedWithoutRegion +
        losses.failedSteps +
        differences,
      samples: raced.steps.length,
      note: `${set} (${n} steps), ignore region on step ${at.ignoreStep} after step ${at.ignoreAfter}, uploads paused after step ${at.approveAfter} for the approve of step ${at.approveStep}; ignore save overlapped uploads ${formatSteps(overlappingUploads(uploads, ignoreSpan))}; undo${undone} overlapped uploads ${formatSteps(overlappingUploads(uploads, undoSpan))}: ${losses.duplicates} duplicate regions, ${losses.nullVerdicts} steps without a verdict, ${losses.unresolvedWithoutRegion} unresolved steps without a region, ${losses.failedSteps} steps whose diff failed, ${differences} steps changed by a quiet re-diff of ${paired} paired steps (${rediffed} checkpoint diffs)`,
    };
  } finally {
    await d.stack.db
      .update(testVariations)
      .set({ ignoreRegions: original?.ignoreRegions ?? null })
      .where(eq(testVariations.id, variationId));
  }
}
