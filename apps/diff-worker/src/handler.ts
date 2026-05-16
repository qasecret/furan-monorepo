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
import { runDiff } from "@furan/diff-engine";
import type { DiffJob } from "@furan/queue";
import { objectKey, type Storage } from "@furan/storage";
import type { Telemetry } from "@furan/telemetry";
import type { Redis } from "ioredis";

type Logger = Telemetry["logger"];

export interface HandlerDeps {
  db: DB;
  storage: Storage;
  redis: Redis;
}

/**
 * Phase 2 diff handler: looks up project + candidate run, resolves the
 * baseline via the three-tier `resolveBaseline` chain, fetches both image +
 * DOM blobs from storage, invokes `runDiff` (L1 pixel + optional L2 DOM),
 * writes the diff overlay back to storage, updates `test_runs` (status,
 * diff_percent, pixel_mis_match_count, diff_name, baseline_source) and
 * inserts `diff_regions` rows. Publishes `diff.started` and `diff.completed`
 * events on the per-run Redis pub/sub channel.
 *
 * When no baseline exists in any tier the run is the *first* baseline for
 * this variation: we mark it passed and skip the diff entirely.
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
    await deps.redis.publish(
      `run:${data.runId}:events`,
      JSON.stringify({
        type: "diff.completed",
        runId: data.runId,
        passed: true,
        firstBaseline: true,
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

  const baselineScreenshot = await deps.db.query.screenshots.findFirst({
    where: eq(screenshots.runId, baselineRow.testRunId),
  });
  const candidateScreenshot = await deps.db.query.screenshots.findFirst({
    where: eq(screenshots.runId, data.runId),
  });
  if (!baselineScreenshot || !candidateScreenshot) {
    throw new Error(
      `missing_screenshot:baseline=${!!baselineScreenshot},candidate=${!!candidateScreenshot}`,
    );
  }

  const baselineBytes = await deps.storage.get(baselineScreenshot.imageKey);
  const candidateBytes = await deps.storage.get(candidateScreenshot.imageKey);
  const baselineDom = baselineScreenshot.domKey
    ? new TextDecoder().decode(
        await deps.storage.get(baselineScreenshot.domKey),
      )
    : undefined;
  const candidateDom = candidateScreenshot.domKey
    ? new TextDecoder().decode(
        await deps.storage.get(candidateScreenshot.domKey),
      )
    : undefined;

  const ignoreAreas = parseIgnoreAreas(run.ignoreAreas);

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
    },
  });

  let diffImageKey: string | null = null;
  if (result.diffImageBytes.length > 0) {
    diffImageKey = objectKey(result.diffImageBytes);
    await deps.storage.put(diffImageKey, result.diffImageBytes, "image/png");
  }

  await withProjectScope(deps.db, data.projectId, async (tx) => {
    await tx
      .update(testRuns)
      .set({
        diffPercent: result.diffPercent,
        pixelMisMatchCount: result.pixelMismatchCount,
        diffName: diffImageKey,
        status: result.passed ? "passed" : "failed",
        baselineSource: baseline.source,
      })
      .where(eq(testRuns.id, data.runId));

    if (result.regions.length > 0) {
      await tx.insert(diffRegions).values(
        result.regions.map((r) => ({
          runId: data.runId,
          projectId: data.projectId,
          severity: r.severity,
          category: r.category,
          bbox: r.bbox,
          description: r.description,
          source: r.source,
        })),
      );
    }
  });

  const durationMs = Date.now() - t0;
  await deps.redis.publish(
    `run:${data.runId}:events`,
    JSON.stringify({
      type: "diff.completed",
      runId: data.runId,
      passed: result.passed,
      diffPercent: result.diffPercent,
      ranTiers: result.ranTiers,
      durationMs,
    }),
  );
  logger.info(
    {
      runId: data.runId,
      projectId: data.projectId,
      diffPercent: result.diffPercent,
      pixelMismatchCount: result.pixelMismatchCount,
      ranTiers: result.ranTiers,
      baselineSource: baseline.source,
      durationMs,
    },
    "diff_completed",
  );
}

function parseIgnoreAreas(
  value: string | null | undefined,
): Array<{ x: number; y: number; width: number; height: number }> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed as Array<{
        x: number;
        y: number;
        width: number;
        height: number;
      }>;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
