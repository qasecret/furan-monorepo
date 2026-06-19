import {
  baselines,
  desc,
  diffRegions,
  eq,
  projects,
  resolveBaseline,
  screenshots,
  testRuns,
  testVariations,
  withProjectScope,
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
  type EngineConfig,
  type MatchLevel,
  type Severity,
  type VlmProvider,
  type VlmProviderConfig,
} from "@furan/diff-engine";
import type { DiffJob } from "@furan/queue";
import { objectKey, type Storage } from "@furan/storage";
import type { Telemetry } from "@furan/telemetry";
import type { Redis } from "ioredis";
import sharp from "sharp";
import { z } from "zod";

import { resolveAxeBboxes } from "./axe-bbox-resolver.js";
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
import { computePrimarySignature } from "./primary-signature.js";
import { strictBreaches, type StrictRegionInput } from "./strict-tolerance.js";

const engineConfigSchema = z.object({
  threshold: z.number().min(0).max(1).default(DEFAULT_ENGINE_CONFIG.threshold),
  ignoreAntialiasing: z
    .boolean()
    .default(DEFAULT_ENGINE_CONFIG.ignoreAntialiasing),
  allowDiffDimensions: z
    .boolean()
    .default(DEFAULT_ENGINE_CONFIG.allowDiffDimensions),
});

function parseEngineConfig(
  raw: string | null | undefined,
  logger: { warn: (obj: object, msg: string) => void },
  projectId: string,
): EngineConfig {
  if (!raw) return DEFAULT_ENGINE_CONFIG;
  try {
    const parsed = JSON.parse(raw);
    return engineConfigSchema.parse(parsed);
  } catch (err) {
    logger.warn(
      {
        projectId,
        rawTruncated: raw.slice(0, 200),
        error: err instanceof Error ? err.message : String(err),
      },
      "image_comparison_config_invalid_falling_back_to_defaults",
    );
    return DEFAULT_ENGINE_CONFIG;
  }
}

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

interface PerViewportResult {
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
  ranTiers: Array<"l1" | "l2">;
  firstBaseline: boolean;
  vlmDescription?: string | undefined;
  /** ADR-042: the candidate screenshot (checkpoint) this result is for, and
   * its computed diff signature. Set only on the paired-baseline (diffed) path
   * — pass OR unresolved; the no-baseline/first-baseline path leaves them
   * undefined. */
  screenshotId?: string;
  diffSignature?: string | null;
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
    .select({ testRunId: baselines.testRunId })
    .from(baselines)
    .where(eq(baselines.testVariationId, variationId))
    .orderBy(desc(baselines.createdAt))
    .limit(10);

  if (pastBaselines.length <= 1) return false;

  const candidateBytes = await storage.get(candidateImageKey);
  if (!candidateBytes) return false;

  for (const bl of pastBaselines.slice(1)) {
    try {
      const blScreenshot = await db
        .select({ imageKey: screenshots.imageKey })
        .from(screenshots)
        .where(eq(screenshots.runId, bl.testRunId))
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
    } catch {
      continue;
    }
  }
  return false;
}

/**
 * Phase 2 diff handler (v0.5 multi-viewport): looks up project + candidate
 * run, then for each candidate screenshot (one per viewport) resolves the
 * baseline via the three-tier `resolveBaseline` chain, matches the
 * same-viewport baseline screenshot, and runs the image diff. When no
 * matching baseline screenshot exists for a viewport (new viewport added
 * since the baseline was captured) the viewport is treated as a
 * first-baseline (passes with 0% diff for that viewport).
 *
 * Aggregation rolled back to the single `test_runs` row:
 *   status        = "unresolved" if ANY viewport failed; else "passed"
 *                   (per spec §3.2 the diff-worker NEVER writes "failed";
 *                   "failed" is reserved for reviewer-rejected runs.)
 *   diffPercent   = MAX(per-viewport diffPercent) — surfaces the worst
 *                   viewport for at-a-glance triage. Per-viewport breakdown
 *                   is recoverable from `diff_regions.viewport`.
 *   pixelMisMatchCount = SUM(per-viewport pixelMismatchCount)
 *   diffName      = imageKey of the worst (max diffPercent) viewport's
 *                   overlay; null if no overlay produced anywhere.
 *   baselineSource = baseline.source from the chain (same for all viewports
 *                   of a run; the chain resolves per variation + branch).
 *
 * Backwards compatibility: when the candidate run has a single screenshot
 * with NULL viewport (legacy v0.4 row), the loop runs exactly once and the
 * inserted `diff_regions` rows carry NULL viewport — matching pre-v0.5
 * behavior.
 *
 * Preserved from T9: publishes a terminal `run.completed` event after
 * `diff.completed` so the integrations subscriber (GitHub flow + webhook
 * flow) can fan out.
 */
