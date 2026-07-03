import {
  and,
  baselines,
  diffRegions,
  eq,
  inArray,
  projects,
  screenshots,
  sql,
  testRuns,
  testVariations,
  type DB,
} from "@furan/db";
import { TRPCError } from "@trpc/server";

/** A Drizzle transaction handle (first arg of `db.transaction(cb)`). */
type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];

/**
 * Load + validate the seed checkpoint for a build-scoped group action
 * (getCheckpointGroup / approveCheckpointGroup / rejectCheckpointGroup share
 * this verbatim — keep it the single source so the three can't drift on what
 * "this checkpoint's group" is). Throws NOT_FOUND if the checkpoint is missing
 * and BAD_REQUEST if it doesn't belong to `runId`. Returns the seed including
 * its `diffSignature` (which may be null — the caller decides the empty-group
 * shape, since each procedure's zero-result differs).
 */
export async function loadGroupSeed(
  db: DB | Tx,
  input: { runId: string; checkpointId: string },
) {
  const seedRows = await db
    .select({
      id: screenshots.id,
      runId: screenshots.runId,
      diffSignature: screenshots.diffSignature,
      buildId: testRuns.buildId,
      projectId: testRuns.projectId,
    })
    .from(screenshots)
    .innerJoin(testRuns, eq(testRuns.id, screenshots.runId))
    .where(eq(screenshots.id, input.checkpointId))
    .limit(1);
  const seed = seedRows[0];
  if (!seed) throw new TRPCError({ code: "NOT_FOUND" });
  if (seed.runId !== input.runId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "checkpoint not in run",
    });
  }
  return seed;
}

/** Per-checkpoint review status, mirroring runs.listCheckpoints. */
export type CheckpointStatus = "new" | "unresolved" | "passed";

/**
 * Cap on how many checkpoints a single "Accept all" propagates. Mirrors
 * BULK_CAP (bulkApproveByVariation/byBuild) for consistency; reconciles the
 * spec's "~500" down to the established bulk-approve cap. A build with more
 * matches needs a second "run again" click.
 */
export const GROUP_APPROVE_CAP = 200;

/** Minimal checkpoint shape the status derivation needs. */
export interface CheckpointStatusInput {
  id: string;
  runId: string;
  viewport: string | null;
  testVariationId: string;
}

/**
 * Derive each checkpoint's review status using the SAME signals as
 * runs.listCheckpoints (single source of truth — do NOT fork this):
 *   - run approved (test_runs.status = 'passed')              -> "passed"
 *   - else NO baseline resolvable for the checkpoint's variation
 *     — i.e. no `baselines` row on the run's branch or the
 *     project's default branch (the authoritative source
 *     `resolveBaseline` diffs against). We deliberately do NOT
 *     key off `test_variations.baseline_name`: run-level approve
 *     (SDK `runs.approve` / saveNewTests) and diff-worker
 *     auto-seed create a `baselines` row WITHOUT setting that
 *     denormalized column, which made already-baselined runs
 *     mis-render as "new".                                     -> "new"
 *   - else any diff_regions row with severity != 'none' for
 *     this checkpoint (modern: screenshot_id match; legacy
 *     NULL screenshot_id: viewport fallback, scoped per run)  -> "unresolved"
 *   - else                                                    -> "passed"
 * Cross-run capable (build-scoped grouping spans runs); listCheckpoints is the
 * single-run caller.
 */
