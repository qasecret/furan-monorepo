import {
  and,
  asc,
  autoRuleApplications,
  autoRules,
  computePrimarySignature,
  diffRegions,
  eq,
  inArray,
  isNull,
  ne,
  projects,
  recomputeRunStatus,
  recordBaseline,
  screenshots,
  sql,
  testRuns,
  testVariations,
  withProjectScope,
  type DB,
} from "@furan/db";
import {
  severityRank,
  EXCLUDED_SOURCES,
  type Severity,
} from "@furan/diff-engine";
import type { DiffJob } from "@furan/queue";
import {
  compileRules,
  createDefaultRegistries,
  summarize as summarizeDecisions,
} from "@furan/rules-engine";
import type {
  AutoRule,
  CompiledRuleset,
  EvaluationResult,
} from "@furan/rules-engine";
import type { Storage } from "@furan/storage";
import type { Telemetry } from "@furan/telemetry";
import type { Redis } from "ioredis";
import { z } from "zod";

import { autoApproveBaselineBlock } from "./auto-approve-guard.js";
import type { DiffMetrics } from "./diff-metrics.js";
import { diffStep, type StepContext, type StepResult } from "./diff-step.js";
import { aggregateRuleStatus, regionEngineId } from "./rules-aggregation.js";

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
 * Diff handler, one baseline per checkpoint (review flow spec §3, ADR-070).
 * Looks up the project + candidate run, then for EACH candidate screenshot
 * (checkpoint) in capture order, `diffStep`:
 *   1. resolves that checkpoint's own baseline via the three-tier
 *      `resolveBaseline` chain on its variation, and pairs it with the
 *      baseline run's screenshot OF THAT VARIATION (`checkpoint-baseline.ts`);
 *   2. no baseline, or a missing pair → verdict `new` (a first capture is
 *      auto-seeded as its variation's baseline under `autoApproveFeature`);
 *   3. hash or past-baseline match under `autoApproveFeature` (ADR-032) →
 *      verdict `passed` and the checkpoint becomes its variation's baseline;
 *   4. otherwise runs the image diff masked by its variation's ignore regions
 *      plus the run's temp regions → `passed` or `unresolved` after auto-rules.
 *
 * Every path ends in ONE transaction that writes the run aggregates, the
 * regions, each checkpoint's `screenshots.verdict`, and then calls
 * `recomputeRunStatus`, the only writer of `test_runs.status` after a diff (so
 * a reviewer's decision survives any re-diff). Run aggregates:
 *   diffPercent   = MAX(per-checkpoint diffPercent); NULL when no checkpoint
 *                   had a baseline to compare against.
 *   pixelMisMatchCount = SUM(per-checkpoint pixelMismatchCount); NULL likewise.
 *   diffName      = overlay key of the worst (max diffPercent) checkpoint;
 *                   null if no overlay was produced anywhere.
 *   baselineSource = tier of the worst checkpoint that resolved a baseline.
 *
 * Preserved from T9: publishes a terminal `run.completed` event (carrying the
 * recomputed status) after `diff.completed` so the integrations subscriber
 * (GitHub flow + webhook flow) can fan out.
 */
export async function handleDiffJob(
  data: DiffJob,
  logger: Logger,
  deps: HandlerDeps,
  // Callers that don't track retries (CLIs, tests) get the safe default: a
  // failure is terminal and the run is marked `aborted`.
  attempt: DiffAttempt = { finalAttempt: true },
): Promise<DiffJobOutcome> {
  // Set by the inner handler the moment its core transaction (verdicts + the
  // recomputed status) has committed.
  const progress: DiffProgress = { coreCommitted: false };
  try {
    return await handleDiffJobInner(data, logger, deps, progress);
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
    // Ruling R11: once the core transaction has committed, the run holds a
    // valid derived status (and its verdicts, regions and baselines). A later
    // failure (a Redis publish, say) must not replace it with `aborted`, which
    // `recomputeRunStatus` would then keep for good. It is logged above;
    // rethrow so the job still fails.
    if (progress.coreCommitted) throw err;
    // Final attempt: best-effort terminal status write so an aborted run does
    // not hang in `running` indefinitely. Per spec §3.2 worker exceptions land
    // as `aborted` (distinct from reviewer-rejected `failed`). Wrap in its
    // own try/catch so a status-write failure does not mask the original
    // error — the worker's error visibility is unchanged. `abortedByDiff`
    // marks it as the pipeline's abort, which a later successful diff of the
    // whole run heals (Ruling R46, `healPipelineAbort`). A run that is already
    // `aborted` is left exactly as it is (R50): an SDK or capture abort is
    // final, and re-flagging it as the pipeline's would let a later diff heal
    // it (a CI false pass); a pipeline abort already carries the flag.
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
 * Ruling R46: each upload enqueues a whole-run diff, and a job that fails its
 * final attempt writes `aborted`, a lifecycle state the rollup keeps. When a
 * later job leaves EVERY checkpoint of the run with a verdict, an abort the
 * pipeline wrote (`aborted_by_diff`) is reset to the lifecycle value `running`
 * so the `recomputeRunStatus` that follows yields the real rollup. An SDK
 * `/abort` or a capture-worker abort leaves the flag false and stays.
 *
 * Runs in the core transaction under the run's row lock, `FOR NO KEY UPDATE`
 * (R8; the transaction already holds it from the aggregate UPDATE), so a
 * concurrent abort or upload is either seen here or waits for this commit.
 * Returns true when it healed the run.
 */
async function healPipelineAbort(tx: DB, runId: string): Promise<boolean> {
  const [run] = await tx
    .select({ status: testRuns.status, abortedByDiff: testRuns.abortedByDiff })
    .from(testRuns)
    .where(eq(testRuns.id, runId))
    .for("no key update");
  if (run?.status !== "aborted" || !run.abortedByDiff) return false;

  const [pending] = await tx
    .select({ id: screenshots.id })
    .from(screenshots)
    .where(and(eq(screenshots.runId, runId), isNull(screenshots.verdict)))
    .limit(1);
  if (pending) return false;

  await tx
    .update(testRuns)
    .set({ status: "running", abortedByDiff: false })
    .where(eq(testRuns.id, runId));
  return true;
}

/**
 * What a diff job that ran to the end reports to its caller (the worker
 * runtime records it as a metric). Callers that don't need it ignore it.
 */
export interface DiffJobOutcome {
  /** Screenshots the job diffed (`candidateShots.length`). A run with none throws instead. */
  checkpoints: number;
}

/** What `handleDiffJobInner` has durably done so far; read by the failure path. */
interface DiffProgress {
  /** True once the core transaction has committed (never set earlier). */
  coreCommitted: boolean;
}

/**
 * The read-only inputs every step of one job shares (`StepContext`), read once
 * per job: the steps' variation ignore regions, the run's temp regions, the
 * threshold, and the project's auto rules, fetched and compiled up front
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

async function handleDiffJobInner(
  data: DiffJob,
  logger: Logger,
  deps: HandlerDeps,
  progress: DiffProgress,
): Promise<DiffJobOutcome> {
  const t0 = Date.now();
  await deps.redis.publish(
    `run:${data.runId}:events`,
    JSON.stringify({ type: "diff.started", runId: data.runId }),
  );

  const project = await deps.db.query.projects.findFirst({
    where: eq(projects.id, data.projectId),
  });
  if (!project) throw new Error(`project_not_found:${data.projectId}`);

  const run = await deps.db.query.testRuns.findFirst({
    where: eq(testRuns.id, data.runId),
  });
  if (!run) throw new Error(`run_not_found:${data.runId}`);
  if (!run.branchName) {
    throw new Error(`run_missing_branch_name:${data.runId}`);
  }
  const branchName = run.branchName;

  // Spec §3 (ADR-070): one baseline per checkpoint. Each candidate screenshot
  // (one checkpoint = one variation, ADR-038) resolves, pairs, auto-approves
  // and diffs on its own; nothing below is keyed on "the run's variation".
  // Capture order, so results (and ties) are stable across re-diffs.
  const candidateShots = await deps.db
    .select()
    .from(screenshots)
    .where(eq(screenshots.runId, data.runId))
    .orderBy(asc(screenshots.createdAt), asc(screenshots.id));
  if (candidateShots.length === 0) {
    throw new Error(`run_has_no_screenshots:${data.runId}`);
  }

  const ctx = await loadStepContext(deps, logger, {
    project,
    run,
    variationIds: candidateShots.map((cs) => cs.testVariationId),
    parentPrBaseBranch: data.parentPrBaseBranch ?? null,
  });

  // Each checkpoint resolves, pairs, auto-approves, diffs and runs its own
  // regions through the auto rules on its own (`diffStep`). Results are kept
  // in CANDIDATE ORDER: the auto-rule application persistence zips
  // `regionEngineId(index, i)` with the inserted `diff_regions` ids, so the
  // two traversals must line up.
  const results: StepResult[] = [];
  for (const cs of candidateShots) {
    results.push(await diffStep(ctx, cs));
  }

  // ── Auto Rules: the run-wide result ─────────────────────────
  // Each step evaluated its own regions (`diffStep`), keyed `0:i`. Re-key them
  // to the run-wide `regionEngineId(index, i)` the status aggregation and the
  // application persistence below use; nothing is evaluated twice. The rule
  // metrics and log line stay one per job.
  let rulesResult: EvaluationResult | null = null;
  if (ctx.compiledRules) {
    const allDecisions = results.flatMap((r, idx) => {
      const regionIndex = new Map(r.engineIds.map((id, i) => [id, i]));
      return r.ruleDecisions.map((d) => ({
        ...d,
        regionId: regionEngineId(idx, regionIndex.get(d.regionId)!),
      }));
    });
    const allCounts = summarizeDecisions(allDecisions);
    const stepDiagnostics = results.flatMap((r) =>
      r.ruleDiagnostics ? [r.ruleDiagnostics] : [],
    );

    rulesResult = {
      decisions: allDecisions,
      counts: allCounts,
      diagnostics: {
        evaluatedRules: ctx.compiledRules.rules.length,
        matchedRules: allDecisions.reduce(
          (n, d) => n + d.matchedRules.length,
          0,
        ),
        skippedBecauseNoElementMap: stepDiagnostics.reduce(
          (n, d) => n + d.skippedBecauseNoElementMap,
          0,
        ),
        selectorMisses: stepDiagnostics.reduce(
          (n, d) => n + d.selectorMisses,
          0,
        ),
        durationMs: stepDiagnostics.reduce((n, d) => n + d.durationMs, 0),
      },
    };

    deps.metrics?.rulesEvaluationDuration.observe(
      rulesResult.diagnostics.durationMs / 1000,
    );
    if (allCounts.auto_approve > 0)
      deps.metrics?.rulesMatched
        .labels({ action: "auto_approve" })
        .inc(allCounts.auto_approve);
    if (allCounts.flag > 0)
      deps.metrics?.rulesMatched.labels({ action: "flag" }).inc(allCounts.flag);

    logger.info(
      {
        runId: data.runId,
        rulesCompiled: ctx.compiledRules.rules.length,
        regionsEvaluated: allDecisions.length,
        matched: rulesResult.diagnostics.matchedRules,
        autoApproved: allCounts.auto_approve,
        flagged: allCounts.flag,
        durationMs: rulesResult.diagnostics.durationMs,
      },
      "rules evaluated",
    );
  }

  // Run-level outcome after auto-rules + resolution attribution (see
  // rules-aggregation.ts for the exact rules and its unit tests). Each
  // checkpoint's verdict (spec §3) came with its `StepResult`. The diff-worker
  // never writes `failed` (reviewer-rejected only) and never writes the run
  // status: `recomputeRunStatus` derives it from these verdicts and any active
  // decisions, so a reviewer's decision survives every re-diff.
  const statusInputs = results.map((c) => ({
    passed: c.passed,
    regionCount: c.regions.length,
  }));
  const { aggregateFailed, resolutionSource } = aggregateRuleStatus(
    statusInputs,
    rulesResult,
  );

  // Run aggregates on the single test_runs row:
  // - diffPercent: MAX across checkpoints (surfaces the worst one); NULL when
  //   no checkpoint had a baseline to compare against (nothing was compared).
  // - pixelMisMatchCount: SUM across checkpoints (NULL likewise).
  // - diffName: overlay key of the checkpoint with max diffPercent (or null).
  //   Each checkpoint's own overlay key is `screenshots.diff_image_key`.
  // - baselineSource: tier of the worst checkpoint that resolved a baseline
  //   (first such checkpoint on ties); null when none resolved one.
  // A checkpoint with no baseline image has no diff % or pixel count; it
  // counts as 0 here, exactly as before (`compared` decides the NULLs).
  const compared = results.some((r) => !r.firstBaseline);
  const aggregateDiffPercent = results.reduce(
    (m, v) => ((v.diffPercent ?? 0) > m ? (v.diffPercent ?? 0) : m),
    0,
  );
  const aggregatePixelMismatch = results.reduce(
    (s, v) => s + (v.pixelMismatchCount ?? 0),
    0,
  );
  const worstOf = (rs: StepResult[]) =>
    rs.reduce<StepResult | null>(
      (acc, v) =>
        acc === null || (v.diffPercent ?? 0) > (acc.diffPercent ?? 0) ? v : acc,
      null,
    );
  const aggregateDiffName = worstOf(results)?.diffImageKey ?? null;
  const runBaselineSource =
    worstOf(results.filter((r) => r.baselineSource !== null))?.baselineSource ??
    null;
  const aggregateRegions = results.flatMap((v) => v.regions);
  const aggregateVlmDescription =
    results.find((v) => v.vlmDescription)?.vlmDescription ?? null;
  const allAutoApproved = results.every((r) => r.autoApprove !== null);

  // ADR-043 §4.2: roll up the most-severe unresolved checkpoint's diff_signature
  // as the run's primary_signature for inbox grouping. Computed from the
  // checkpoint results so it includes all checkpoints that completed diffing.
  // sweeper.ts (stale-run finalizer) has no diff data and intentionally leaves
  // primary_signature NULL.
  // Computed once per diff job from the diff results, never from decisions.
  // ADR-070 brought partial approval (a run can hold approved and unresolved
  // checkpoints at once), and deciding a checkpoint deliberately does NOT
  // recompute primary_signature: it can still name an approved checkpoint
  // until the next re-diff. Accepted because it feeds only the cross-build
  // inbox clustering (review flow spec §11); recompute it on decision changes
  // if that clustering ever needs to track review state.
  const primarySignature = computePrimarySignature(
    results.map((v) => ({
      diffSignature: v.diffSignature,
      // Rank by the SAME regions the signature is built from. Image-first
      // (ADR-047): image (l1_pixel) regions are the primary signal — they feed
      // both the checkpoint signature and this ranking. EXCLUDED_SOURCES excludes
      // only dynamic_text audit rows (ADR-047), so this fold includes image
      // (l1_pixel) regions.
      worstSeverity: v.regions
        .filter((r) => !EXCLUDED_SOURCES.has(r.source))
        .reduce<Severity>(
          (worst, r) =>
            severityRank(r.severity as Severity) > severityRank(worst)
              ? (r.severity as Severity)
              : worst,
          "none",
        ),
    })),
  );

  // Captured from the core transaction so the (fail-open) auto-rule
  // application persistence can run in its OWN transaction afterwards —
  // an audit-write failure must never roll back the committed run result.
  let insertedRegionIds: string[] = [];
  const candidateById = new Map(candidateShots.map((cs) => [cs.id, cs]));

  // The single write of every path (first capture, auto-approve, missing
  // pair, engine diff). It ends with `recomputeRunStatus`, which locks the run
  // (FOR NO KEY UPDATE) and derives its status from the verdicts written here.
  const rollup = await withProjectScope(deps.db, data.projectId, async (tx) => {
    // Idempotency: clear this run's prior diff artifacts before re-deriving
    // them, so a BullMQ retry (attempts:3) OR a re-enqueued diff (e.g. after
    // setIgnoreAreas / addIgnoreAreas / setDiffThresholdOverride) REPLACES the
    // regions instead of appending — otherwise the diff viewer overlays each
    // region twice and inbox grouping skews. auto_rule_applications reference
    // these regions, so delete them first (by run) to avoid a dangling FK.
    await tx
      .delete(autoRuleApplications)
      .where(eq(autoRuleApplications.testRunId, data.runId));
    await tx.delete(diffRegions).where(eq(diffRegions.runId, data.runId));

    // No `status` here: after a diff only `recomputeRunStatus` writes it.
    await tx
      .update(testRuns)
      .set({
        diffPercent: compared ? aggregateDiffPercent : null,
        pixelMisMatchCount: compared ? aggregatePixelMismatch : null,
        diffName: aggregateDiffName,
        baselineSource: runBaselineSource,
        vlmDescription: aggregateVlmDescription,
        primarySignature,
        resolutionSource,
      })
      .where(eq(testRuns.id, data.runId));

    if (aggregateRegions.length > 0) {
      const inserted = await tx
        .insert(diffRegions)
        .values(
          aggregateRegions.map((r) => ({
            runId: data.runId,
            projectId: data.projectId,
            screenshotId: r.screenshotId,
            severity: r.severity,
            category: r.category,
            bbox: r.bbox,
            description: r.description,
            source: r.source,
            viewport: r.viewport,
          })),
        )
        .returning({ id: diffRegions.id });
      insertedRegionIds = inserted.map((r) => r.id);
    }

    // Per checkpoint: its verdict (spec §3), its ADR-042 signature for
    // build-scoped grouping (null when it was not diffed or had no meaningful
    // regions → "ungrouped") and its own diff image (null when the diff
    // produced none, or it was not diffed). A re-diff rewrites all three, so a
    // checkpoint that no longer differs loses its image.
    for (const r of results) {
      await tx
        .update(screenshots)
        .set({
          diffSignature: r.diffSignature,
          diffImageKey: r.diffImageKey,
          verdict: r.verdict,
          verdictAt: sql`clock_timestamp()`,
        })
        .where(eq(screenshots.id, r.screenshotId));
    }

    // Auto-approved checkpoints become their own variation's baseline;
    // userId omitted → NULL marks it as auto (the SDK's per-run
    // `autoApproved` flag reads exactly that). Each call updates its
    // `test_variations` row, and runs of one project share variations, so two
    // concurrent jobs would deadlock if they locked those rows in different
    // (capture) orders. Writing in ascending variation-id order makes the lock
    // order the same everywhere.
    //
    // The verdict is the auto-approve's either way; the baseline is written
    // only when no reviewer decided the checkpoint, its paired baseline is not
    // its own row, and no baseline of the variation is newer than this run
    // (`autoApproveBaselineBlock`), so a re-diff never rewrites a reviewer's
    // baseline or puts an older image back as the current one.
    const autoApproved = results
      .flatMap((r) =>
        r.autoApprove
          ? [
              {
                cs: candidateById.get(r.screenshotId)!,
                decision: r.autoApprove,
              },
            ]
          : [],
      )
      .sort((a, b) =>
        a.cs.testVariationId < b.cs.testVariationId
          ? -1
          : a.cs.testVariationId > b.cs.testVariationId
            ? 1
            : 0,
      );
    for (const { cs, decision } of autoApproved) {
      const blocked = await autoApproveBaselineBlock(tx, {
        screenshotId: cs.id,
        testVariationId: cs.testVariationId,
        runId: run.id,
        branchName,
        pairedBaselineRunId: decision.pairedBaselineRunId,
      });
      if (blocked) {
        logger.info(
          {
            runId: data.runId,
            screenshotId: cs.id,
            variationId: cs.testVariationId,
            reason: blocked,
          },
          "diff_auto_approve_baseline_kept",
        );
        continue;
      }
      await recordBaseline(tx, {
        testVariationId: cs.testVariationId,
        testRunId: run.id,
        imageKey: cs.imageKey,
        runName: run.baselineName ?? run.name,
        branchName: run.branchName,
      });
    }

    // Synthetic audit rows for dynamic-text OCR decisions (matched OR
    // unmatched), one per (checkpoint, region): each step's `ocrAudit`.
    const auditValues = results.flatMap((r) =>
      r.ocrAudit.map((row) => ({
        runId: data.runId,
        projectId: data.projectId,
        ...row,
      })),
    );
    if (auditValues.length > 0) {
      await tx.insert(diffRegions).values(auditValues);
    }

    // A pipeline abort (an earlier job's final attempt) heals once this job
    // leaves every checkpoint with a verdict (Ruling R46).
    if (await healPipelineAbort(tx, data.runId)) {
      logger.info({ runId: data.runId }, "diff_pipeline_abort_healed");
    }

    // Last, after every child-row write: derive the run status.
    return recomputeRunStatus(tx, data.runId);
  });
  // `withProjectScope` resolves only after the transaction committed. A failure
  // from here on must not mark the run `aborted` (see `handleDiffJob`).
  progress.coreCommitted = true;

  // ── Auto Rules application persistence (fail-open) ───────────
  // Runs in its OWN transaction AFTER the core run result is committed, wrapped
  // in try/catch: a failure here loses only the rule audit trail, never the
  // run's status or diff regions. (Rule evaluation already fails open above.)
  if (
    rulesResult &&
    rulesResult.decisions.length > 0 &&
    insertedRegionIds.length > 0
  ) {
    try {
      // engineIds enumerate regions in the SAME order as aggregateRegions (and
      // therefore insertedRegionIds), so zipping the two is a stable mapping
      // with no positional drift between separate traversals.
      const engineIds = results.flatMap((vp, vpIdx) =>
        vp.regions.map((_r, i) => regionEngineId(vpIdx, i)),
      );
      const regionIdMap = new Map<string, string>();
      for (
        let idx = 0;
        idx < engineIds.length && idx < insertedRegionIds.length;
        idx++
      ) {
        regionIdMap.set(engineIds[idx]!, insertedRegionIds[idx]!);
      }

      const applicationRows = rulesResult.decisions.flatMap((decision) => {
        const dbRegionId = regionIdMap.get(decision.regionId);
        if (!dbRegionId) return [];
        return decision.matchedRules.map((rm) => ({
          ruleId: rm.ruleId,
          ruleVersion: rm.ruleVersion,
          testRunId: data.runId,
          diffRegionId: dbRegionId,
          regionDiffPct: rm.regionDiffPct,
          // Policy rank of the rule's ACTION (1=auto_approve, 2=flag), not the
          // region's visual severity — see auto_rule_applications schema.
          actionPriority: rm.severity,
          won: rm.won,
        }));
      });

      if (applicationRows.length > 0) {
        await withProjectScope(deps.db, data.projectId, async (tx) => {
          const insertedApps = await tx
            .insert(autoRuleApplications)
            .values(applicationRows)
            .returning({
              id: autoRuleApplications.id,
              diffRegionId: autoRuleApplications.diffRegionId,
              won: autoRuleApplications.won,
            });

          // Link each region to its WINNING application in one statement
          // (UPDATE … FROM VALUES) rather than one round-trip per winner.
          const wonApps = insertedApps.filter((a) => a.won);
          if (wonApps.length > 0) {
            await tx.execute(sql`
              UPDATE diff_regions SET resolved_by_application_id = v.app_id::uuid
              FROM (VALUES ${sql.join(
                wonApps.map(
                  (a) => sql`(${a.diffRegionId}::uuid, ${a.id}::uuid)`,
                ),
                sql`, `,
              )}) AS v(region_id, app_id)
              WHERE diff_regions.id = v.region_id
            `);
          }

          // Credit applied_count ONLY to rules that actually won a region; a
          // rule that matched but lost the severity tiebreak resolved nothing.
          const countsByRule = new Map<string, number>();
          for (const row of applicationRows) {
            if (!row.won) continue;
            countsByRule.set(
              row.ruleId,
              (countsByRule.get(row.ruleId) ?? 0) + 1,
            );
          }
          if (countsByRule.size > 0) {
            await tx.execute(sql`
              UPDATE auto_rules SET applied_count = applied_count + v.cnt
              FROM (VALUES ${sql.join(
                [...countsByRule].map(
                  ([id, cnt]) => sql`(${id}::uuid, ${cnt}::int)`,
                ),
                sql`, `,
              )}) AS v(id, cnt)
              WHERE auto_rules.id = v.id
            `);
          }
        });
      }
    } catch (err) {
      logger.error(
        { err, runId: data.runId, projectId: data.projectId },
        "auto-rule application persistence failed; run result preserved",
      );
      deps.metrics?.rulesEvaluationErrors.inc();
    }
  }

  const durationMs = Date.now() - t0;
  const ranTiersUnion = Array.from(new Set(results.flatMap((v) => v.ranTiers)));
  await deps.redis.publish(
    `run:${data.runId}:events`,
    JSON.stringify({
      type: "diff.completed",
      runId: data.runId,
      passed: !aggregateFailed,
      diffPercent: aggregateDiffPercent,
      ranTiers: ranTiersUnion,
      viewportCount: results.length,
      durationMs,
      // True only when EVERY checkpoint was auto-approved / was a first
      // capture (the shapes the old whole-run short-circuits published).
      autoApproved: allAutoApproved,
      firstBaseline: results.every((r) => r.firstBaseline),
    }),
  );
  // T9: emit the terminal `run.completed` event so the integrations
  // subscriber can fan out to GitHub (T8) + outbound webhooks (T9).
  // GitHub-side fields (installationId, repoOwner, repoName, sha,
  // prNumber) are intentionally omitted — reaching them from the diff
  // worker would require joining `installations` to the project AND
  // sniffing the branch's open PR. Both T8's GitHub consumer and T9's
  // webhook consumer are defensive about missing fields, so we ship
  // only the core fields here and revisit when the join becomes cheap.
  await deps.redis.publish(
    `run:${data.runId}:events`,
    JSON.stringify({
      type: "run.completed",
      runId: data.runId,
      projectId: data.projectId,
      // The derived status after this diff (the recompute's `after`).
      status: rollup.after,
      diffPercent: aggregateDiffPercent,
      branchName: run.branchName,
      numChanges: aggregateRegions.length,
      resolutionSource,
      rulesSummary: rulesResult?.counts ?? null,
    }),
  );
  await publishProjectRunUpdate(
    deps,
    {
      projectId: data.projectId,
      runId: data.runId,
      status: rollup.after,
      buildId: run.buildId,
    },
    logger,
  );
  logger.info(
    {
      runId: data.runId,
      projectId: data.projectId,
      diffPercent: aggregateDiffPercent,
      pixelMismatchCount: aggregatePixelMismatch,
      ranTiers: ranTiersUnion,
      baselineSource: runBaselineSource,
      viewportCount: results.length,
      status: rollup.after,
      autoApproved: allAutoApproved,
      durationMs,
    },
    "diff_completed",
  );
  return { checkpoints: candidateShots.length };
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
