import { and, desc, eq, isNull, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

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
 *
 * ADR-054 folds the branch into the `test_variations` identity, so the SAME
 * checkpoint on a feature branch and on `main` are DISTINCT variation rows with
 * distinct ids. The parent_pr / default_branch tiers (ADR-055) must therefore
 * resolve the *sibling* variation on the target branch — the row sharing the
 * candidate's branch-agnostic environment identity (name/viewport/browser/os/
 * device) — and take ITS baseline. Querying the candidate's own branch-specific
 * `testVariationId` against another branch never matches (the parent's baseline
 * lives under the parent's variation id), which silently broke cross-branch
 * fallback and mislabelled identical feature-branch captures as "new".
 *
 * `baselineVariationId` is the variation the resolved baseline actually lives
 * under — the candidate's own id for `this_branch`, or the sibling's id for the
 * cross-branch tiers. Callers that fetch the baseline's screenshot MUST key off
 * this, not the candidate's `testVariationId` (which, for a cross-branch match,
 * indexes nothing in the baseline run).
 */
export async function resolveBaseline(
  db: DB,
  projectId: string,
  branchName: string,
  testVariationId: string,
  refs: GitRefs,
): Promise<{
  baselineId: string;
  source: BaselineSource;
  baselineVariationId: string;
} | null> {
  // 1. this_branch — the candidate's own (branch-specific) variation.
  const onBranch = await db.query.baselines.findFirst({
    where: and(
      eq(baselines.testVariationId, testVariationId),
      eq(baselines.branchName, branchName),
    ),
    orderBy: [desc(baselines.createdAt)],
  });
  if (onBranch)
    return {
      baselineId: onBranch.id,
      source: "this_branch",
      baselineVariationId: testVariationId,
    };

  // The cross-branch tiers key off the candidate's branch-agnostic identity, so
  // load it once. A nullable identity column (viewport/browser/os/device) must
  // match with IS NULL, never `= NULL`, to mirror the NULLS-NOT-DISTINCT unique.
  const identity = await db.query.testVariations.findFirst({
    where: eq(testVariations.id, testVariationId),
    columns: {
      name: true,
      viewport: true,
      browser: true,
      os: true,
      device: true,
    },
  });

  const nullable = (col: AnyPgColumn, val: string | null): SQL =>
    val === null ? isNull(col) : eq(col, val);

  /**
   * Most recent baseline of the sibling variation on `targetBranch`, plus the
   * sibling variation's id (so the caller can locate the baseline screenshot,
   * which is indexed under the sibling — not the candidate — variation).
   */
  const baselineOnBranch = async (
    targetBranch: string,
  ): Promise<{ baselineId: string; variationId: string } | null> => {
    if (!identity) return null;
    const sibling = await db.query.testVariations.findFirst({
      where: and(
        eq(testVariations.projectId, projectId),
        eq(testVariations.name, identity.name),
        eq(testVariations.branchName, targetBranch),
        nullable(testVariations.viewport, identity.viewport),
        nullable(testVariations.browser, identity.browser),
        nullable(testVariations.os, identity.os),
        nullable(testVariations.device, identity.device),
      ),
      columns: { id: true },
    });
    if (!sibling) return null;
    const b = await db.query.baselines.findFirst({
      where: eq(baselines.testVariationId, sibling.id),
      orderBy: [desc(baselines.createdAt)],
    });
    return b ? { baselineId: b.id, variationId: sibling.id } : null;
  };

  // 2. parent_pr (depth-cap; v1.0: one hop)
  const cap = refs.depthCap ?? 10;
  if (refs.parentPrBaseBranch && cap > 0) {
    const parent = await baselineOnBranch(refs.parentPrBaseBranch);
    if (parent)
      return {
        baselineId: parent.baselineId,
        source: "parent_pr",
        baselineVariationId: parent.variationId,
      };
  }

  // 3. default_branch
  const onDefault = await baselineOnBranch(refs.defaultBranch);
  if (onDefault)
    return {
      baselineId: onDefault.baselineId,
      source: "default_branch",
      baselineVariationId: onDefault.variationId,
    };

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
  // Upsert on (test_variation_id, test_run_id): recording a baseline for the
  // same run twice — a diff-worker retry, or an approve after an auto-seed —
  // updates that one row instead of appending a duplicate. The key is the RUN
  // (not the variation), so distinct runs keep distinct baseline rows, which
  // the `autoApproved`-per-run check and the latest-wins resolver both rely on.
  await writer
    .insert(baselines)
    .values({
      baselineName: params.imageKey ?? params.runName ?? "auto",
      testVariationId: params.testVariationId,
      testRunId: params.testRunId,
      ...(params.userId ? { userId: params.userId } : {}),
      ...(params.branchName ? { branchName: params.branchName } : {}),
    })
    .onConflictDoUpdate({
      target: [baselines.testVariationId, baselines.testRunId],
      set: {
        baselineName: params.imageKey ?? params.runName ?? "auto",
        userId: params.userId ?? null,
        ...(params.branchName ? { branchName: params.branchName } : {}),
        updatedAt: new Date(),
      },
    });
  await writer
    .update(testVariations)
    .set({ baselineName: params.imageKey, updatedAt: new Date() })
    .where(eq(testVariations.id, params.testVariationId));
}
