import {
  and,
  asc,
  autoRuleApplications,
  autoRules,
  baselines,
  desc,
  diffRegions,
  eq,
  inArray,
  isNull,
  projects,
  recomputeRunStatus,
  recordBaseline,
  screenshots,
  sql,
  testRuns,
  testVariations,
  withProjectScope,
  type BaselineSource,
  type DB,
} from "@furan/db";
import {
  runAxe,
  runDiff,
  runL1,
  runVlm,
  classifyRegions,
  computeCheckpointSignature,
  severityRank,
  EXCLUDED_SOURCES,
  DEFAULT_ENGINE_CONFIG,
  DEFAULT_VLM_CONFIG,
  configForMatchLevel,
  ollamaProvider,
  geminiProvider,
  anthropicProvider,
  type MatchLevel,
  type Severity,
  type VlmProvider,
  type VlmProviderConfig,
} from "@furan/diff-engine";
import type { DiffJob } from "@furan/queue";
import {
  compileRules,
  createDefaultRegistries,
  evaluateCompiled,
  summarize as summarizeDecisions,
} from "@furan/rules-engine";
import type {
  AutoRule,
  DiffRegion as RulesDiffRegion,
  ElementMap as RulesElementMap,
  EvaluationResult,
} from "@furan/rules-engine";
import { objectKey, type Storage } from "@furan/storage";
import type { Telemetry } from "@furan/telemetry";
import type { Redis } from "ioredis";
import sharp from "sharp";
import { z } from "zod";

import { resolveAxeBboxes } from "./axe-bbox-resolver.js";
import { resolveCheckpointBaseline } from "./checkpoint-baseline.js";
import type { DiffMetrics } from "./diff-metrics.js";
import {
  evaluateDynamicTextRegions,
  type DynamicTextResult,
} from "./dynamic-text.js";
import {
  fetchElementMap,
  resolveRegionBbox,
  type ElementMap,
} from "./element-map-resolver.js";
import { parseEngineConfig, redactSecret } from "./engine-config.js";
import { classifyLayoutClusters } from "./layout-suppression.js";
import { computePrimarySignature } from "./primary-signature.js";
import { resolveRuleSelectorElementMap } from "./rule-selector-resolver.js";
import {
  aggregateRuleStatus,
  checkpointFailures,
  regionEngineId,
} from "./rules-aggregation.js";
import { strictBreaches, type StrictRegionInput } from "./strict-tolerance.js";

function resolveVlmProvider(config: VlmProviderConfig): VlmProvider {
  const provider = config.provider ?? "ollama";
  switch (provider) {
    case "gemini":
      return geminiProvider;
    case "anthropic":
      return anthropicProvider;
    case "ollama":
    default:
      return ollamaProvider;
  }
}

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

/** What the diff found for one checkpoint (`screenshots.verdict`). */
type CheckpointVerdict = NonNullable<
  (typeof screenshots.$inferSelect)["verdict"]
>;

/**
 * One candidate screenshot (checkpoint) after its own baseline was resolved,
 * paired and diffed (spec §3). Results are kept in CANDIDATE ORDER: the
 * auto-rule application persistence zips `regionEngineId(index, i)` with the
 * inserted `diff_regions` ids, so the two traversals must line up.
 */
interface CheckpointResult {
  /** The candidate screenshot this result is for. */
  screenshotId: string;
  viewport: string | null;
  passed: boolean;
  diffPercent: number;
  pixelMismatchCount: number;
  diffImageKey: string | null;
  regions: Array<{
    severity: string;
    category: string;
    bbox: unknown;
    description: string;
    source: string;
    viewport: string | null;
    screenshotId: string;
  }>;
  ranTiers: Array<"l1">;
  /**
   * No baseline image to diff against: none resolved in any tier, or the
   * resolved baseline's screenshot is missing. Verdict `new`; such a result
   * keeps `passed: true` and no regions so the rules/status inputs hold.
   */
  firstBaseline: boolean;
  /**
   * Auto-approved (ADR-032 hash match, past-baseline match, or first-capture
   * auto-seed under `autoApproveFeature`): the checkpoint becomes its
   * variation's baseline with a NULL user.
   */
  autoApproved: boolean;
  /** Tier the checkpoint's baseline resolved from; null when none did. */
  baselineSource: BaselineSource | null;
  verdict: CheckpointVerdict;
  vlmDescription?: string | undefined;
  /** Auto-rule selectors resolved against this checkpoint's DOM + element-map
   * (engine-shaped, keyed by the rule's selector string). Empty when there are
   * no rules / no DOM / no element-map. */
  ruleElementMap?: RulesElementMap;
  /** ADR-042: the checkpoint's diff signature; null when it was not diffed or
   * had no meaningful regions. */
  diffSignature: string | null;
}

/** A checkpoint before the auto-rules pass decides its verdict. */
type CheckpointDiff = Omit<CheckpointResult, "verdict">;

/** A checkpoint that is not diffed: first capture, missing pair, or auto-approved. */
function undiffedCheckpoint(
  cs: { id: string; viewport: string | null },
  outcome: Pick<
    CheckpointDiff,
    "firstBaseline" | "autoApproved" | "baselineSource"
  >,
): CheckpointDiff {
  return {
    screenshotId: cs.id,
    viewport: cs.viewport ?? null,
    passed: true,
    diffPercent: 0,
    pixelMismatchCount: 0,
    diffImageKey: null,
    regions: [],
    ranTiers: [],
    diffSignature: null,
    ...outcome,
  };
}

