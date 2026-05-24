import { performance } from "node:perf_hooks";

import {
  and,
  baselines,
  builds,
  desc,
  eq,
  screenshots,
  testRuns,
  testVariations,
  type DB,
} from "@furan/db";
import type { Telemetry } from "@furan/telemetry";
import type { FastifyBaseLogger } from "fastify";

import type { DiffQueueProducer } from "../trpc/context.js";

import {
  recordBranchMergeDuration,
  recordBranchMergeOutcome,
} from "./branch-merge-metrics.js";
import type { Broadcaster } from "./broadcast.js";

/**
 * Shared backing implementation for the cross-branch baseline merge.
 *
 * Both the tRPC `projects.mergeBranchBaselines` mutation and the REST
 * `POST /projects/:id/merge` route call into here. Pulling the body out
 * of the tRPC procedure means the REST handler doesn't reimplement the
 * (non-trivial) per-variation loop — the two surfaces stay byte-for-byte
 * identical.
 *
 * Behavior matches the legacy NestJS backend's
 * `TestVariationsService.merge(projectId, fromBranch, toBranch)` (see
 * the spec referenced in the function comment), adapted to furan's data
 * shape: variations are project-scoped (not branch-keyed), baselines
 * carry the branch label, and `screenshots.image_key` is content-
 * addressed so a synthetic run shares storage with its source baseline
 * via the ADR-033 `(run_id, viewport)` unique constraint.
 *
 * Spec: furan-design/specs/2026-05-24-cross-branch-baseline-merge-design.md
 */

export const MERGE_BUILD_CI_PREFIX = "merge:" as const;

export interface BranchMergeInput {
  projectId: string;
  fromBranch: string;
  toBranch: string;
}

export interface BranchMergeDeps {
  db: DB;
  diffQueue: DiffQueueProducer;
  telemetry: Telemetry;
  broadcaster: Broadcaster;
  /** Caller user id — stamped on the synthetic build as `userId`. */
  userId: string | null;
  log: FastifyBaseLogger;
}

export interface BranchMergeResult {
  buildId: string;
  runCount: number;
  skippedCount: number;
  skipped: Array<{ variationId: string; reason: string }>;
  fromBranch: string;
  toBranch: string;
}

export class SameBranchError extends Error {
  constructor() {
    super("same_branch: fromBranch and toBranch must differ");
    this.name = "SameBranchError";
  }
}

