import {
  and,
  autoRules,
  eq,
  inArray,
  isNull,
  markStepDiffFailed,
  ne,
  projects,
  recomputeRunStatus,
  screenshots,
  testRuns,
  testVariations,
  withProjectScope,
  type DB,
  type DiffErrorCode,
} from "@furan/db";
import type { DiffJob } from "@furan/queue";
import {
  compileRules,
  createDefaultRegistries,
  summarize as summarizeDecisions,
} from "@furan/rules-engine";
import type { AutoRule, CompiledRuleset } from "@furan/rules-engine";
import type { Storage } from "@furan/storage";
import type { Telemetry } from "@furan/telemetry";
import type { Redis } from "ioredis";
import { z } from "zod";

import { commitStep, persistRuleApplications } from "./commit-step.js";
import { classifyDiffError } from "./diff-error.js";
import type { DiffMetrics } from "./diff-metrics.js";
import { diffStep, type StepContext, type StepResult } from "./diff-step.js";
import { splitLegacyJob, type DiffJobQueue } from "./legacy-split.js";
import { publishProjectEvent, publishStepEvents } from "./step-events.js";

// Moved to diff-step.ts with the rest of the per-step diff; re-exported for
// existing importers.
export { inflateRegion } from "./diff-step.js";

type Logger = Telemetry["logger"];

export interface HandlerDeps {
  db: DB;
  storage: Storage;
  redis: Redis;
  /** Diff-pipeline metrics. Optional so existing tests that don't
   *  bootstrap a prom-client registry continue to work; the production
   *  worker passes a real instance from `createDiffMetrics`. */
  metrics?: DiffMetrics;
  /**
   * The queue this worker consumes (same name and prefix). Only an old
   * whole-run job uses it: `splitLegacyJob` adds that run's per-step jobs to
   * it. The worker runtime passes its own; a caller that only runs step jobs
   * (CLIs, tests) may omit it.
   */
  queue?: DiffJobQueue;
}

/** Where this call sits in the job's BullMQ retry budget. */
export interface DiffAttempt {
  /**
   * True when no retry follows if this attempt throws (`isFinalAttempt` from
   * `@furan/queue`). Only the final attempt writes a failure: it fails the
   * step (a step job) or marks the run `aborted` (an old whole-run job).
   */
  finalAttempt: boolean;
}

/**
 * One diff job (spec 2026-10-23 §3, §4).
 *
 * - A step job (`screenshotId` + `generation`) diffs that one step and commits
 *   it under the version guard (`handleStepJob`). A job whose version is no
 *   longer the step's is stale: it writes and publishes nothing and reports
 *   `{ checkpoints: 0, stale: true }`.
 * - An old whole-run job (no `screenshotId`), still queued from before the
 *   per-step worker, is split into one step job per step on `deps.queue`
 *   (`splitLegacyJob`). It diffs nothing, so it reports `{ checkpoints: 0 }`.
 *
 * A failure rethrows for BullMQ. A non-final attempt writes nothing, since a
 * retry follows. On the final attempt a step job fails ITS step alone (the step
 * becomes `unresolved` with a reason code, `failStep`; the run is never
 * aborted for it), unless the step's commit already landed. If a newer version
 * owns the step by then, the job is stale instead: it reports the stale
 * outcome and does not rethrow. Only an old whole-run job still marks the
 * whole run `aborted`.
 */