async function tryAutoApproveByPastBaselines(
  db: DB,
  storage: Storage,
  variationId: string,
  candidateImageKey: string,
  diffThreshold: number,
  logger: Logger,
): Promise<boolean> {
  const pastBaselines = await db
    .select({
      testRunId: baselines.testRunId,
      testVariationId: baselines.testVariationId,
    })
    .from(baselines)
    .where(eq(baselines.testVariationId, variationId))
    // resolveBaseline's order, so [0] is the current baseline skipped below.
    .orderBy(desc(baselines.createdAt), desc(baselines.id))
    .limit(10);

  if (pastBaselines.length <= 1) return false;

  const candidateBytes = await storage.get(candidateImageKey);
  if (!candidateBytes) return false;

  for (const bl of pastBaselines.slice(1)) {
    try {
      // The past baseline's own image: its run's screenshot OF THIS VARIATION.
      // A run holds one screenshot per checkpoint, so pairing by run alone
      // would compare against an arbitrary sibling checkpoint.
      const blScreenshot = await db
        .select({ imageKey: screenshots.imageKey })
        .from(screenshots)
        .where(
          and(
            eq(screenshots.runId, bl.testRunId),
            eq(screenshots.testVariationId, bl.testVariationId),
          ),
        )
        .orderBy(desc(screenshots.createdAt), desc(screenshots.id))
        .limit(1);
      if (!blScreenshot[0]?.imageKey) continue;

      const blBytes = await storage.get(blScreenshot[0].imageKey);
      if (!blBytes) continue;

      const l1 = await runL1(
        Buffer.from(blBytes),
        Buffer.from(candidateBytes),
        undefined,
        "odiff",
        DEFAULT_ENGINE_CONFIG,
      );
      if (l1.diffPercent <= diffThreshold * 100) {
        logger.info(
          { variationId, matchedBaselineRunId: bl.testRunId },
          "auto-approve: candidate matches past baseline",
        );
        return true;
      }
    } catch (err) {
      // A past-baseline comparison failing (e.g. its image is missing from
      // storage) shouldn't abort auto-approve — skip that baseline. But log
      // it: a silent skip could otherwise hide systemic storage/compare
      // failures behind a run that just "didn't auto-approve".
      logger.warn(
        { err, variationId, baselineRunId: bl.testRunId },
        "auto_approve_baseline_compare_failed",
      );
      continue;
    }
  }
  return false;
}

/**
 * Diff handler, one baseline per checkpoint (review flow spec §3, ADR-070).
 * Looks up the project + candidate run, then for EACH candidate screenshot
 * (checkpoint) in capture order:
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
): Promise<void> {
  // Set by the inner handler the moment its core transaction (verdicts + the
  // recomputed status) has committed.
  const progress: DiffProgress = { coreCommitted: false };
  try {
    await handleDiffJobInner(data, logger, deps, progress);
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
    // error — the worker's error visibility is unchanged.
    try {
      await withProjectScope(deps.db, data.projectId, async (tx) => {
        await tx
          .update(testRuns)
          .set({ status: "aborted" })
          .where(eq(testRuns.id, data.runId));
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

/** What `handleDiffJobInner` has durably done so far; read by the failure path. */
interface DiffProgress {
  /** True once the core transaction has committed (never set earlier). */
  coreCommitted: boolean;
}

