import { and, desc, eq } from "drizzle-orm";

import type { DB } from "./client.js";
import { baselines, testVariations } from "./schema/index.js";

export type BaselineSource = "this_branch" | "parent_pr" | "default_branch";

export interface GitRefs {
  defaultBranch: string;
  parentPrBaseBranch?: string | null;
  depthCap?: number;
}

/**
 * Resolves the best available baseline for a test variation using a
 * three-tier fallback chain:
 *   1. this_branch  — most recent baseline on the current branch
 *   2. parent_pr    — most recent baseline on the PR's base branch (depth-capped)
 *   3. default_branch — most recent baseline on the repo default branch
 *
 * Returns null when no baseline exists in any tier.
 */
export async function resolveBaseline(
  db: DB,
  projectId: string,
  branchName: string,
  testVariationId: string,
  refs: GitRefs,
): Promise<{ baselineId: string; source: BaselineSource } | null> {
  // 1. this_branch
  const onBranch = await db.query.baselines.findFirst({
    where: and(
      eq(baselines.testVariationId, testVariationId),
      eq(baselines.branchName, branchName),
    ),
    orderBy: [desc(baselines.createdAt)],
  });
  if (onBranch) return { baselineId: onBranch.id, source: "this_branch" };

  // 2. parent_pr (depth-cap; v1.0: one hop)
  const cap = refs.depthCap ?? 10;
  if (refs.parentPrBaseBranch && cap > 0) {
    const onParent = await db.query.baselines.findFirst({
      where: and(
        eq(baselines.testVariationId, testVariationId),
        eq(baselines.branchName, refs.parentPrBaseBranch),
      ),
      orderBy: [desc(baselines.createdAt)],
    });
    if (onParent) return { baselineId: onParent.id, source: "parent_pr" };
  }

  // 3. default_branch
  const onDefault = await db.query.baselines.findFirst({
    where: and(
      eq(baselines.testVariationId, testVariationId),
      eq(baselines.branchName, refs.defaultBranch),
    ),
    orderBy: [desc(baselines.createdAt)],
  });
  if (onDefault) return { baselineId: onDefault.id, source: "default_branch" };

  return null;
}

/** A Drizzle transaction or db handle — `recordBaseline` runs in either. */
type BaselineWriter = DB | Parameters<Parameters<DB["transaction"]>[0]>[0];

/**
 * Create a baseline for a checkpoint's variation: inserts the `baselines`
 * history row AND updates the variation's denormalized `baselineName` (the
 * current baseline image key, read by the diff viewer's `currentBaselineKey`).
 * The single place both writes happen, so every approve / auto-seed path keeps
 * them in sync — the drift that previously left run-level approve, saveNewTests,
 * and diff-worker auto-seed baselines with a null `test_variations.baseline_name`
 * (`approveCheckpointInTx` is the per-checkpoint variant that already paired the
 * two writes). Run inside a transaction for atomicity.
 */
export async function recordBaseline(
  writer: BaselineWriter,
  params: {
    testVariationId: string;
    testRunId: string;
    /** Baseline screenshot's image key — becomes the variation's current baseline. */
    imageKey: string | null;
    /** Run name; only a fallback label for the baselines row. */
    runName?: string | null;
    /** Branch the baseline belongs to; omitted → table default ("main"). */
    branchName?: string | null;
    /** Reviewer who approved; omitted/null → auto-baseline. */
    userId?: string | null;
  },
): Promise<void> {
  await writer.insert(baselines).values({
    baselineName: params.imageKey ?? params.runName ?? "auto",
    testVariationId: params.testVariationId,
    testRunId: params.testRunId,
    ...(params.userId ? { userId: params.userId } : {}),
    ...(params.branchName ? { branchName: params.branchName } : {}),
  });
  await writer
    .update(testVariations)
    .set({ baselineName: params.imageKey, updatedAt: new Date() })
    .where(eq(testVariations.id, params.testVariationId));
}