export async function handleDiffJob(
  data: DiffJob,
  logger: Logger,
  deps: HandlerDeps,
  // Callers that don't track retries (CLIs, tests) get the safe default: a
  // failure is terminal (the step is failed, or the run is marked `aborted`).
  attempt: DiffAttempt = { finalAttempt: true },
): Promise<DiffJobOutcome> {
  const { screenshotId, generation } = data;
  const stepJob: StepJob | undefined =
    screenshotId !== undefined && generation !== undefined
      ? { ...data, screenshotId, generation }
      : undefined;
  // Set by the step job the moment its commit (the step's verdict + the
  // recomputed totals and status) has landed.
  const progress: DiffProgress = { coreCommitted: false };
  try {
    if (!stepJob) {
      const jobs = await splitLegacyJob(deps, data, deps.queue);
      logger.info(
        { runId: data.runId, projectId: data.projectId, jobs },
        "diff_whole_run_job_split",
      );
      return { checkpoints: 0 };
    }
    return await handleStepJob(stepJob, logger, deps, progress);
  } catch (err) {
    // Always log the primary error first. BullMQ stashes it in the job's
    // failedReason but the worker's own structured log was previously
    // silent — a class of bug (e.g. odiff spawn-fail on a base-image
    // GLIBC mismatch) would aborted-bucket every run with zero clue in
    // dashboards or stdout. The secondary catches below only log when
    // their own write fails, so this is the only place the actual cause
    // surfaces in the worker log stream. The full error is logged here and
    // never stored: a failed step keeps only the `code`. A failure BullMQ
    // will retry is a warning; only the failure that ends the job is an error.
    const code = stepJob ? classifyDiffError(err) : undefined;
    const failure = {
      err,
      runId: data.runId,
      projectId: data.projectId,
      screenshotId: data.screenshotId,
      code,
      finalAttempt: attempt.finalAttempt,
      coreCommitted: progress.coreCommitted,
    };
    if (attempt.finalAttempt) logger.error(failure, "diff_job_failed");
    else logger.warn(failure, "diff_job_failed");
    // BullMQ retries a non-final attempt, so leave the step and the run as
    // they are and let the retry derive them. A failure written now would
    // stick even after the retry succeeds (`aborted` is a lifecycle state
    // `recomputeRunStatus` keeps). Rethrow so BullMQ schedules it.
    if (!attempt.finalAttempt) throw err;
    // Once the step's commit has landed, the step holds its verdict and the
    // run a valid derived status. A later failure must neither fail the step
    // nor replace that status. (Little after the commit can throw: the rule
    // audit trail and the events are best-effort.) It is logged above;
    // rethrow so the job still fails.
    if (progress.coreCommitted) throw err;
    // A step job never aborts its run. Its final failure fails its own step,
    // and the job still rethrows, so its outcome and the dead-letter signal
    // stay what they were. The exception: when a newer version has taken over
    // the step, that version's job decides it and this attempt's error no
    // longer matters. The job then ends stale, not failed (no rethrow, so no
    // dead letter). The error was already logged above.
    if (stepJob && code) {
      const stepOutcome = await failStep(deps, logger, stepJob, code);
      if (stepOutcome === "stale") return STALE_OUTCOME;
      throw err;
    }
    // Final attempt of an old whole-run job: best-effort terminal status write
    // so an aborted run does not hang in `running` indefinitely. Per spec §3.2
    // worker exceptions land as `aborted` (distinct from reviewer-rejected
    // `failed`). Wrap in its own try/catch so a status-write failure does not
    // mask the original error — the worker's error visibility is unchanged.
    // `abortedByDiff` marks it as the pipeline's abort, which a later step
    // job that leaves every step with a verdict heals (`healPipelineAbort`).
    // A run that is already `aborted` is left exactly as it is: an SDK or
    // capture abort is final, and re-flagging it as the pipeline's would let
    // a later diff heal it (a CI false pass); a pipeline abort already
    // carries the flag.
    let aborted = false;
    try {
      aborted = await withProjectScope(deps.db, data.projectId, async (tx) => {
        const written = await tx
          .update(testRuns)
          .set({ status: "aborted", abortedByDiff: true })
          .where(
            and(eq(testRuns.id, data.runId), ne(testRuns.status, "aborted")),
          )
          .returning({ id: testRuns.id });
        if (written.length === 0) return false;
        // A lifecycle write: the run's stored pending counters follow it
        // (spec 2026-10-27 §3.2), in this transaction, under the run lock
        // the UPDATE took. An aborted run is not reviewable, so they go to 0.
        await recomputeRunStatus(tx, data.runId);
        return true;
      });
    } catch (statusErr) {
      logger.error(
        { err: statusErr, runId: data.runId },
        "failed_to_write_aborted_status",
      );
    }
    // Only a write that moved the run to `aborted` is a status change to
    // announce: not a run that was already aborted, nor a failed write.
    if (aborted) {
      // Best-effort `run.completed` publish so the integrations subscriber
      // (GitHub commit-status, Slack notifier, outbound webhooks) reacts
      // to the aborted terminal state. Without this, the GitHub check would
      // stay stuck at `pending` and Slack would never notify. Wrap in its
      // own try/catch — a publish failure must not mask the worker's
      // original error, which remains the load-bearing signal.
      try {
        await deps.redis.publish(
          `run:${data.runId}:events`,
          JSON.stringify({
            type: "run.completed",
            runId: data.runId,
            projectId: data.projectId,
            status: "aborted",
          }),
        );
      } catch (publishErr) {
        logger.error(
          { err: publishErr, runId: data.runId },
          "failed_to_publish_aborted_run_completed",
        );
      }
      // Project channel mirror so the dashboard list pages refresh.
      await publishProjectEvent(deps.redis, logger, {
        projectId: data.projectId,
        runId: data.runId,
        event: "testRun_updated",
        data: { id: data.runId, status: "aborted" },
        logKey: "diff_worker_project_publish_failed",
      });
    }
    throw err;
  }
}

