import {
  and,
  baselines,
  desc,
  eq,
  resolveBaseline,
  screenshots,
  type BaselineSource,
  type DB,
} from "@furan/db";

/**
 * Where one checkpoint's diff stands against its baseline:
 * - `paired`: a baseline resolved AND its run holds a screenshot of the
 *   baseline's variation, so the checkpoint is diffed against that image.
 * - `none`: no baseline in any tier; the checkpoint is a first capture (`new`).
 * - `pair_missing`: a baseline resolved but its run has no screenshot of the
 *   baseline's variation (data drift). The checkpoint degrades to `new`; it is
 *   never diffed against another checkpoint's image.
 */
export type CheckpointBaseline =
  | {
      kind: "paired";
      source: BaselineSource;
      baselineId: string;
      baselineRunId: string;
      baselineShot: typeof screenshots.$inferSelect;
    }
  | { kind: "none" }
  | { kind: "pair_missing"; source: BaselineSource; baselineId: string };

/**
 * Resolves ONE checkpoint's baseline and pairs it with the exact baseline
 * image (review flow spec §3, steps 1–3).
 *
 * Resolution is `resolveBaseline` on the checkpoint's own variation, so its
 * tiers (this_branch → parent_pr → default_branch) and the ADR-068 `id`
 * tiebreak are unchanged. The pair is the screenshot where
 * `run_id = baseline.testRunId AND test_variation_id = baselineVariationId`:
 * `baselineVariationId` is the variation the baseline actually lives under (the
 * sibling on the target branch for the cross-branch tiers), so keying off the
 * candidate's own variation would miss every cross-branch baseline.
 *
 * The pair is unique in practice — a variation's identity includes the
 * checkpoint name and viewport, and a run holds one screenshot per
 * (name, viewport) — so the ordering only makes drifted data deterministic.
 */
export async function resolveCheckpointBaseline(
  db: DB,
  args: {
    projectId: string;
    branchName: string;
    testVariationId: string;
    defaultBranch: string;
    parentPrBaseBranch: string | null;
  },
): Promise<CheckpointBaseline> {
  const baseline = await resolveBaseline(
    db,
    args.projectId,
    args.branchName,
    args.testVariationId,
    {
      defaultBranch: args.defaultBranch,
      parentPrBaseBranch: args.parentPrBaseBranch,
    },
  );
  if (!baseline) return { kind: "none" };

  const baselineRow = await db.query.baselines.findFirst({
    where: eq(baselines.id, baseline.baselineId),
    columns: { testRunId: true },
  });
  // `test_run_id` is NOT NULL, so this only fires if the row vanished between
  // resolving and reading it (a concurrent delete). Fail the job so it retries
  // against fresh state rather than guessing a verdict.
  if (!baselineRow) {
    throw new Error(`baseline_has_no_run:${baseline.baselineId}`);
  }

  const [baselineShot] = await db
    .select()
    .from(screenshots)
    .where(
      and(
        eq(screenshots.runId, baselineRow.testRunId),
        eq(screenshots.testVariationId, baseline.baselineVariationId),
      ),
    )
    .orderBy(desc(screenshots.createdAt), desc(screenshots.id))
    .limit(1);
  if (!baselineShot) {
    return {
      kind: "pair_missing",
      source: baseline.source,
      baselineId: baseline.baselineId,
    };
  }

  return {
    kind: "paired",
    source: baseline.source,
    baselineId: baseline.baselineId,
    baselineRunId: baselineRow.testRunId,
    baselineShot,
  };
}