export async function handleDiffJob(
  data: DiffJob,
  logger: Logger,
  deps: HandlerDeps,
): Promise<void> {
  try {
    await handleDiffJobInner(data, logger, deps);
  } catch (err) {
    // Always log the primary error first. BullMQ stashes it in the job's
    // failedReason but the worker's own structured log was previously
    // silent — a class of bug (e.g. odiff spawn-fail on a base-image
    // GLIBC mismatch) would aborted-bucket every run with zero clue in
    // dashboards or stdout. The secondary catches below only log when
    // their own write fails, so this is the only place the actual cause
    // surfaces in the worker log stream.
    logger.error(
      { err, runId: data.runId, projectId: data.projectId },
      "diff_job_failed",
    );
    // Best-effort terminal status write so an aborted run does not hang
    // in `running` indefinitely. Per spec §3.2 worker exceptions land as
    // `aborted` (distinct from reviewer-rejected `failed`). Wrap in its
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

async function handleDiffJobInner(
  data: DiffJob,
  logger: Logger,
  deps: HandlerDeps,
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

  // ADR-038: testVariationId is no longer stored on test_runs — it lives on
  // each screenshots row (one checkpoint = one variation). Resolve the
  // primary variation from the first screenshot so we can locate the
  // baseline and read per-variation ignore regions.
  const firstShotRow = await deps.db
    .select({ testVariationId: screenshots.testVariationId })
    .from(screenshots)
    .where(eq(screenshots.runId, data.runId))
    .limit(1);
  if (!firstShotRow[0]) {
    throw new Error(`run_has_no_screenshots:${data.runId}`);
  }
  const runTestVariationId = firstShotRow[0].testVariationId;

  const baseline = await resolveBaseline(
    deps.db,
    data.projectId,
    run.branchName,
    runTestVariationId,
    {
      defaultBranch: project.mainBranchName,
      parentPrBaseBranch: data.parentPrBaseBranch ?? null,
    },
  );

  if (!baseline) {
    // First-baseline: no prior baseline existed for this variation+branch.
    // Two paths, gated on `project.autoApproveFeature` (ADR-036):
    //
    //   autoApproveFeature = true  → auto-seed: candidate becomes the
    //     baseline atomically. `userId = NULL` marks it as auto. The wire
    //     status stays `new` and the SDK reports it as a pass via the
    //     `autoApproved=true` derived flag. Opt-in for projects that want
    //     to keep the pre-ADR-036 behavior on existing CI.
    //
    //   autoApproveFeature = false → manual-approve required: no
    //     baselines row inserted, status stays `new`. The dashboard
    //     renders its "No baseline yet — Save as baseline" CTA and the
    //     user explicitly approves to create the baseline. Matches the
    //     legacy backend's first-run semantics and is the column default
    //     for projects created after migration 0016.
    //
    // Either way: status=new, merge=true, emit the same SSE events; the
    // only difference is whether a `baselines` row gets written here.
    const seedBaseline = project.autoApproveFeature === true;
    await withProjectScope(deps.db, data.projectId, async (tx) => {
      await tx
        .update(testRuns)
        .set({ status: "new", merge: true })
        .where(eq(testRuns.id, data.runId));
      if (seedBaseline) {
        await tx.insert(baselines).values({
          baselineName: run.baselineName ?? run.name ?? "auto",
          testVariationId: runTestVariationId,
          testRunId: run.id,
          // userId omitted → defaults to NULL → signals auto-baseline.
          ...(run.branchName ? { branchName: run.branchName } : {}),
        });
      }
    });
    await deps.redis.publish(
      `run:${data.runId}:events`,
      JSON.stringify({
        type: "diff.completed",
        runId: data.runId,
        passed: seedBaseline,
        firstBaseline: true,
        autoApproved: seedBaseline,
      }),
    );
    await deps.redis.publish(
      `run:${data.runId}:events`,
      JSON.stringify({
        type: "run.completed",
        runId: data.runId,
        projectId: data.projectId,
        status: "new",
        diffPercent: 0,
        branchName: run.branchName,
        numChanges: 0,
      }),
    );
    await publishProjectRunUpdate(
      deps,
      {
        projectId: data.projectId,
        runId: data.runId,
        status: "new",
        buildId: run.buildId,
      },
      logger,
    );
    logger.info(
      { runId: data.runId, firstBaseline: true, autoSeeded: seedBaseline },
      "diff_completed_first_baseline",
    );
    return;
  }

  const baselineRow = await deps.db.query.baselines.findFirst({
    where: eq(baselines.id, baseline.baselineId),
  });
  if (!baselineRow?.testRunId) {
    throw new Error(`baseline_has_no_run:${baseline.baselineId}`);
  }

  // Pull all screenshots for both runs and group by viewport. With v0.5
  // multi-viewport captures, expect N rows per run (one per viewport); with
  // legacy v0.4 single-viewport runs, expect 1 row with NULL viewport — the
  // loop below collapses to the same single-pair flow.
  const baselineShots = await deps.db.query.screenshots.findMany({
    where: eq(screenshots.runId, baselineRow.testRunId),
  });
  const candidateShots = await deps.db.query.screenshots.findMany({
    where: eq(screenshots.runId, data.runId),
  });
  if (candidateShots.length === 0) {
    throw new Error(`missing_screenshot:candidate=0`);
  }
  if (baselineShots.length === 0) {
    throw new Error(`missing_screenshot:baseline=0`);
  }

  const baselineByViewport = new Map<
    string | null,
    (typeof baselineShots)[0]
  >();
  for (const bs of baselineShots) {
    // Use null key for legacy NULL-viewport rows (v0.4 single-viewport).
    baselineByViewport.set(bs.viewport ?? null, bs);
  }

  // ADR-032: pre-engine auto-approve. If the project has the feature
  // enabled and every candidate viewport's image hash matches its
  // baseline counterpart, short-circuit the image diff entirely. Write
  // the run row, insert a baselines row with userId=NULL (signal: auto),
  // publish the SSE events, and return.
  if (
    project.autoApproveFeature &&
    allHashesMatch(candidateShots, baselineByViewport)
  ) {
    await withProjectScope(deps.db, data.projectId, async (tx) => {
      await tx
        .update(testRuns)
        .set({
          status: "passed",
          diffPercent: 0,
          pixelMisMatchCount: 0,
          merge: true,
          baselineSource: baseline.source,
        })
        .where(eq(testRuns.id, data.runId));
      await tx.insert(baselines).values({
        baselineName: run.baselineName ?? run.name ?? "auto",
        testVariationId: runTestVariationId,
        testRunId: run.id,
        // userId omitted → defaults to NULL → signals auto-approve.
        ...(run.branchName ? { branchName: run.branchName } : {}),
      });
    });

    await deps.redis.publish(
      `run:${data.runId}:events`,
      JSON.stringify({
        type: "diff.completed",
        runId: data.runId,
        passed: true,
        diffPercent: 0,
        ranTiers: [],
        viewportCount: candidateShots.length,
        durationMs: Date.now() - t0,
        autoApproved: true,
      }),
    );
    await deps.redis.publish(
      `run:${data.runId}:events`,
      JSON.stringify({
        type: "run.completed",
        runId: data.runId,
        projectId: data.projectId,
        status: "passed",
        diffPercent: 0,
        branchName: run.branchName,
        numChanges: 0,
      }),
    );
    await publishProjectRunUpdate(
      deps,
      {
        projectId: data.projectId,
        runId: data.runId,
        status: "passed",
        buildId: run.buildId,
      },
      logger,
    );
    logger.info(
      { runId: data.runId, projectId: data.projectId, autoApproved: true },
      "diff_auto_approved",
    );
    return;
  }

  // Past-baseline auto-approve: if the project has auto-approve enabled
  // and hashes didn't match (we fell through the block above), check if
  // the candidate matches any of the 10 most recent older baselines.
  if (project.autoApproveFeature) {
    const diffThresholdForAutoApprove =
      run.diffThresholdOverride ?? project.diffThreshold ?? 0.001;
    const pastAutoApproved = await tryAutoApproveByPastBaselines(
      deps.db,
      deps.storage,
      runTestVariationId,
      candidateShots[0]!.imageKey,
      diffThresholdForAutoApprove,
      logger,
    );
    if (pastAutoApproved) {
      await withProjectScope(deps.db, data.projectId, async (tx) => {
        await tx
          .update(testRuns)
          .set({
            status: "passed",
            diffPercent: 0,
            pixelMisMatchCount: 0,
            merge: true,
            baselineSource: baseline.source,
          })
          .where(eq(testRuns.id, data.runId));
        await tx.insert(baselines).values({
          baselineName: run.baselineName ?? run.name ?? "auto",
          testVariationId: runTestVariationId,
          testRunId: run.id,
          ...(run.branchName ? { branchName: run.branchName } : {}),
        });
      });

      await deps.redis.publish(
        `run:${data.runId}:events`,
        JSON.stringify({
          type: "diff.completed",
          runId: data.runId,
          passed: true,
          diffPercent: 0,
          ranTiers: [],
          viewportCount: candidateShots.length,
          durationMs: Date.now() - t0,
          autoApproved: true,
        }),
      );
      await deps.redis.publish(
        `run:${data.runId}:events`,
        JSON.stringify({
          type: "run.completed",
          runId: data.runId,
          projectId: data.projectId,
          status: "passed",
          diffPercent: 0,
          branchName: run.branchName,
          numChanges: 0,
        }),
      );
      await publishProjectRunUpdate(
        deps,
        {
          projectId: data.projectId,
          runId: data.runId,
          status: "passed",
          buildId: run.buildId,
        },
        logger,
      );
      logger.info(
        {
          runId: data.runId,
          projectId: data.projectId,
          autoApproved: true,
          strategy: "past-baseline",
        },
        "diff_auto_approved_past_baseline",
      );
      return;
    }
  }

  // Per ADR-031: merge variation + run ignore areas. Both are JSON arrays
  // of {x,y,width,height,viewport?}. The viewport tag is filtered against
  // each candidate screenshot's viewport inside the per-viewport loop
  // below. Legacy rows without `viewport` apply universally.
  //
  // ADR-038: testVariationId is no longer on test_runs; use the variation
  // resolved from the first screenshot. Run-level ignoreAreas was removed
  // from test_runs, so only the variation's ignoreRegions apply.
  const variationRow = await deps.db.query.testVariations.findFirst({
    where: eq(testVariations.id, runTestVariationId),
  });
  // ignoreRegions is jsonb (already parsed by Drizzle); parseIgnoreAreas
  // handles both string and pre-parsed values.
  const variationRegions = parseIgnoreAreas(variationRow?.ignoreRegions) ?? [];
  const tempRegions = parseIgnoreAreas(run.tempIgnoreAreas) ?? [];
  const allRegions = dedupeRegions([...variationRegions, ...tempRegions]);
  const perViewport: PerViewportResult[] = [];
  // Per-viewport dynamic-text OCR audit. Each entry carries the viewport
  // string and the per-region OCR results, so we can persist a synthetic
  // audit row in `diff_regions` per (viewport, region) pair.
  const dynamicTextAudits: Array<{
    viewport: string | null;
    screenshotId: string;
    results: DynamicTextResult[];
  }> = [];
  // Per-job cache shared across viewports. Avoids refetching the same
  // element-map sidecar when multiple viewports of the same job carry
  // the same `elementMapKey` (rare) or when a single viewport's regions
  // all resolve against the same map (the common case).
  const elementMapCache = new Map<string, ElementMap | null>();

  for (const cs of candidateShots) {
    const viewportKey = cs.viewport ?? null;
    // Try exact viewport match first; for legacy v0.4 candidate (NULL),
    // fall back to any baseline screenshot so the pair-up still works.
    const baselineShot =
      baselineByViewport.get(viewportKey) ??
      (viewportKey === null ? baselineShots[0] : undefined);

    if (!baselineShot) {
      // New viewport added since baseline was captured — no pair to diff.
      // Treat as first-baseline for this viewport: pass with 0% diff and
      // skip the engine call.
      perViewport.push({
        viewport: viewportKey,
        passed: true,
        diffPercent: 0,
        pixelMismatchCount: 0,
        diffImageKey: null,
        regions: [],
        ranTiers: [],
        firstBaseline: true,
      });
      logger.info(
        {
          runId: data.runId,
          viewport: viewportKey,
        },
        "diff_viewport_no_baseline",
      );
      continue;
    }

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
          // layout + content: behave like `ignore` at L1 in v1 — mask
          // the pixel diff inside the bbox. Region-mode classification
          // for Layout/Content is handled by `classifyLayoutContent`
          // (reviewer-drawn regions) and strict breaches via
          // `strictBreaches`. L2 is removed (ADR-047); storing distinct
          // kinds means the wire shape correctly reflects the reviewer's
          // intent without a separate diff pass.
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
    const { config: routedEngineConfig } = configForMatchLevel(
      baseEngineConfig,
      screenshotMatchLevel,
    );

    const diffThreshold =
      run.diffThresholdOverride ?? project.diffThreshold ?? 0.001;

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
        durationMs: { l1: performance.now() - t0, l2: null },
      };
      vlmDescription = vlmResult.vlmDescription;
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
          // L2 is permanently disabled (image-first, ADR-047). The field
          // remains on ProjectDiffConfig (engine-type cleanup is a later task).
          l2Enabled: false,
          ignoreAreas: resolvedIgnoreAreas,
          engine: project.imageComparison,
          // Engine config (matchLevel no longer adjusts it — ADR-047).
          engineConfig: routedEngineConfig,
        },
      });
    }

    // Tier 2.5 (Eyes-parity): when the checkpoint opted into
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

    // Step B: classify diff regions against reviewer Layout/Content zones.
    // Step C: strict tolerance post-filter. Decode the diff image once
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
            source: "l1", // synthesised from L1 diff image; not an L2 op
          });
        }
        if (breaches.length > 0) {
          result.passed = false;
        }
      } catch (err) {
        logger.warn(
          { err, runId: data.runId },
          "strict_tolerance_decode_failed",
        );
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

    perViewport.push({
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
      vlmDescription,
      screenshotId: cs.id,
      diffSignature: computeCheckpointSignature(result.regions, bounds),
    });
  }

  // Aggregate per-viewport results to the single test_runs row.
  // - status: "unresolved" if any viewport failed (per spec §3.2 the
  //   diff-worker NEVER writes "failed" — that's reviewer-rejected only).
  // - diffPercent: MAX across viewports (surfaces the worst viewport).
  // - pixelMisMatchCount: SUM across viewports.
  // - diffName: overlay key of the viewport with max diffPercent (or null).
  const aggregateFailed = perViewport.some((v) => !v.passed);
  const aggregateDiffPercent = perViewport.reduce(
    (m, v) => (v.diffPercent > m ? v.diffPercent : m),
    0,
  );
  const aggregatePixelMismatch = perViewport.reduce(
    (s, v) => s + v.pixelMismatchCount,
    0,
  );
  const worst = perViewport.reduce<PerViewportResult | null>(
    (acc, v) => (acc === null || v.diffPercent > acc.diffPercent ? v : acc),
    null,
  );
  const aggregateDiffName = worst?.diffImageKey ?? null;
  const aggregateRegions = perViewport.flatMap((v) => v.regions);
  const aggregateStatus = aggregateFailed ? "unresolved" : "passed";
  const aggregateVlmDescription =
    perViewport.find((v) => v.vlmDescription)?.vlmDescription ?? null;

  // ADR-043 §4.2: roll up the most-severe unresolved checkpoint's diff_signature
  // as the run's primary_signature for inbox grouping. Computed from perViewport
  // so it includes all checkpoints that completed diffing. sweeper.ts (stale-run
  // finalizer) has no perViewport data and intentionally leaves primary_signature NULL.
  // INVARIANT: computed once here, never recomputed — relies on v1.1 having no
  // partial approval (approving any checkpoint flips the whole run to passed, so a
  // run stays wholly unresolved while in the inbox). If partial approval ever lands,
  // primary_signature must be recomputed when a checkpoint's status changes.
  const primarySignature = computePrimarySignature(
    perViewport.map((v) => ({
      diffSignature: v.diffSignature ?? null,
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

  await withProjectScope(deps.db, data.projectId, async (tx) => {
    await tx
      .update(testRuns)
      .set({
        diffPercent: aggregateDiffPercent,
        pixelMisMatchCount: aggregatePixelMismatch,
        diffName: aggregateDiffName,
        status: aggregateStatus,
        baselineSource: baseline.source,
        vlmDescription: aggregateVlmDescription,
        primarySignature,
      })
      .where(eq(testRuns.id, data.runId));

    if (aggregateRegions.length > 0) {
      await tx.insert(diffRegions).values(
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
      );
    }

    // ADR-042: persist each diffed checkpoint's signature for build-scoped
    // grouping. Only the success path sets screenshotId; null is written when
    // the checkpoint had no meaningful regions (→ "ungrouped").
    for (const v of perViewport) {
      if (v.screenshotId === undefined) continue;
      await tx
        .update(screenshots)
        .set({ diffSignature: v.diffSignature ?? null })
        .where(eq(screenshots.id, v.screenshotId));
    }

    // Synthetic audit rows for dynamic-text OCR decisions (matched OR
    // unmatched). `source="dynamic_text"` + `ocr_text`/`ocr_matched`
    // distinguish these from real L1/L2 regions; severity is always
    // "none" so they're hidden from the default RegionListPanel view.
    const auditValues = dynamicTextAudits.flatMap(
      ({ viewport, screenshotId, results }) =>
        results.map((dt) => {
          const r = allRegions[dt.regionIndex]!;
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
  });

  const durationMs = Date.now() - t0;
  const ranTiersUnion = Array.from(
    new Set(perViewport.flatMap((v) => v.ranTiers)),
  );
  await deps.redis.publish(
    `run:${data.runId}:events`,
    JSON.stringify({
      type: "diff.completed",
      runId: data.runId,
      passed: !aggregateFailed,
      diffPercent: aggregateDiffPercent,
      ranTiers: ranTiersUnion,
      viewportCount: perViewport.length,
      durationMs,
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
      status: aggregateStatus,
      diffPercent: aggregateDiffPercent,
      branchName: run.branchName,
      numChanges: aggregateRegions.length,
    }),
  );
  await publishProjectRunUpdate(
    deps,
    {
      projectId: data.projectId,
      runId: data.runId,
      status: aggregateStatus,
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
      baselineSource: baseline.source,
      viewportCount: perViewport.length,
      durationMs,
    },
    "diff_completed",
  );
}

/**
 * ADR-032 auto-approve gate: every candidate viewport's image hash must
 * equal its same-viewport baseline counterpart. Returns false if any
 * viewport has no baseline match or a hash mismatch. Defensive false
 * on empty candidate list.
 */
function allHashesMatch(
  candidateShots: Array<{ imageKey: string; viewport: string | null }>,
  baselineByViewport: Map<string | null, { imageKey: string }>,
): boolean {
  if (candidateShots.length === 0) return false;
  for (const cs of candidateShots) {
    const bs = baselineByViewport.get(cs.viewport ?? null);
    if (!bs) return false;
    if (cs.imageKey !== bs.imageKey) return false;
  }
  return true;
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