/**
 * A step job's final attempt failed before its commit landed: the step fails
 * alone, in a fresh transaction (`markStepDiffFailed` takes the run and step
 * locks itself). With the reason `code`, it becomes `unresolved`, its result
 * and regions are cleared and the run's totals and status are recomputed;
 * when it was the run's last step without a verdict, an abort the old
 * whole-run pipeline wrote heals first, as after a commit. A newer version of
 * the step (a re-diff queued while this job ran) owns it: nothing is written
 * or published.
 *
 * Best-effort: if the write itself fails (the database is down) it is logged
 * and the step keeps no verdict, for the reconciler to re-queue; the caller
 * rethrows the job's own error. When it lands, the step's events follow, as
 * for a committed step (`publishStepEvents`, with `failed: true`).
 *
 * Returns what became of the step: `"failed"` (it now carries the failure),
 * `"stale"` (a newer version owns it, or it or its run is gone: nothing was
 * written, and the caller ends the job stale) or `"unwritten"` (the write
 * itself failed; the step is as it was).
 */
async function failStep(
  deps: HandlerDeps,
  logger: Logger,
  job: StepJob,
  code: DiffErrorCode,
): Promise<"failed" | "stale" | "unwritten"> {
  let marked: Awaited<ReturnType<typeof markStepDiffFailed>>;
  try {
    marked = await withProjectScope(deps.db, job.projectId, (tx) =>
      markStepDiffFailed(tx, {
        runId: job.runId,
        stepId: job.screenshotId,
        generation: job.generation,
        code,
      }),
    );
  } catch (markErr) {
    logger.error(
      { err: markErr, runId: job.runId, screenshotId: job.screenshotId },
      "failed_to_mark_step_failed",
    );
    return "unwritten";
  }
  if (!marked.applied || !marked.rollup) {
    logStepStale(logger, job);
    return "stale";
  }
  // The failed step was the run's last one without a verdict, and the run
  // carried an abort the old whole-run pipeline wrote: it took its rollup.
  if (marked.healed) {
    logger.info({ runId: job.runId }, "diff_pipeline_abort_healed");
  }
  // The step's own event, and the run's status events when the failure moved
  // it. Best-effort (it never throws): the original error stays the signal.
  await publishStepEvents(deps.redis, {
    runId: job.runId,
    projectId: job.projectId,
    screenshotId: job.screenshotId,
    verdict: "unresolved",
    failed: true,
    rollup: marked.rollup,
    db: deps.db,
    logger,
  });
  return "failed";
}

/**
 * What a diff job that ran to the end reports to its caller (the worker
 * runtime records it as metrics). Callers that don't need it ignore it.
 */
export interface DiffJobOutcome {
  /**
   * Steps the job diffed and committed: 1 for a step job; 0 for a stale one,
   * and for a whole-run job (it only queues step jobs, which report their own).
   */
  checkpoints: number;
  /**
   * The job's version was no longer the step's (or the step or its run is
   * gone): a newer job owns the step, so nothing was written or published.
   */
  stale?: boolean;
}

