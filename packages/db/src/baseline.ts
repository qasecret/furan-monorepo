import { and, desc, eq } from "drizzle-orm";

import type { DB } from "./client.js";
import { baselines } from "./schema/index.js";

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
