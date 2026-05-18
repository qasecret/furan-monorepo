import {
  baselines,
  diffRegions,
  eq,
  projects,
  resolveBaseline,
  screenshots,
  testRuns,
  withProjectScope,
  type DB,
} from "@furan/db";
import {
  runDiff,
  DEFAULT_ENGINE_CONFIG,
  type EngineConfig,
} from "@furan/diff-engine";
import type { DiffJob } from "@furan/queue";
import { objectKey, type Storage } from "@furan/storage";
import type { Telemetry } from "@furan/telemetry";
import type { Redis } from "ioredis";
import { z } from "zod";

import type { DiffMetrics } from "./diff-metrics.js";

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
  }>;
  ranTiers: Array<"l1" | "l2">;
  firstBaseline: boolean;
}

/**
 * Phase 2 diff handler (v0.5 multi-viewport): looks up project + candidate
 * run, then for each candidate screenshot (one per viewport) resolves the
 * baseline via the three-tier `resolveBaseline` chain, matches the
 * same-viewport baseline screenshot, and runs the L1+L2 diff. When no
 * matching baseline screenshot exists for a viewport (new viewport added
 * since the baseline was captured) the viewport is treated as a
 * first-baseline (passes with 0% diff for that viewport).
 *
 * Aggregation rolled back to the single `test_runs` row:
 *   status        = "failed" if ANY viewport failed; else "passed"
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

  const baseline = await resolveBaseline(
    deps.db,
    data.projectId,
    run.branchName,
    run.testVariationId,
    {
      defaultBranch: project.mainBranchName,
      parentPrBaseBranch: data.parentPrBaseBranch ?? null,
    },
  );

  if (!baseline) {
    // First-baseline: nothing to diff against, mark the run passed +
    // emit both `diff.completed` and `run.completed` so the integrations
    // subscriber (T8 GitHub flow + T9 webhook flow) can react.
    await withProjectScope(deps.db, data.projectId, async (tx) => {
      await tx
        .update(testRuns)
        .set({ status: "passed" })
        .where(eq(testRuns.id, data.runId));
    });
    await deps.redis.publish(
      `run:${data.runId}:events`,
      JSON.stringify({
        type: "diff.completed",
        runId: data.runId,
        passed: true,
        firstBaseline: true,
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
    logger.info(
      { runId: data.runId, firstBaseline: true },
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

  const ignoreAreas = parseIgnoreAreas(run.ignoreAreas);
  const perViewport: PerViewportResult[] = [];

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
    const baselineDom = baselineShot.domKey
      ? new TextDecoder().decode(await deps.storage.get(baselineShot.domKey))
      : undefined;
    const candidateDom = cs.domKey
      ? new TextDecoder().decode(await deps.storage.get(cs.domKey))
      : undefined;

    const result = await runDiff({
      baseline: {
        image: Buffer.from(baselineBytes),
        ...(baselineDom !== undefined ? { dom: baselineDom } : {}),
      },
      candidate: {
        image: Buffer.from(candidateBytes),
        ...(candidateDom !== undefined ? { dom: candidateDom } : {}),
      },
      config: {
        diffThreshold: project.diffThreshold ?? 0.001,
        l2Enabled: project.l2Enabled ?? true,
        ...(ignoreAreas !== undefined ? { ignoreAreas } : {}),
        engine: project.imageComparison,
        engineConfig: parseEngineConfig(
          project.imageComparisonConfig,
          logger,
          project.id,
        ),
      },
    });

    // Observe L1 latency labelled by engine. durationMs.l1 is always set
    // (every runDiff invocation runs L1); converting ms -> seconds to
    // match the histogram's seconds-based bucket boundaries and the
    // OpenMetrics convention.
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
      })),
      ranTiers: result.ranTiers,
      firstBaseline: false,
    });
  }

  // Aggregate per-viewport results to the single test_runs row.
  // - status: "failed" if any viewport failed.
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
  const allRegions = perViewport.flatMap((v) => v.regions);
  const aggregateStatus = aggregateFailed ? "failed" : "passed";

  await withProjectScope(deps.db, data.projectId, async (tx) => {
    await tx
      .update(testRuns)
      .set({
        diffPercent: aggregateDiffPercent,
        pixelMisMatchCount: aggregatePixelMismatch,
        diffName: aggregateDiffName,
        status: aggregateStatus,
        baselineSource: baseline.source,
      })
      .where(eq(testRuns.id, data.runId));

    if (allRegions.length > 0) {
      await tx.insert(diffRegions).values(
        allRegions.map((r) => ({
          runId: data.runId,
          projectId: data.projectId,
          severity: r.severity,
          category: r.category,
          bbox: r.bbox,
          description: r.description,
          source: r.source,
          viewport: r.viewport,
        })),
      );
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
      numChanges: allRegions.length,
    }),
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

const ignoreAreaParseSchema = z.object({
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
  width: z.number().int().min(1),
  height: z.number().int().min(1),
  viewport: z.string().min(1).max(32).optional(),
});

/**
 * Per-run / per-variation ignore region. Includes an optional viewport tag
 * (added in ADR-031) so multi-viewport runs can apply masks to the right
 * screenshot. Legacy rows without `viewport` apply universally.
 */
export type ParsedIgnoreArea = z.infer<typeof ignoreAreaParseSchema>;

function parseIgnoreAreas(
  value: string | null | undefined,
): ParsedIgnoreArea[] | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
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