const STALE_OUTCOME: DiffJobOutcome = { checkpoints: 0, stale: true };

/**
 * Logs that a step job's version is no longer the step's: a newer job owns it
 * and this one writes and publishes nothing. `currentGeneration`, when the
 * caller read it, is the version that does (null: the step or its run is gone).
 */
function logStepStale(
  logger: Logger,
  job: StepJob,
  currentGeneration?: number | null,
): void {
  logger.info(
    {
      runId: job.runId,
      screenshotId: job.screenshotId,
      generation: job.generation,
      ...(currentGeneration !== undefined ? { currentGeneration } : {}),
    },
    "diff_step_stale",
  );
}

/** What a step job has durably done so far; read by the failure path. */
export interface DiffProgress {
  /** True once the step's commit has landed (never set earlier). */
  coreCommitted: boolean;
}

/** A step job: one step at the version it was queued at. */
export type StepJob = DiffJob & { screenshotId: string; generation: number };

/**
 * The inputs a job's step diffs share (`StepContext`), read at the start of
 * each job: the steps' variation ignore regions, the run's temp regions, the
 * threshold, and the project's auto rules, fetched and compiled once per job
 * (spec 2026-10-23 §4).
 */
export async function loadStepContext(
  deps: HandlerDeps,
  logger: Logger,
  args: {
    project: StepContext["project"];
    run: StepContext["run"];
    /** The variations of the steps the job diffs. */
    variationIds: string[];
    parentPrBaseBranch?: string | null;
  },
): Promise<StepContext> {
  const { project, run } = args;

  // Per ADR-031: ignore regions are the checkpoint's VARIATION regions plus
  // the run's temp regions, both JSON arrays of {x,y,width,height,viewport?}.
  // The viewport tag is filtered against each candidate's viewport in
  // `diffStep`; legacy rows without `viewport` apply universally. Load every
  // candidate variation once (ignoreRegions is jsonb, already parsed by
  // Drizzle; parseIgnoreAreas handles both string and pre-parsed values).
  const variationRows = await deps.db
    .select({
      id: testVariations.id,
      ignoreRegions: testVariations.ignoreRegions,
    })
    .from(testVariations)
    .where(inArray(testVariations.id, [...new Set(args.variationIds)]));
  const variationIgnore = new Map(
    variationRows.map((v) => [v.id, parseIgnoreAreas(v.ignoreRegions) ?? []]),
  );
  const tempIgnoreAreas = parseIgnoreAreas(run.tempIgnoreAreas) ?? [];

  // Per-run override (set via the in-viewer sensitivity slider) wins over the
  // project default. Null/undefined means "inherit".
  const diffThreshold =
    run.diffThresholdOverride ?? project.diffThreshold ?? 0.001;

  // Auto Rules: fetch enabled rules once up front. Their distinct CSS selectors
  // drive per-checkpoint element-map resolution inside `diffStep` (the
  // candidate DOM is only in scope there), where each step evaluates its own
  // regions against the rules compiled here. Fail-open: a fetch error disables
  // rules for this run only.
  let projectRules: (typeof autoRules.$inferSelect)[] = [];
  let ruleSelectors: string[] = [];
  try {
    projectRules = await deps.db
      .select()
      .from(autoRules)
      .where(
        and(
          eq(autoRules.projectId, project.id),
          eq(autoRules.enabled, true),
          isNull(autoRules.deletedAt),
        ),
      );
    const selectorSet = new Set<string>();
    for (const r of projectRules) {
      const m = r.match as { type?: unknown; value?: unknown } | null;
      if (m && m.type === "selector" && typeof m.value === "string") {
        selectorSet.add(m.value);
      }
    }
    ruleSelectors = [...selectorSet];
  } catch (err) {
    logger.error(
      { err, runId: run.id, projectId: project.id },
      "auto-rule fetch failed; proceeding without rule decisions",
    );
    deps.metrics?.rulesEvaluationErrors.inc();
    projectRules = [];
    ruleSelectors = [];
  }

  let compiledRules: CompiledRuleset | null = null;
  if (projectRules.length > 0) {
    try {
      const { matchers, conditions } = createDefaultRegistries();
      compiledRules = compileRules(
        projectRules as AutoRule[],
        matchers,
        conditions,
      );
    } catch (err) {
      logger.error(
        { err, runId: run.id, projectId: project.id },
        "rules-engine evaluation failed; proceeding without rule decisions",
      );
      deps.metrics?.rulesEvaluationErrors.inc();
    }
  }

  return {
    deps,
    logger,
    project,
    run,
    diffThreshold,
    tempIgnoreAreas,
    variationIgnore,
    compiledRules,
    ruleSelectors,
    // Per-job cache shared across steps (see `StepContext`).
    elementMapCache: new Map(),
    parentPrBaseBranch: args.parentPrBaseBranch ?? null,
  };
}

