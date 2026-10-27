import {
  and,
  asc,
  baselines,
  diffRegions,
  eq,
  isNull,
  or,
  projects,
  resolveBaseline,
  screenshots,
  testRuns,
  testVariations,
  type DB,
} from "@furan/db";
import type { Telemetry } from "@furan/telemetry";
import { TRPCError } from "@trpc/server";

import type { AuthedUser } from "../../plugins/auth.js";

import { loadStepReview, type CheckpointReviewView } from "./reads.js";

/**
 * The diff viewer's read of one step (spec 2026-10-27 §5): the step, the
 * baseline it is compared against, its regions and its review. `runs.getStep`
 * returns it; the run header (`runs.getById`) and the step list
 * (`runs.listCheckpoints`) carry none of it.
 */

/** A saved ignore region as the viewer reads it, in image-pixel space. */
export type IgnoreRegion = {
  x: number;
  y: number;
  width: number;
  height: number;
  viewport?: string;
};

type ScreenshotRow = typeof screenshots.$inferSelect;

/** What a step is compared against, as the viewer shows it. */
export interface CheckpointContext {
  /** The resolved baseline's own capture of the variation, if any. */
  baselineScreenshot: ScreenshotRow | null;
  /** The tier the baseline was resolved from (`resolveBaseline`). */
  baselineSource: string | null;
  /** The step's variation's saved ignore regions. */
  variationIgnoreAreas: IgnoreRegion[] | null;
}

/** The run fields a step's baseline resolution reads. */
export interface ContextRun {
  id: string;
  projectId: string;
  branchName: string | null;
  parentBranchName: string | null;
}

/**
 * Resolves `{ baselineScreenshot, baselineSource, variationIgnoreAreas }` for
 * one step of `run`, the baseline the diff-worker compares it to. Failures in
 * baseline resolution are informational and degrade to nulls: one bad
 * variation must not fail the read. Every lookup is pinned to the run's
 * project: a variation outside it (corrupt data) resolves nothing.
 */
export async function resolveCheckpointContext(
  db: DB,
  logger: Telemetry["logger"],
  run: ContextRun,
  defaultBranch: string,
  shot: { id: string; testVariationId: string },
): Promise<CheckpointContext> {
  const ctxResult: CheckpointContext = {
    baselineScreenshot: null,
    baselineSource: null,
    variationIgnoreAreas: null,
  };
  if (!shot.testVariationId) return ctxResult;

  const variationRows = await db
    .select({ ignoreRegions: testVariations.ignoreRegions })
    .from(testVariations)
    .where(
      and(
        eq(testVariations.id, shot.testVariationId),
        eq(testVariations.projectId, run.projectId),
      ),
    )
    .limit(1);
  const variation = variationRows[0];
  if (!variation) return ctxResult;
  if (variation.ignoreRegions && Array.isArray(variation.ignoreRegions)) {
    ctxResult.variationIgnoreAreas = variation.ignoreRegions as IgnoreRegion[];
  }

  try {
    const resolution = await resolveBaseline(
      db,
      run.projectId,
      run.branchName ?? defaultBranch,
      shot.testVariationId,
      // ADR-055: feed the parent_pr tier so the displayed baselineSource
      // matches what the diff-worker actually resolves against.
      { defaultBranch, parentPrBaseBranch: run.parentBranchName ?? null },
    );
    if (resolution) {
      ctxResult.baselineSource = resolution.source;
      const baselineRows = await db
        .select({ testRunId: baselines.testRunId })
        .from(baselines)
        .where(eq(baselines.id, resolution.baselineId))
        .limit(1);
      const baselineRunId = baselineRows[0]?.testRunId;
      if (baselineRunId) {
        // Match the baseline screenshot to the RESOLVED baseline variation,
        // not the candidate's. For a cross-branch (parent_pr /
        // default_branch) resolution the baseline lives under the sibling
        // variation on the target branch (ADR-054), so its screenshots are
        // indexed under `baselineVariationId`, not the candidate's
        // `shot.testVariationId`: keying off the latter would find nothing
        // and blank the baseline image.
        const blShots = await db
          .select()
          .from(screenshots)
          .where(
            and(
              eq(screenshots.runId, baselineRunId),
              eq(screenshots.testVariationId, resolution.baselineVariationId),
              eq(screenshots.projectId, run.projectId),
            ),
          )
          .limit(1);
        ctxResult.baselineScreenshot = blShots[0] ?? null;
      }
    }
  } catch (err) {
    logger.warn(
      { err, runId: run.id, screenshotId: shot.id },
      "baseline_screenshot_lookup_failed",
    );
  }

  return ctxResult;
}

/** One step as the diff viewer shows it (`runs.getStep`). */
export interface StepView {
  /** The step's row. */
  step: ScreenshotRow;
  /** What the step is compared against (`resolveCheckpointContext`). */
  baselineContext: CheckpointContext;
  /**
   * The step's diff regions and the run's regions on no step (rows from
   * before v1.1.20, which the viewer shows on every step), in capture order.
   */
  regions: Array<typeof diffRegions.$inferSelect>;
  /** The step's verdict, state and decision (with its actor and undo). */
  review: Omit<CheckpointReviewView, "newerCapture">;
  /** A later run's capture of the step's variation, named, or null. */
  newerCapture: CheckpointReviewView["newerCapture"];
}

/**
 * One step of a run, read for `viewer`: a fixed number of statements however
 * many steps the run has. The step must be the run's and in the run's project;
 * otherwise NOT_FOUND (an unknown id, a step of another run, a row of another
 * project).
 */
export async function loadStep(
  db: DB,
  logger: Telemetry["logger"],
  viewer: AuthedUser,
  input: { runId: string; checkpointId: string },
): Promise<StepView> {
  // The step, its run and the project's default branch, in one statement.
  const [row] = await db
    .select({
      step: screenshots,
      run: {
        id: testRuns.id,
        projectId: testRuns.projectId,
        branchName: testRuns.branchName,
        parentBranchName: testRuns.parentBranchName,
      },
      mainBranchName: projects.mainBranchName,
    })
    .from(screenshots)
    .innerJoin(
      testRuns,
      and(
        eq(testRuns.id, screenshots.runId),
        eq(testRuns.projectId, screenshots.projectId),
      ),
    )
    .leftJoin(projects, eq(projects.id, testRuns.projectId))
    .where(
      and(
        eq(screenshots.id, input.checkpointId),
        eq(screenshots.runId, input.runId),
      ),
    )
    .limit(1);
  if (!row) throw new TRPCError({ code: "NOT_FOUND" });
  const { step, run } = row;

  const baselineContext = await resolveCheckpointContext(
    db,
    logger,
    run,
    row.mainBranchName ?? "main",
    step,
  );
  const regions = await db
    .select()
    .from(diffRegions)
    .where(
      and(
        eq(diffRegions.runId, run.id),
        eq(diffRegions.projectId, run.projectId),
        or(
          eq(diffRegions.screenshotId, step.id),
          isNull(diffRegions.screenshotId),
        ),
      ),
    )
    .orderBy(asc(diffRegions.createdAt), asc(diffRegions.id));
  const { newerCapture, ...review } = await loadStepReview(
    db,
    run,
    step,
    viewer,
  );
  return { step, baselineContext, regions, review, newerCapture };
}
