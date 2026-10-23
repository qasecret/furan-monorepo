import {
  and,
  autoRules,
  eq,
  inArray,
  isNull,
  ne,
  projects,
  screenshots,
  testRuns,
  testVariations,
  withProjectScope,
  type DB,
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
import type { DiffMetrics } from "./diff-metrics.js";
import { diffStep, type StepContext, type StepResult } from "./diff-step.js";
import { splitLegacyJob, type DiffJobQueue } from "./legacy-split.js";

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
   * `@furan/queue`). Only the final attempt marks the run `aborted`.
   */
  finalAttempt: boolean;
}

/**
 * Best-effort dual-publish: in addition to the existing per-run channel
 * (`run:{runId}:events`, which the diff viewer subscribes to), also fire
 * a `testRun_updated` + cascading `build_updated` event on the project
 * channel so the dashboard's list pages (Builds / Runs index) refresh
 * without manual reload. Spec
 * furan-design/specs/2026-05-24-list-level-live-updates-design.md §6.5.
 *
 * Payload is minimal (`{id, status}`) — the dashboard invalidates the
 * tRPC query on receipt and refetches the full row. Keeping the wire
 * lean avoids racing with stale data from the worker's snapshot of the
 * row vs whatever's actually in the DB once the listener queries.
 */