/**
 * One step's diff job (spec 2026-10-23 §4):
 *  1. a cheap stale check: the step or its run is gone, or the step's version
 *     is no longer the job's → stale, nothing written or published;
 *  2. the step's `StepContext` (its variation's regions, the run's temp
 *     regions, the threshold, the project's rules compiled for this job);
 *  3. the diff, outside any transaction (`diffStep`);
 *  4. the commit under run → step locks with the version re-checked
 *     (`commitStep`); a newer version that landed meanwhile makes it stale;
 *  5. after the commit: the step's rule metrics, its rule applications
 *     (fail-open), then the step's events (`publishStepEvents`: the run's
 *     status events only if this commit moved its status).
 */
export async function handleStepJob(
  job: StepJob,
  logger: Logger,
  deps: HandlerDeps,
  progress: DiffProgress = { coreCommitted: false },
): Promise<DiffJobOutcome> {
  const t0 = Date.now();

  // 1. Cheap stale check: a newer job is already queued for this step.
  const [step] = await deps.db
    .select()
    .from(screenshots)
    .where(
      and(
        eq(screenshots.id, job.screenshotId),
        eq(screenshots.runId, job.runId),
      ),
    )
    .limit(1);
  const run = step
    ? await deps.db.query.testRuns.findFirst({
        where: eq(testRuns.id, job.runId),
      })
    : undefined;
  if (!step || !run || step.diffGeneration !== job.generation) {
    logStepStale(logger, job, step?.diffGeneration ?? null);
    return STALE_OUTCOME;
  }

  const project = await deps.db.query.projects.findFirst({
    where: eq(projects.id, job.projectId),
  });
  if (!project) throw new Error(`project_not_found:${job.projectId}`);
  if (!run.branchName) {
    throw new Error(`run_missing_branch_name:${job.runId}`);
  }

  // 2–3. The diff, with this job's context and rules.
  const ctx = await loadStepContext(deps, logger, {
    project,
    run,
    variationIds: [step.testVariationId],
    parentPrBaseBranch: job.parentPrBaseBranch ?? null,
  });
  const result = await diffStep(ctx, step);

  // 4. The commit, under the version guard.
  const commit = await commitStep(deps, job, result, logger);
  if (commit.kind === "stale") {
    logStepStale(logger, job);
    return STALE_OUTCOME;
  }
  // `commitStep` resolves only after its transaction committed. A failure from
  // here on must neither fail the step nor abort the run (see `handleDiffJob`).
  progress.coreCommitted = true;

  // 5. After the commit: the rule metrics (a stale job records none), the
  // rule audit trail, then the events. The events come last because
  // `run.completed` reports the run's stored winning applications.
  observeStepRules(ctx, result, logger, deps);
  await persistRuleApplications(
    deps,
    {
      runId: job.runId,
      projectId: job.projectId,
      result,
      regionIds: commit.regionIds,
    },
    logger,
  );
  await publishStepEvents(deps.redis, {
    runId: job.runId,
    projectId: job.projectId,
    screenshotId: job.screenshotId,
    verdict: result.verdict,
    failed: false,
    // The status before and after this commit (the recompute's).
    rollup: commit.rollup,
    db: deps.db,
    logger,
  });
  const durationMs = Date.now() - t0;
  logger.info(
    {
      runId: job.runId,
      projectId: job.projectId,
      screenshotId: job.screenshotId,
      generation: job.generation,
      verdict: result.verdict,
      diffPercent: result.diffPercent,
      pixelMismatchCount: result.pixelMismatchCount,
      ranTiers: result.ranTiers,
      baselineSource: result.baselineSource,
      status: commit.rollup.after,
      autoApproved: result.autoApprove !== null,
      durationMs,
    },
    "diff_completed",
  );
  return { checkpoints: 1 };
}