export async function deriveCheckpointStatuses(
  db: DB | Tx,
  checkpoints: CheckpointStatusInput[],
): Promise<Map<string, CheckpointStatus>> {
  const out = new Map<string, CheckpointStatus>();
  if (checkpoints.length === 0) return out;

  const runIds = [...new Set(checkpoints.map((c) => c.runId))];

  // A run approved to "passed" has — by the v1.1 "no partial approval" rule
  // (approving any checkpoint flips the whole run) — resolved every one of its
  // checkpoints, even though the diff_regions that triggered review are kept
  // for display. Without this an approved run's checkpoints stay "unresolved"
  // forever (no approve path deletes diff_regions), so a batch row never flips
  // to passed after "Approve" / "Approve all".
  const approvedRunRows = await db
    .select({ id: testRuns.id })
    .from(testRuns)
    .where(and(inArray(testRuns.id, runIds), eq(testRuns.status, "passed")));
  const approvedRuns = new Set(approvedRunRows.map((r) => r.id));

  // Per-run branch + project, and each project's default branch, so the
  // baseline existence check below mirrors resolveBaseline's this_branch +
  // default_branch tiers. (parent_pr is omitted — the badge has no PR base
  // context; a PR run baselined only on its parent shows "new", a rare edge.)
  const runMetaRows = await db
    .select({
      id: testRuns.id,
      branchName: testRuns.branchName,
      projectId: testRuns.projectId,
      status: testRuns.status,
      // Authoritative "a baseline was resolved for this run" signal, written by
      // the diff-worker for every tier — including the parent_pr/default_branch
      // tiers whose baseline lives under a SIBLING variation (ADR-054), which
      // the candidate-variation-scoped `baselines` lookup below cannot see.
      baselineSource: testRuns.baselineSource,
    })
    .from(testRuns)
    .where(inArray(testRuns.id, runIds));
  const runMeta = new Map(runMetaRows.map((r) => [r.id, r]));
  const projectIds = [...new Set(runMetaRows.map((r) => r.projectId))];
  const projectDefault = new Map<string, string>();
  if (projectIds.length > 0) {
    const projRows = await db
      .select({ id: projects.id, mainBranchName: projects.mainBranchName })
      .from(projects)
      .where(inArray(projects.id, projectIds));
    for (const p of projRows) projectDefault.set(p.id, p.mainBranchName);
  }

  // The authoritative "does this variation have a baseline?" signal: a row in
  // the `baselines` table (what resolveBaseline resolves against), keyed by the
  // branches it exists on. Distinct from the denormalized
  // test_variations.baseline_name, which not every approve path maintains.
  const variationIds = [...new Set(checkpoints.map((c) => c.testVariationId))];
  const baselineBranches = new Map<string, Set<string>>();
  if (variationIds.length > 0) {
    const baselineRows = await db
      .select({
        testVariationId: baselines.testVariationId,
        branchName: baselines.branchName,
      })
      .from(baselines)
      .where(inArray(baselines.testVariationId, variationIds));
    for (const b of baselineRows) {
      let set = baselineBranches.get(b.testVariationId);
      if (!set) {
        set = new Set<string>();
        baselineBranches.set(b.testVariationId, set);
      }
      set.add(b.branchName);
    }
  }
  const hasBaseline = (c: CheckpointStatusInput): boolean => {
    // Cross-branch resolutions (parent_pr / default_branch) baseline against a
    // SIBLING variation on the target branch (ADR-054), so the candidate-scoped
    // `baselines` lookup below misses them. The diff-worker records the tier it
    // actually resolved on the run, so trust that first — otherwise a run that
    // diffed against a parent/default baseline would mis-render as "new".
    if (runMeta.get(c.runId)?.baselineSource) return true;
    const branches = baselineBranches.get(c.testVariationId);
    if (!branches || branches.size === 0) return false;
    const meta = runMeta.get(c.runId);
    if (meta?.branchName && branches.has(meta.branchName)) return true;
    const def = meta ? projectDefault.get(meta.projectId) : undefined;
    return def !== undefined && branches.has(def);
  };

  const unresolvedRows = await db
    .select({
      screenshotId: diffRegions.screenshotId,
      runId: diffRegions.runId,
      viewport: diffRegions.viewport,
    })
    .from(diffRegions)
    .where(
      and(
        inArray(diffRegions.runId, runIds),
        sql`${diffRegions.severity} != 'none'`,
      ),
    );

  const unresolvedScreenshotSet = new Set(
    unresolvedRows
      .map((r) => r.screenshotId)
      .filter((s): s is string => s !== null),
  );
  // Legacy (pre-v1.1.20) rows have NULL screenshot_id; fall back to a per-run
  // viewport match so old runs keep their (imperfect) status.
  const legacyKey = (runId: string, viewport: string | null) =>
    `${runId}::${viewport ?? ""}`;
  const legacyUnresolvedSet = new Set(
    unresolvedRows
      // Parity with the original listCheckpoints filter: legacy rows match by
      // (run, viewport). Drop null-viewport rows — real checkpoints (screenshots)
      // always have a viewport, so they can never match a "runId::" key anyway.
      .filter((r) => r.screenshotId === null && r.viewport !== null)
      .map((r) => legacyKey(r.runId, r.viewport)),
  );

  // Runs that have at least one severity!='none' region — gates the
  // "trust the run verdict" fallback below to whole-region-less runs only, so a
  // run that DID produce regions keeps its precise per-checkpoint split.
  const runsWithAnyRegion = new Set(unresolvedRows.map((r) => r.runId));

  for (const c of checkpoints) {
    const status: CheckpointStatus = approvedRuns.has(c.runId)
      ? "passed"
      : !hasBaseline(c)
        ? "new"
        : unresolvedScreenshotSet.has(c.id) ||
            legacyUnresolvedSet.has(legacyKey(c.runId, c.viewport))
          ? "unresolved"
          : // Region-less fallback: the diff-worker can mark a run `unresolved`
            // (diffPercent > threshold) yet persist no severity!='none' regions
            // and no diff_signature for a small/scattered diff — leaving no
            // per-checkpoint signal. Trust the run verdict, but ONLY when the
            // whole run is region-less, so a run that DID produce regions keeps
            // its precise split (genuinely-passed checkpoints aren't over-marked).
            runMeta.get(c.runId)?.status === "unresolved" &&
              !runsWithAnyRegion.has(c.runId)
            ? "unresolved"
            : "passed";
    out.set(c.id, status);
  }
  return out;
}