export async function mergeBranchBaselinesImpl(
  input: BranchMergeInput,
  deps: BranchMergeDeps,
): Promise<BranchMergeResult> {
  const { projectId, fromBranch, toBranch } = input;
  if (fromBranch === toBranch) {
    // Defense-in-depth: the trpc/REST validators already reject this. Keep
    // the check here so the helper is safe to call from any future surface
    // (webhook, CLI) without re-implementing validation.
    throw new SameBranchError();
  }

  const t0 = performance.now();

  // 1. findOrCreate the synthetic build on toBranch. The ciBuildId encodes
  //    the merge pair so retried merges reuse one container (legacy parity).
  const ciKey = `${MERGE_BUILD_CI_PREFIX}${fromBranch}->${toBranch}`;
  const existing = await deps.db
    .select()
    .from(builds)
    .where(
      and(
        eq(builds.projectId, projectId),
        eq(builds.branchName, toBranch),
        eq(builds.ciBuildId, ciKey),
      ),
    )
    .limit(1);

  let build = existing[0];
  let buildWasCreated = false;
  if (!build) {
    const created = await deps.db
      .insert(builds)
      .values({
        projectId,
        branchName: toBranch,
        ciBuildId: ciKey,
        name: `Merge ${fromBranch} → ${toBranch}`,
        userId: deps.userId,
        isRunning: true,
      })
      .returning();
    build = created[0];
    if (!build) {
      // Insert returning empty should be impossible without a DB error;
      // surface a typed error so callers don't grovel through err.message.
      throw new Error("merge_build_insert_returned_no_row");
    }
    buildWasCreated = true;
  }

  // Retried merges reuse an existing container, so only fire build_created
  // the first time. Subscribers wouldn't double-up — debouncing keeps the
  // first-payload semantics — but emitting on every retry would mislead
  // anyone reading the metric series.
  if (buildWasCreated) {
    await deps.broadcaster.publishProjectEvent(projectId, {
      event: "build_created",
      data: { id: build.id },
    });
  }

  // 2. Latest baseline per variation on fromBranch — desc by createdAt,
  //    dedupe in-memory (first-occurrence wins). Joins through
  //    test_variations so we get only baselines that belong to this
  //    project (defensive: baselines.test_variation_id is FK'd, but the
  //    join also gives us project_id for the screenshot copy below).
  const sourceRows = await deps.db
    .select({
      variationId: baselines.testVariationId,
      runId: baselines.testRunId,
      baselineName: baselines.baselineName,
      createdAt: baselines.createdAt,
    })
    .from(baselines)
    .innerJoin(testVariations, eq(testVariations.id, baselines.testVariationId))
    .where(
      and(
        eq(testVariations.projectId, projectId),
        eq(baselines.branchName, fromBranch),
      ),
    )
    .orderBy(desc(baselines.createdAt));

  const seen = new Set<string>();
  const latestPerVariation = sourceRows.filter((r) => {
    if (seen.has(r.variationId)) return false;
    seen.add(r.variationId);
    return true;
  });

  // 3. Per-variation loop: load source screenshots, insert synthetic
  //    test_run + screenshot rows on toBranch, enqueue diff.
  //
  //    Per-variation try/catch (not wrapping the whole loop in one txn) so a
  //    single broken row — missing screenshot in storage, FK cascade race,
  //    etc — doesn't fail the entire merge. The caller gets a partial-
  //    success response with the skipped list.
  const enqueued: Array<{ variationId: string; runId: string }> = [];
  const skipped: Array<{ variationId: string; reason: string }> = [];

  for (const source of latestPerVariation) {
    const sourceShots = await deps.db
      .select()
      .from(screenshots)
      .where(eq(screenshots.runId, source.runId));
    if (sourceShots.length === 0) {
      skipped.push({
        variationId: source.variationId,
        reason: "no_source_screenshots",
      });
      recordBranchMergeOutcome(deps.telemetry.metrics, "skipped");
      continue;
    }

    const variationRows = await deps.db
      .select()
      .from(testVariations)
      .where(eq(testVariations.id, source.variationId))
      .limit(1);
    const variation = variationRows[0];
    if (!variation) {
      skipped.push({
        variationId: source.variationId,
        reason: "variation_missing",
      });
      recordBranchMergeOutcome(deps.telemetry.metrics, "skipped");
      continue;
    }

    // Synthetic test_run on toBranch. `merge: true` + threshold override 0
    // matches legacy diffTollerancePercent: 0. The diff worker takes over
    // from here — byte-identical → ADR-032 auto-approve, divergent →
    // unresolved.
    const runRows = await deps.db
      .insert(testRuns)
      .values({
        projectId,
        buildId: build.id,
        testVariationId: source.variationId,
        branchName: toBranch,
        name: variation.name,
        browser: variation.browser,
        device: variation.device,
        os: variation.os,
        viewport: variation.viewport,
        customTags: variation.customTags,
        status: "running",
        merge: true,
        diffThresholdOverride: 0,
      })
      .returning();
    const run = runRows[0];
    if (!run) {
      skipped.push({
        variationId: source.variationId,
        reason: "run_insert_failed",
      });
      recordBranchMergeOutcome(deps.telemetry.metrics, "skipped");
      continue;
    }

    // Screenshot rows — reference the same content-addressed imageKey as
    // the source. ADR-033 keeps screenshots.image_key non-unique; the
    // unique constraint is (run_id, viewport) so we can insert without
    // re-uploading bytes.
    for (const shot of sourceShots) {
      await deps.db.insert(screenshots).values({
        runId: run.id,
        projectId,
        imageKey: shot.imageKey,
        domKey: shot.domKey,
        elementMapKey: shot.elementMapKey,
        viewport: shot.viewport,
        browser: shot.browser,
      });
    }

    // Best-effort enqueue — a queue blip should not fail an otherwise
    // successful synthetic run. Bytes are persisted, the reviewer can
    // manually re-trigger via setIgnoreAreas (which re-enqueues).
    try {
      await deps.diffQueue.add("diff", { runId: run.id, projectId });
    } catch (err) {
      deps.log.warn(
        { err, runId: run.id, projectId },
        "merge_diff_enqueue_failed",
      );
    }

    enqueued.push({ variationId: source.variationId, runId: run.id });
    recordBranchMergeOutcome(deps.telemetry.metrics, "enqueued");

    await deps.broadcaster.publishProjectEvent(projectId, {
      event: "testRun_created",
      data: { id: run.id },
    });
  }

  // After all synthetic runs are inserted, signal the build summary to
  // refresh once (per-run testRun_updated events would also work, but the
  // build_updated is what bumps the build-list aggregate counters).
  if (enqueued.length > 0) {
    await deps.broadcaster.publishProjectEvent(projectId, {
      event: "build_updated",
      data: { id: build.id },
    });
  }

  const durationMs = performance.now() - t0;
  recordBranchMergeDuration(deps.telemetry.metrics, durationMs);
  deps.log.info(
    {
      projectId,
      fromBranch,
      toBranch,
      buildId: build.id,
      runCount: enqueued.length,
      skippedCount: skipped.length,
      durationMs,
    },
    "branch_merge_completed",
  );

  return {
    buildId: build.id,
    runCount: enqueued.length,
    skippedCount: skipped.length,
    skipped,
    fromBranch,
    toBranch,
  };
}