/**
 * The job's rule metrics and log line, from the step's own evaluation
 * (`diffStep`): duration, matches by action, and a `rules evaluated` line.
 * Recorded only for a committed step, so a stale job adds none.
 */
function observeStepRules(
  ctx: StepContext,
  result: StepResult,
  logger: Logger,
  deps: HandlerDeps,
): void {
  if (!ctx.compiledRules) return;
  const counts = summarizeDecisions(result.ruleDecisions);
  const durationMs = result.ruleDiagnostics?.durationMs ?? 0;
  const matched = result.ruleDecisions.reduce(
    (n, d) => n + d.matchedRules.length,
    0,
  );
  deps.metrics?.rulesEvaluationDuration.observe(durationMs / 1000);
  if (counts.auto_approve > 0)
    deps.metrics?.rulesMatched
      .labels({ action: "auto_approve" })
      .inc(counts.auto_approve);
  if (counts.flag > 0)
    deps.metrics?.rulesMatched.labels({ action: "flag" }).inc(counts.flag);
  logger.info(
    {
      runId: ctx.run.id,
      screenshotId: result.screenshotId,
      rulesCompiled: ctx.compiledRules.rules.length,
      regionsEvaluated: result.ruleDecisions.length,
      matched,
      autoApproved: counts.auto_approve,
      flagged: counts.flag,
      durationMs,
    },
    "rules evaluated",
  );
}

const ignoreAreaParseSchema = z
  .object({
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
    width: z.number().int().min(1),
    height: z.number().int().min(1),
    viewport: z.string().min(1).max(32).optional(),
    paddingPx: z.number().int().min(0).max(32).default(0),
    // Match modes — see furan-design/specs/2026-05-23-region-modes-design.md.
    // The API zod (apps/api/src/trpc/v1/runs.ts) is the canonical
    // wire-shape gate; this schema is the worker's defensive re-parse
    // of the persisted JSON, so it must stay in sync with the wider
    // enum or live runs will fail to parse and silently fall through to
    // unmasked diff.
    kind: z
      .enum(["ignore", "dynamic-text", "strict", "layout", "content"])
      .default("ignore"),
    pattern: z.string().min(1).max(500).optional(),
    selector: z.string().min(1).max(500).optional(),
    thresholdOverride: z.number().min(0).max(1).optional(),
  })
  .refine(
    (r) =>
      r.kind !== "dynamic-text" ||
      (r.pattern !== undefined && r.pattern.length > 0),
    { message: "pattern is required when kind is dynamic-text" },
  );

/**
 * Per-run / per-variation ignore region. Includes an optional viewport tag
 * (added in ADR-031) so multi-viewport runs can apply masks to the right
 * screenshot. Legacy rows without `viewport` apply universally.
 */
export type ParsedIgnoreArea = z.infer<typeof ignoreAreaParseSchema>;

function parseIgnoreAreas(
  value: string | unknown | null | undefined,
): ParsedIgnoreArea[] | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  try {
    // ADR-038: ignoreRegions is stored as jsonb (already parsed by Drizzle).
    // Legacy ignore_areas was stored as a text column (JSON string). Handle
    // both: if the value is already an array/object, skip JSON.parse.
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (!Array.isArray(parsed)) return undefined;
    const out: ParsedIgnoreArea[] = [];
    for (const item of parsed) {
      const result = ignoreAreaParseSchema.safeParse(item);
      if (result.success) out.push(result.data);
    }
    return out;
  } catch {
    return undefined;
  }
}