async function handleDiffJobInner(
  data: DiffJob,
  logger: Logger,
  deps: HandlerDeps,
  progress: DiffProgress,
): Promise<void> {
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

  // Per ADR-031: ignore regions are the checkpoint's VARIATION regions plus
  // the run's temp regions, both JSON arrays of {x,y,width,height,viewport?}.
  // The viewport tag is filtered against each candidate's viewport inside the
  // loop; legacy rows without `viewport` apply universally. Load every
  // candidate variation once (ignoreRegions is jsonb, already parsed by
  // Drizzle; parseIgnoreAreas handles both string and pre-parsed values).
  const variationRows = await deps.db
    .select({
      id: testVariations.id,
      ignoreRegions: testVariations.ignoreRegions,
    })
    .from(testVariations)
    .where(
      inArray(testVariations.id, [
        ...new Set(candidateShots.map((cs) => cs.testVariationId)),
      ]),
    );
  const variationRegions = new Map(
    variationRows.map((v) => [v.id, parseIgnoreAreas(v.ignoreRegions) ?? []]),
  );
  const tempRegions = parseIgnoreAreas(run.tempIgnoreAreas) ?? [];

  // Per-run override (set via the in-viewer sensitivity slider) wins over the
  // project default. Null/undefined means "inherit".
  const diffThreshold =
    run.diffThresholdOverride ?? project.diffThreshold ?? 0.001;

  const checkpoints: CheckpointDiff[] = [];
  // Per-checkpoint dynamic-text OCR audit. Each entry carries the checkpoint's
  // regions and the per-region OCR results, so we can persist a synthetic
  // audit row in `diff_regions` per (checkpoint, region) pair.
  const dynamicTextAudits: Array<{
    viewport: string | null;
    screenshotId: string;
    regions: ParsedIgnoreArea[];
    results: DynamicTextResult[];
  }> = [];
  // Per-job cache shared across viewports. Avoids refetching the same
  // element-map sidecar when multiple viewports of the same job carry
  // the same `elementMapKey` (rare) or when a single viewport's regions
  // all resolve against the same map (the common case).
  const elementMapCache = new Map<string, ElementMap | null>();

  // Auto Rules: fetch enabled rules once up front. Their distinct CSS selectors
  // drive per-checkpoint element-map resolution INSIDE the loop (the candidate
  // DOM is only in scope there); the rows themselves are compiled + evaluated
  // after the loop. Fail-open: a fetch error disables rules for this run only.
  let projectRules: (typeof autoRules.$inferSelect)[] = [];
  let ruleSelectors: string[] = [];
  try {
    projectRules = await deps.db
      .select()
      .from(autoRules)
      .where(
        and(
          eq(autoRules.projectId, data.projectId),
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
      { err, runId: data.runId, projectId: data.projectId },
      "auto-rule fetch failed; proceeding without rule decisions",
    );
    deps.metrics?.rulesEvaluationErrors.inc();
    projectRules = [];
    ruleSelectors = [];
  }

  for (const cs of candidateShots) {
    const viewportKey = cs.viewport ?? null;

    // 1. Resolve this checkpoint's own baseline (three-tier chain on ITS
    //    variation) and pair it with that baseline's exact image.
    const pairing = await resolveCheckpointBaseline(deps.db, {
      projectId: data.projectId,
      branchName: run.branchName,
      testVariationId: cs.testVariationId,
      defaultBranch: project.mainBranchName,
      parentPrBaseBranch: data.parentPrBaseBranch ?? null,
    });

    // 2. No baseline image → verdict `new`, no diff.
    //    - none: a first capture. With `autoApproveFeature` (ADR-036) it is
    //      auto-seeded as its variation's baseline (NULL user); otherwise the
    //      reviewer saves it. Either way the verdict stays `new`.
    //    - pair_missing: a baseline resolved but its run holds no screenshot of
    //      its variation (data drift). Never diffed against another
    //      checkpoint's image, and never auto-seeded over the real baseline.
    if (pairing.kind !== "paired") {
      if (pairing.kind === "pair_missing") {
        deps.metrics?.baselinePairMissing.inc();
        logger.warn(
          {
            project_id: data.projectId,
            run_id: data.runId,
            screenshot_id: cs.id,
            variation_id: cs.testVariationId,
            baseline_id: pairing.baselineId,
          },
          "diff_baseline_pair_missing",
        );
      } else {
        logger.info(
          { runId: data.runId, screenshotId: cs.id, viewport: viewportKey },
          "diff_checkpoint_no_baseline",
        );
      }
      checkpoints.push(
        undiffedCheckpoint(cs, {
          firstBaseline: true,
          autoApproved:
            pairing.kind === "none" && project.autoApproveFeature === true,
          baselineSource:
            pairing.kind === "pair_missing" ? pairing.source : null,
        }),
      );
      continue;
    }
    const baselineShot = pairing.baselineShot;

    // 3. Auto-approve, per checkpoint (ADR-032): this checkpoint's image hash
    //    equals its paired baseline's, or it matches one of its variation's
    //    recent past baselines. Short-circuits the engine; the checkpoint
    //    passes and becomes its variation's baseline (NULL user).
    if (project.autoApproveFeature) {
      let strategy: "hash" | "past-baseline" | null = null;
      if (cs.imageKey === baselineShot.imageKey) {
        strategy = "hash";
      } else if (
        await tryAutoApproveByPastBaselines(
          deps.db,
          deps.storage,
          cs.testVariationId,
          cs.imageKey,
          diffThreshold,
          logger,
        )
      ) {
        strategy = "past-baseline";
      }
      if (strategy !== null) {
        logger.info(
          {
            runId: data.runId,
            projectId: data.projectId,
            screenshotId: cs.id,
            strategy,
          },
          "diff_checkpoint_auto_approved",
        );
        checkpoints.push(
          undiffedCheckpoint(cs, {
            firstBaseline: false,
            autoApproved: true,
            baselineSource: pairing.source,
          }),
        );
        continue;
      }
    }

    // 4. Engine diff against the paired image, masked by THIS checkpoint's
    //    variation regions plus the run's temp regions.
    const allRegions = dedupeRegions([
      ...(variationRegions.get(cs.testVariationId) ?? []),
      ...tempRegions,
    ]);

    const baselineBytes = await deps.storage.get(baselineShot.imageKey);
    const candidateBytes = await deps.storage.get(cs.imageKey);
    const candidateDom = cs.domKey
      ? new TextDecoder().decode(await deps.storage.get(cs.domKey))
      : undefined;

    const candidateMeta = await sharp(Buffer.from(candidateBytes)).metadata();
    const bounds = {
      width: candidateMeta.width ?? 0,
      height: candidateMeta.height ?? 0,
    };

    // Dynamic-text regions: OCR the candidate crop, evaluate the regex,
    // and only inject matched regions into the mask. Unmatched regions
    // fall through to L1 (catching real visual diffs). Skipped entirely
    // when the project doesn't have the feature flag on — tesseract.js
    // stays unloaded.
    const dynamicTextResults = project.dynamicTextEnabled
      ? await evaluateDynamicTextRegions(
          Buffer.from(candidateBytes),
          allRegions,
          logger,
        )
      : [];
    const matchedIndexes = new Set(
      dynamicTextResults.filter((r) => r.matched).map((r) => r.regionIndex),
    );
    for (const dtr of dynamicTextResults) {
      deps.metrics?.dynamicTextMatch
        .labels({
          outcome:
            dtr.ocrText === null
              ? "ocr_failed"
              : dtr.matched
                ? "matched"
                : "unmatched",
        })
        .inc();
    }
    if (dynamicTextResults.length > 0) {
      dynamicTextAudits.push({
        viewport: cs.viewport ?? null,
        screenshotId: cs.id,
        regions: allRegions,
        results: dynamicTextResults,
      });
    }

    // Resolve any selector-anchored regions against the candidate's
    // element-map sidecar. Best-effort: every failure path returns the
    // stored bbox. The per-job cache is shared across viewports.
    const resolvedIgnoreAreas = await Promise.all(
      allRegions
        .map((r, i) => ({ r, i }))
        .filter(({ r, i }) => {
          // cs.viewport null (legacy v0.4 row) → ?? makes equality self-referential
          // → all tagged regions apply, matching the no-viewport-tag legacy compat.
          if (r.viewport && r.viewport !== (cs.viewport ?? r.viewport))
            return false;
          // Per-region mask dispatch — see
          // furan-design/specs/2026-05-23-region-modes-design.md.
          //
          // strict: never masked. The region is a constraint ("must
          // match here"), not an exclusion. Per-region tolerance
          // (`thresholdOverride`) is captured on the wire but the
          // engine doesn't yet honor it — until then, strict is pure
          // metadata.
          //
          // layout + content: behave like `ignore` at L1 — mask the
          // pixel diff inside the bbox (ADR-047). Storing distinct kinds
          // means the wire shape correctly reflects the reviewer's intent
          // without a separate diff pass. Strict breaches are
          // post-filtered via `strictBreaches` below.
          //
          // dynamic-text: existing behavior — mask only when OCR
          // matched. Unmatched dynamic-text regions fall through to L1.
          //
          // ignore (default): always mask.
          if (r.kind === "strict") return false;
          if (r.kind === "dynamic-text") return matchedIndexes.has(i);
          return true;
        })
        .map(async ({ r }) => {
          const resolved = await resolveRegionBbox(
            r,
            cs.elementMapKey ?? null,
            bounds,
            elementMapCache,
            {
              storage: deps.storage,
              logger,
              onOutcome: (outcome) =>
                deps.metrics?.regionResolution.labels({ outcome }).inc(),
            },
          );
          return inflateRegion(
            {
              x: resolved.x,
              y: resolved.y,
              width: resolved.width,
              height: resolved.height,
              paddingPx: r.paddingPx,
            },
            bounds,
          );
        }),
    );

    // Image-first (ADR-047): matchLevel no longer routes tiers — every value
    // maps to the single image compare. We still read the stored per-screenshot
    // matchLevel (fallback "Strict" for legacy rows) and pass it through for
    // back-compat, but configForMatchLevel now returns the base engine config
    // unchanged.
    const screenshotMatchLevel = (cs.matchLevel as MatchLevel) ?? "Strict";
    const baseEngineConfig = parseEngineConfig(
      project.imageComparisonConfig,
      logger,
      project.id,
    );
    const routedEngineConfig = configForMatchLevel(
      baseEngineConfig,
      screenshotMatchLevel,
    );

    let result: Awaited<ReturnType<typeof runDiff>>;
    let vlmDescription: string | undefined;
    if (project.imageComparison === "vlm") {
      const vlmConfigJson = project.imageComparisonConfig;
      let vlmConfig: VlmProviderConfig;
      try {
        vlmConfig = vlmConfigJson
          ? JSON.parse(vlmConfigJson)
          : DEFAULT_VLM_CONFIG;
      } catch {
        vlmConfig = DEFAULT_VLM_CONFIG;
      }
      const t0 = performance.now();
      const vlmResult = await runVlm(
        Buffer.from(baselineBytes),
        Buffer.from(candidateBytes),
        {
          provider: resolveVlmProvider(vlmConfig),
          config: vlmConfig,
          engineConfig: routedEngineConfig,
          diffThreshold,
          ignoreAreas: resolvedIgnoreAreas,
        },
      );
      result = {
        passed: vlmResult.passed,
        diffPercent: vlmResult.diffPercent,
        pixelMismatchCount: vlmResult.pixelMismatchCount,
        diffImageBytes: vlmResult.diffImageBytes,
        regions: [],
        ranTiers: ["l1"],
        durationMs: { l1: performance.now() - t0 },
      };
      // A provider SDK error can echo request details; never let the
      // project's API key reach the persisted description or the logs.
      const apiKey = (vlmConfig as { apiKey?: unknown }).apiKey;
      vlmDescription =
        vlmResult.vlmDescription === undefined
          ? undefined
          : redactSecret(vlmResult.vlmDescription, apiKey);
      if (vlmResult.vlmError) {
        // The VLM layer fell back to the L1 verdict — surface it as a metric
        // + warn so a provider outage is alertable, not just buried in the
        // persisted description.
        deps.metrics?.vlmFailures
          .labels({ reason: vlmResult.vlmError.reason })
          .inc();
        logger.warn(
          {
            runId: data.runId,
            projectId: data.projectId,
            reason: vlmResult.vlmError.reason,
            detail: redactSecret(vlmResult.vlmError.message, apiKey),
          },
          "vlm_fallback_to_l1",
        );
      }
    } else {
      result = await runDiff({
        baseline: {
          image: Buffer.from(baselineBytes),
        },
        candidate: {
          image: Buffer.from(candidateBytes),
        },
        ignoreDisplacements: cs.ignoreDisplacements,
        l1DisplacementMetric: {
          labels: (l) => ({
            inc: () => deps.metrics?.l1Displacement.labels(l).inc(),
          }),
        },
        config: {
          // Per-run override (set via the in-viewer sensitivity slider) wins
          // over the project default. Null/undefined means "inherit," so the
          // existing project setting still drives every run that hasn't been
          // tuned by hand.
          diffThreshold,
          ignoreAreas: resolvedIgnoreAreas,
          engine: project.imageComparison,
          // Engine config (matchLevel no longer adjusts it — ADR-047).
          engineConfig: routedEngineConfig,
        },
      });
    }

    // Tier 2.5: when the checkpoint opted into
    // accessibility validation (cs.accessibilityLevel set), run
    // axe-core against the captured DOM HTML and append the
    // violations to the result regions before classification +
    // persistence. WCAG-version defaults to 2.1 when only the level
    // is set (so callers can opt in with just a level).
    if (cs.accessibilityLevel && candidateDom !== undefined) {
      try {
        const axeRegions = await runAxe(candidateDom, {
          level: cs.accessibilityLevel as "AA" | "AAA",
          version:
            (cs.accessibilityVersion as "WCAG_2_0" | "WCAG_2_1" | null) ??
            "WCAG_2_1",
        });
        result.regions = [...result.regions, ...classifyRegions(axeRegions)];
      } catch (err) {
        logger.warn(
          { err, screenshotId: cs.id, level: cs.accessibilityLevel },
          "axe_core_run_failed",
        );
      }
    } else if (cs.accessibilityLevel && candidateDom === undefined) {
      logger.warn(
        { screenshotId: cs.id, level: cs.accessibilityLevel },
        "accessibility_check_requested_but_no_dom_payload",
      );
    }

    // --- Region modes v2 engine pipeline (after L1, before persist) ---
    //
    // Fetch the candidate element-map sidecar. Used by resolveAxeBboxes (axe
    // violation bbox localization) and resolveRegionBbox (reviewer Layout/Content
    // region resolution). Best-effort: missing map leaves bbox: {0,0,0,0} for axe
    // regions; the dashboard handles that by showing the violation in the side
    // panel only.
    const elementMapKey = cs.elementMapKey ?? null;
    let elementMap: ElementMap | null = null;
    if (elementMapKey) {
      const cached = elementMapCache.get(elementMapKey);
      if (cached !== undefined) {
        elementMap = cached;
      } else {
        elementMap = await fetchElementMap(elementMapKey, {
          storage: deps.storage,
          logger,
          onOutcome: (outcome) =>
            deps.metrics?.regionResolution.labels({ outcome }).inc(),
        });
        elementMapCache.set(elementMapKey, elementMap);
      }
    }
    // ADR-053: for the Layout match level, also fetch the BASELINE element map
    // so the layout pass can compare each element's geometry across
    // baseline↔candidate. Gated on Layout to avoid a wasted storage GET on
    // Strict checkpoints. Shares the per-job elementMapCache (distinct keys).
    let baselineElementMap: ElementMap | null = null;
    if (screenshotMatchLevel === "Layout") {
      const baselineElementMapKey = baselineShot.elementMapKey ?? null;
      if (baselineElementMapKey) {
        const cachedBaseline = elementMapCache.get(baselineElementMapKey);
        if (cachedBaseline !== undefined) {
          baselineElementMap = cachedBaseline;
        } else {
          baselineElementMap = await fetchElementMap(baselineElementMapKey, {
            storage: deps.storage,
            logger,
            onOutcome: (outcome) =>
              deps.metrics?.regionResolution.labels({ outcome }).inc(),
          });
          elementMapCache.set(baselineElementMapKey, baselineElementMap);
        }
      }
    }
    // Tier 2.5 close-out: resolve axe violation bboxes via the candidate DOM +
    // element-map sidecar. Mutates any source='axe' regions already appended to
    // result.regions in the Tier 2.5 block above. Misses leave bbox:{0,0,0,0};
    // the dashboard already handles those by showing the violation in the side
    // panel only.
    resolveAxeBboxes(result.regions, candidateDom, elementMap, {
      axeResolution: {
        labels: (l) => ({
          inc: () => deps.metrics?.axeResolution.labels(l).inc(),
        }),
      },
    });

    // Resolve this checkpoint's auto-rule selectors against its DOM +
    // element-map sidecar, producing an engine-shaped map keyed by the rule
    // selector string. Done here (not in the engine) because matching needs a
    // real DOM — esp. attribute selectors the cssPath keys can't express.
    const ruleElementMap: RulesElementMap =
      ruleSelectors.length > 0
        ? resolveRuleSelectorElementMap(
            ruleSelectors,
            candidateDom,
            elementMap,
            {
              rulesSelectorResolution: {
                labels: (l) => ({
                  inc: () =>
                    deps.metrics?.rulesSelectorResolution.labels(l).inc(),
                }),
              },
            },
          )
        : [];

    let strictFailed = false;
    // Strict tolerance post-filter. Decode the diff image once
    // per viewport (sharp is cheap on PNG → raw RGBA). Any region
    // breaching its tolerance becomes a synthetic "breaking" region
    // AND forces `passed: false`.
    const strictInputs: StrictRegionInput[] = await Promise.all(
      allRegions
        .filter((r) => r.kind === "strict")
        .filter(
          (r) => !r.viewport || r.viewport === (cs.viewport ?? r.viewport),
        )
        .map(async (r) => ({
          resolved: await resolveRegionBbox(
            r,
            elementMapKey,
            bounds,
            elementMapCache,
            {
              storage: deps.storage,
              logger,
              onOutcome: (outcome) =>
                deps.metrics?.regionResolution.labels({ outcome }).inc(),
            },
          ),
          ...(r.thresholdOverride !== undefined
            ? { thresholdOverride: r.thresholdOverride }
            : {}),
        })),
    );
    if (strictInputs.length > 0 && result.diffImageBytes.length > 0) {
      try {
        const raw = await sharp(result.diffImageBytes).raw().toBuffer({
          resolveWithObject: true,
        });
        const breaches = strictBreaches(strictInputs, {
          data: raw.data,
          info: { width: raw.info.width, height: raw.info.height },
        });
        for (const b of breaches) {
          result.regions.push({
            id: `strict-${b.bbox.x}-${b.bbox.y}-${b.bbox.width}-${b.bbox.height}`,
            severity: "breaking",
            category: "layout",
            bbox: b.bbox,
            description: `Strict region exceeded tolerance: ${(b.fraction * 100).toFixed(3)}% > ${(b.threshold * 100).toFixed(3)}%`,
            source: "l1", // synthesised from the L1 diff image
          });
        }
        if (breaches.length > 0) {
          result.passed = false;
          strictFailed = true;
        }
      } catch (err) {
        logger.warn(
          { err, runId: data.runId },
          "strict_tolerance_decode_failed",
        );
      }
    }

    // --- Layout match level (ADR-053): deterministic content/color suppression ---
    // Detect is deterministic; Explain is probabilistic — no model touches this
    // gate. For each L1 pixel cluster: a cluster inside a geometrically-unchanged
    // element is content/color-only → suppress (pass); a cluster over a
    // moved/resized/added element, or inside no element, is kept (fail).
    // Fail-closed: a missing element map degrades the checkpoint to Strict.
    // Only the pixel engines emit l1_pixel clusters; VLM has its own judgment.
    if (
      screenshotMatchLevel === "Layout" &&
      project.imageComparison !== "vlm"
    ) {
      const clusters = result.regions.filter((r) => r.source === "l1_pixel");
      if (clusters.length > 0 && (!elementMap || !baselineElementMap)) {
        // Degrade to Strict: leave result.passed as the engine computed it.
        clusters.forEach(() =>
          deps.metrics?.layoutResolution
            .labels({ outcome: "degraded_no_map" })
            .inc(),
        );
        for (const c of clusters) {
          c.description = `[Layout→Strict: no element map] ${c.description}`;
        }
        logger.warn(
          { runId: data.runId, viewport: viewportKey, screenshotId: cs.id },
          "layout_degraded_no_element_map",
        );
      } else if (clusters.length > 0) {
        const verdicts = classifyLayoutClusters(
          clusters.map((c) => c.bbox),
          elementMap,
          baselineElementMap,
        );
        const nonClusters = result.regions.filter(
          (r) => r.source !== "l1_pixel",
        );
        const retagged: typeof result.regions = [];
        let keptCount = 0;
        clusters.forEach((c, i) => {
          const v = verdicts[i]!;
          deps.metrics?.layoutResolution.labels({ outcome: v.reason }).inc();
          const where = v.selector ? ` [${v.selector}]` : "";
          if (v.decision === "suppress") {
            retagged.push({
              ...c,
              source: "layout_suppressed",
              category: "layout",
              severity: "none",
              description: `Layout: stable element — suppressed (content/color only)${where}`,
            });
          } else {
            keptCount++;
            retagged.push({
              ...c,
              source: "layout_kept",
              category: "layout",
              description: `Layout: ${v.reason}${where}`,
            });
          }
        });
        result.regions = [...nonClusters, ...retagged];
        // Layout passes iff no cluster is kept AND strict didn't fail. The
        // global diffPercent gate is intentionally replaced — a recolored hero
        // is a large pixel diff but a stable bbox, so it passes.
        const layoutPasses = keptCount === 0 && !strictFailed;
        // Fail-closed at the L1 cluster cap (keep in sync with
        // l1-region-extractor maxRegions = 12): if it would pass but the cap
        // was hit with pixels still mismatching, unseen clusters might be
        // structural, so we cannot prove a pass.
        if (
          layoutPasses &&
          clusters.length >= 12 &&
          result.pixelMismatchCount > 0
        ) {
          deps.metrics?.layoutResolution
            .labels({ outcome: "cluster_cap_uncertain" })
            .inc();
          result.passed = false;
        } else {
          result.passed = layoutPasses;
        }
      }
    }
    // --- End region modes v2 pipeline ---

    // Observe L1 latency labelled by engine. Image-first (ADR-047): L1
    // always runs, so we always record. Convert ms to seconds to match the
    // histogram's seconds-based bucket boundaries and the OpenMetrics
    // convention.
    deps.metrics?.l1Duration
      .labels({ engine: project.imageComparison })
      .observe(result.durationMs.l1 / 1000);

    let diffImageKey: string | null = null;
    if (result.diffImageBytes.length > 0) {
      diffImageKey = objectKey(result.diffImageBytes);
      await deps.storage.put(diffImageKey, result.diffImageBytes, "image/png");
    }

    checkpoints.push({
      screenshotId: cs.id,
      viewport: viewportKey,
      passed: result.passed,
      diffPercent: result.diffPercent,
      pixelMismatchCount: result.pixelMismatchCount,
      diffImageKey,
      regions: result.regions.map((r) => ({
        severity: r.severity,
        category: r.category,
        bbox: r.bbox,
        description: r.description,
        source: r.source,
        viewport: viewportKey,
        // v1.1.20: tag each region with the candidate screenshot that
        // produced it so the dashboard can show only the current
        // checkpoint's regions. Before this, two checkpoints sharing a
        // viewport in one run (HomePage + searchResult both at
        // 1280x720) saw each other's regions overlaid in the diff
        // viewer.
        screenshotId: cs.id,
      })),
      ranTiers: result.ranTiers,
      firstBaseline: false,
      autoApproved: false,
      baselineSource: pairing.source,
      vlmDescription,
      diffSignature: computeCheckpointSignature(result.regions, bounds),
      ruleElementMap,
    });
  }

  // ── Auto Rules evaluation ───────────────────────────────────
  let rulesResult: EvaluationResult | null = null;

  try {
    if (projectRules.length > 0) {
      const ruleT0 = performance.now();
      const { matchers, conditions } = createDefaultRegistries();
      const compiled = compileRules(
        projectRules as AutoRule[],
        matchers,
        conditions,
      );

      // evaluateCompiled is synchronous CPU work (no I/O), so a plain map is
      // correct — Promise.all here would only add microtask overhead.
      const perVpResults = checkpoints.map((vp, vpIdx) => {
        if (vp.regions.length === 0) {
          return {
            decisions: [],
            counts: { auto_approve: 0, flag: 0, unmatched: 0 },
            diagnostics: {
              evaluatedRules: 0,
              matchedRules: 0,
              skippedBecauseNoElementMap: 0,
              selectorMisses: 0,
              durationMs: 0,
            },
          };
        }

        const ruleRegions: RulesDiffRegion[] = vp.regions.map((r, i) => ({
          id: regionEngineId(vpIdx, i),
          severity: r.severity,
          category: r.category,
          bbox: r.bbox as {
            x: number;
            y: number;
            width: number;
            height: number;
          },
          description: r.description ?? "",
          source: r.source,
          // NOTE: this is the viewport-level diff %, not a per-region value
          // (the engine does not yet emit per-region diff). The maxDiff
          // condition therefore compares against the whole-viewport diff.
          // Revisit when per-region diff % is available.
          diffPercent: vp.diffPercent,
        }));

        return evaluateCompiled({
          diffRegions: ruleRegions,
          // Selectors resolved against this checkpoint's DOM + element-map
          // during the loop; null when the SDK shipped no DOM/map sidecar.
          elementMap: vp.ruleElementMap ?? null,
          ruleset: compiled,
        });
      });

      const allDecisions = perVpResults.flatMap((r) => r.decisions);
      const allCounts = summarizeDecisions(allDecisions);

      rulesResult = {
        decisions: allDecisions,
        counts: allCounts,
        diagnostics: {
          evaluatedRules: compiled.rules.length,
          matchedRules: allDecisions.reduce(
            (n, d) => n + d.matchedRules.length,
            0,
          ),
          skippedBecauseNoElementMap: perVpResults.reduce(
            (n, r) => n + r.diagnostics.skippedBecauseNoElementMap,
            0,
          ),
          selectorMisses: perVpResults.reduce(
            (n, r) => n + r.diagnostics.selectorMisses,
            0,
          ),
          durationMs: performance.now() - ruleT0,
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
        deps.metrics?.rulesMatched
          .labels({ action: "flag" })
          .inc(allCounts.flag);

      logger.info(
        {
          runId: data.runId,
          rulesCompiled: compiled.rules.length,
          regionsEvaluated: allDecisions.length,
          matched: rulesResult.diagnostics.matchedRules,
          autoApproved: allCounts.auto_approve,
          flagged: allCounts.flag,
          durationMs: rulesResult.diagnostics.durationMs,
        },
        "rules evaluated",
      );
    }
  } catch (err) {
    logger.error(
      { err, runId: data.runId, projectId: data.projectId },
      "rules-engine evaluation failed; proceeding without rule decisions",
    );
    deps.metrics?.rulesEvaluationErrors.inc();
    rulesResult = null;
  }

  // Per-checkpoint outcome after auto-rules + resolution attribution (see
  // rules-aggregation.ts for the exact rules and its unit tests). Each
  // checkpoint's verdict (spec §3): no baseline image → `new`; otherwise
  // `unresolved` if it still fails after rules, else `passed`. The diff-worker
  // never writes `failed` (reviewer-rejected only) and never writes the run
  // status: `recomputeRunStatus` derives it from these verdicts and any active
  // decisions, so a reviewer's decision survives every re-diff.
  const statusInputs = checkpoints.map((c) => ({
    passed: c.passed,
    regionCount: c.regions.length,
  }));
  const failures = checkpointFailures(statusInputs, rulesResult);
  const { aggregateFailed, resolutionSource } = aggregateRuleStatus(
    statusInputs,
    rulesResult,
  );
  const results: CheckpointResult[] = checkpoints.map((c, i) => ({
    ...c,
    verdict: c.firstBaseline ? "new" : failures[i] ? "unresolved" : "passed",
  }));

  // Run aggregates on the single test_runs row:
  // - diffPercent: MAX across checkpoints (surfaces the worst one); NULL when
  //   no checkpoint had a baseline to compare against (nothing was compared).
  // - pixelMisMatchCount: SUM across checkpoints (NULL likewise).
  // - diffName: overlay key of the checkpoint with max diffPercent (or null).
  // - baselineSource: tier of the worst checkpoint that resolved a baseline
  //   (first such checkpoint on ties); null when none resolved one.
  const compared = results.some((r) => !r.firstBaseline);
  const aggregateDiffPercent = results.reduce(
    (m, v) => (v.diffPercent > m ? v.diffPercent : m),
    0,
  );
  const aggregatePixelMismatch = results.reduce(
    (s, v) => s + v.pixelMismatchCount,
    0,
  );
  const worstOf = (rs: CheckpointResult[]) =>
    rs.reduce<CheckpointResult | null>(
      (acc, v) => (acc === null || v.diffPercent > acc.diffPercent ? v : acc),
      null,
    );
  const aggregateDiffName = worstOf(results)?.diffImageKey ?? null;
  const runBaselineSource =
    worstOf(results.filter((r) => r.baselineSource !== null))?.baselineSource ??
    null;
  const aggregateRegions = results.flatMap((v) => v.regions);
  const aggregateVlmDescription =
    results.find((v) => v.vlmDescription)?.vlmDescription ?? null;
  const allAutoApproved = results.every((r) => r.autoApproved);

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

    // Per checkpoint: its verdict (spec §3) and its ADR-042 signature for
    // build-scoped grouping (null when it was not diffed or had no meaningful
    // regions → "ungrouped"). A re-diff rewrites both.
    for (const r of results) {
      await tx
        .update(screenshots)
        .set({
          diffSignature: r.diffSignature,
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
    const autoApproved = results
      .filter((r) => r.autoApproved)
      .map((r) => candidateById.get(r.screenshotId)!)
      .sort((a, b) =>
        a.testVariationId < b.testVariationId
          ? -1
          : a.testVariationId > b.testVariationId
            ? 1
            : 0,
      );
    for (const cs of autoApproved) {
      await recordBaseline(tx, {
        testVariationId: cs.testVariationId,
        testRunId: run.id,
        imageKey: cs.imageKey,
        runName: run.baselineName ?? run.name,
        branchName: run.branchName,
      });
    }

    // Synthetic audit rows for dynamic-text OCR decisions (matched OR
    // unmatched). `source="dynamic_text"` + `ocr_text`/`ocr_matched`
    // distinguish these from real diff regions; severity is always
    // "none" so they're hidden from the default RegionListPanel view.
    const auditValues = dynamicTextAudits.flatMap(
      ({ viewport, screenshotId, regions, results: ocrResults }) =>
        ocrResults.map((dt) => {
          const r = regions[dt.regionIndex]!;
          const preview = (dt.ocrText ?? "").slice(0, 80);
          return {
            runId: data.runId,
            projectId: data.projectId,
            screenshotId,
            severity: "none",
            category: "text",
            bbox: { x: r.x, y: r.y, width: r.width, height: r.height },
            description: dt.matched
              ? `Dynamic text matched: "${preview}"`
              : `Dynamic text did NOT match: "${preview}"`,
            source: "dynamic_text",
            viewport,
            ocrText: dt.ocrText,
            ocrMatched: dt.matched,
          };
        }),
    );
    if (auditValues.length > 0) {
      await tx.insert(diffRegions).values(auditValues);
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

function dedupeRegions(rs: ParsedIgnoreArea[]): ParsedIgnoreArea[] {
  const seen = new Set<string>();
  const out: ParsedIgnoreArea[] = [];
  for (const r of rs) {
    const key = `${r.x}:${r.y}:${r.width}:${r.height}:${r.viewport ?? ""}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(r);
    }
  }
  return out;
}

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

/**
 * Per-region padding (spec §3.3) is applied by the worker — the diff-engine
 * remains padding-agnostic. Inflates the bbox by `paddingPx` on all sides
 * and clamps at the screenshot bounds so the engine never sees negative
 * coordinates or out-of-image widths.
 */
export function inflateRegion(
  r: {
    x: number;
    y: number;
    width: number;
    height: number;
    paddingPx?: number;
  },
  bounds: { width: number; height: number },
): { x: number; y: number; width: number; height: number } {
  const p = r.paddingPx ?? 0;
  if (p === 0) return { x: r.x, y: r.y, width: r.width, height: r.height };
  const x = Math.max(0, r.x - p);
  const y = Math.max(0, r.y - p);
  const right = Math.min(bounds.width, r.x + r.width + p);
  const bottom = Math.min(bounds.height, r.y + r.height + p);
  return {
    x,
    y,
    width: Math.max(0, right - x),
    height: Math.max(0, bottom - y),
  };
}