/** The screenshot fields approveCheckpointInTx promotes onto the baseline. */
export interface ApprovableCheckpoint {
  testVariationId: string;
  imageKey: string | null;
  ignoreRegions: unknown;
  layoutRegions: unknown;
  floatingRegions: unknown;
  contentRegions: unknown;
  accessibilityRegions: unknown;
  matchLevel: string;
}
export interface ApprovableRun {
  id: string;
  name: string | null;
  branchName: string | null;
}

/**
 * Promote one checkpoint's variation baseline, record the baseline row, and
 * flip its run to passed — inside an existing transaction. Extracted VERBATIM
 * from runs.approveCheckpoint so single-checkpoint and group approval cannot
 * drift. (v1.1 has no "partially approved" run: approving any checkpoint flips
 * the whole run to passed — preserved here intentionally.)
 */
export async function approveCheckpointInTx(
  tx: Tx,
  s: ApprovableCheckpoint,
  run: ApprovableRun,
  userId: string,
  /**
   * ADR-036: when provided, reviewer-drawn ignore regions replace the
   * checkpoint's captured `ignoreRegions` on the variation — so a region
   * drawn in the viewer before "Approve" isn't dropped. `undefined` keeps
   * the screenshot's captured regions (the SDK / bulk / group-approve path).
   */
  ignoreAreasOverride?: readonly unknown[] | null,
): Promise<void> {
  await tx
    .update(testVariations)
    .set({
      baselineName: s.imageKey,
      ignoreRegions:
        ignoreAreasOverride !== undefined
          ? ignoreAreasOverride
          : s.ignoreRegions,
      layoutRegions: s.layoutRegions,
      floatingRegions: s.floatingRegions,
      contentRegions: s.contentRegions,
      accessibilityRegions: s.accessibilityRegions,
      matchLevel: s.matchLevel,
      updatedAt: new Date(),
    })
    .where(eq(testVariations.id, s.testVariationId));

  // Upsert on (variation, run) so re-approving a checkpoint doesn't violate the
  // baselines_variation_run_unique constraint / append a duplicate row.
  await tx
    .insert(baselines)
    .values({
      baselineName: s.imageKey ?? run.name ?? "auto",
      testVariationId: s.testVariationId,
      testRunId: run.id,
      userId,
      ...(run.branchName ? { branchName: run.branchName } : {}),
    })
    .onConflictDoUpdate({
      target: [baselines.testVariationId, baselines.testRunId],
      set: {
        baselineName: s.imageKey ?? run.name ?? "auto",
        userId,
        ...(run.branchName ? { branchName: run.branchName } : {}),
        updatedAt: new Date(),
      },
    });

  await tx
    .update(testRuns)
    .set({ status: "passed", merge: true })
    .where(eq(testRuns.id, run.id));
}