async function publishProjectRunUpdate(
  deps: Pick<HandlerDeps, "redis">,
  args: {
    projectId: string;
    runId: string;
    status: string;
    buildId?: string | null;
  },
  logger: Logger,
): Promise<void> {
  const channel = `project:${args.projectId}:events:raw`;
  try {
    await deps.redis.publish(
      channel,
      JSON.stringify({
        event: "testRun_updated",
        data: { id: args.runId, status: args.status },
        ts: Date.now(),
      }),
    );
    if (args.buildId) {
      await deps.redis.publish(
        channel,
        JSON.stringify({
          event: "build_updated",
          data: { id: args.buildId },
          ts: Date.now(),
        }),
      );
    }
  } catch (err) {
    logger.warn(
      { err, runId: args.runId, projectId: args.projectId },
      "diff_worker_project_publish_failed",
    );
  }
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
 * A failure is handled as before: a non-final attempt rethrows for BullMQ to
 * retry; the final attempt marks the run `aborted` unless the step's commit
 * already landed.
 */
export async function handleDiffJob(
  data: DiffJob,
  logger: Logger,
  deps: HandlerDeps,
  // Callers that don't track retries (CLIs, tests) get the safe default: a
  // failure is terminal and the run is marked `aborted`.
  attempt: DiffAttempt = { finalAttempt: true },
): Promise<DiffJobOutcome> {
  // Set by the step job the moment its commit (the step's verdict + the
  // recomputed totals and status) has landed.
  const progress: DiffProgress = { coreCommitted: false };
  try {
    const { screenshotId, generation } = data;
    if (screenshotId === undefined || generation === undefined) {
      const jobs = await splitLegacyJob(deps, data, deps.queue);
      logger.info(
        { runId: data.runId, projectId: data.projectId, jobs },
        "diff_whole_run_job_split",
      );
      return { checkpoints: 0 };
    }
    return await handleStepJob(
      { ...data, screenshotId, generation },
      logger,
      deps,
      progress,
    );
  } catch (err) {
    // Always log the primary error first. BullMQ stashes it in the job's
    // failedReason but the worker's own structured log was previously
    // silent — a class of bug (e.g. odiff spawn-fail on a base-image
    // GLIBC mismatch) would aborted-bucket every run with zero clue in
    // dashboards or stdout. The secondary catches below only log when
    // their own write fails, so this is the only place the actual cause
    // surfaces in the worker log stream. A failure BullMQ will retry is a
    // warning; only the failure that ends the job is an error.
    const failure = {
      err,
      runId: data.runId,
      projectId: data.projectId,
      screenshotId: data.screenshotId,
      finalAttempt: attempt.finalAttempt,
      coreCommitted: progress.coreCommitted,
    };
    if (attempt.finalAttempt) logger.error(failure, "diff_job_failed");
    else logger.warn(failure, "diff_job_failed");
    // Ruling R9: BullMQ retries a non-final attempt, so leave the run as it is
    // (`running`) and let the retry derive its status. `aborted` is a
    // lifecycle state `recomputeRunStatus` keeps, so writing it here would
    // stick even after the retry succeeds. Rethrow so BullMQ schedules it.
    if (!attempt.finalAttempt) throw err;
    // Ruling R11: once the step's commit has landed, the run holds a valid
    // derived status (and the step's verdict, regions and baseline). A later
    // failure (a Redis publish, say) must not replace it with `aborted`, which
    // `recomputeRunStatus` would then keep for good. It is logged above;
    // rethrow so the job still fails.
    if (progress.coreCommitted) throw err;
    // Final attempt: best-effort terminal status write so an aborted run does
    // not hang in `running` indefinitely. Per spec §3.2 worker exceptions land
    // as `aborted` (distinct from reviewer-rejected `failed`). Wrap in its
    // own try/catch so a status-write failure does not mask the original
    // error — the worker's error visibility is unchanged. `abortedByDiff`
    // marks it as the pipeline's abort, which a later commit that leaves every
    // step with a verdict heals (Ruling R46, `healPipelineAbort`). A run that
    // is already `aborted` is left exactly as it is (R50): an SDK or capture
    // abort is final, and re-flagging it as the pipeline's would let a later
    // diff heal it (a CI false pass); a pipeline abort already carries the
    // flag.
    try {
      await withProjectScope(deps.db, data.projectId, async (tx) => {
        await tx
          .update(testRuns)
          .set({ status: "aborted", abortedByDiff: true })
          .where(
            and(eq(testRuns.id, data.runId), ne(testRuns.status, "aborted")),
          );
      });
    } catch (statusErr) {
      logger.error(
        { err: statusErr, runId: data.runId },
        "failed_to_write_aborted_status",
      );
    }
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
    await publishProjectRunUpdate(
      deps,
      { projectId: data.projectId, runId: data.runId, status: "aborted" },
      logger,
    );
    throw err;
  }
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
 *     (fail-open), then the run events and the project-channel update for
 *     this committed step.
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
    logger.info(
      {
        runId: job.runId,
        screenshotId: job.screenshotId,
        generation: job.generation,
        currentGeneration: step?.diffGeneration ?? null,
      },
      "diff_step_stale",
    );
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
    logger.info(
      {
        runId: job.runId,
        screenshotId: job.screenshotId,
        generation: job.generation,
      },
      "diff_step_stale",
    );
    return STALE_OUTCOME;
  }
  // `commitStep` resolves only after its transaction committed. A failure from
  // here on must not mark the run `aborted` (see `handleDiffJob`).
  progress.coreCommitted = true;

  // 5. After the commit: the rule metrics (a stale job records none), the
  // rule audit trail, then the events.
  const rulesSummary = observeStepRules(ctx, result, logger, deps);
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

  // The run's events, as the whole-run job published them, now once per
  // committed step job; a stale job publishes none. `diffPercent`,
  // `numChanges`, `resolutionSource` and `rulesSummary` describe this step
  // (the run's totals are on its row).
  const durationMs = Date.now() - t0;
  const failed = result.verdict === "unresolved";
  const diffPercent = result.diffPercent ?? 0;
  await deps.redis.publish(
    `run:${job.runId}:events`,
    JSON.stringify({ type: "diff.started", runId: job.runId }),
  );
  await deps.redis.publish(
    `run:${job.runId}:events`,
    JSON.stringify({
      type: "diff.completed",
      runId: job.runId,
      passed: !failed,
      diffPercent,
      ranTiers: result.ranTiers,
      viewportCount: 1,
      durationMs,
      autoApproved: result.autoApprove !== null,
      firstBaseline: result.firstBaseline,
    }),
  );
  // T9: the `run.completed` event the integrations subscriber fans out to
  // GitHub (T8) + outbound webhooks (T9). GitHub-side fields (installationId,
  // repoOwner, repoName, sha, prNumber) are intentionally omitted; both
  // consumers are defensive about missing fields.
  await deps.redis.publish(
    `run:${job.runId}:events`,
    JSON.stringify({
      type: "run.completed",
      runId: job.runId,
      projectId: job.projectId,
      // The derived status after this commit (the recompute's `after`).
      status: commit.rollup.after,
      diffPercent,
      branchName: run.branchName,
      numChanges: result.regions.length,
      resolutionSource: !failed && result.ruleResolved ? "rule" : null,
      rulesSummary,
    }),
  );
  await publishProjectRunUpdate(
    deps,
    {
      projectId: job.projectId,
      runId: job.runId,
      status: commit.rollup.after,
      buildId: run.buildId,
    },
    logger,
  );
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
 * Returns the step's decision counts by action (null when the job has no
 * rules), for the `run.completed` event.
 */
function observeStepRules(
  ctx: StepContext,
  result: StepResult,
  logger: Logger,
  deps: HandlerDeps,
): ReturnType<typeof summarizeDecisions> | null {
  if (!ctx.compiledRules) return null;
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
  return counts;
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
