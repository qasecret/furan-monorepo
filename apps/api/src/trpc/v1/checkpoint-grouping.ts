import {
  and,
  baselines,
  baselineWriteTime,
  diffRegions,
  eq,
  inArray,
  projects,
  screenshots,
  sql,
  testRuns,
  testVariations,
  variationIdentityKey,
  type DB,
  type VariationIdentity,
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
  // Cross-branch (default_branch tier): ADR-054 makes each variation
  // branch-specific, so a checkpoint's default-branch baseline lives under a
  // DISTINCT same-identity SIBLING variation — invisible to the
  // candidate-scoped `baselines` lookup above. Resolve, per candidate, whether
  // a sibling on the project's default branch has a baseline. This is
  // per-variation (name+viewport+browser+os+device), so a run spanning several
  // viewports keeps precise per-checkpoint granularity — a genuinely-new
  // viewport isn't masked by a baselined sibling one. (parent_pr is still
  // omitted — the badge has no PR base context.)
  const variationIdentity = new Map<
    string,
    {
      projectId: string;
      name: string;
      viewport: string | null;
      browser: string | null;
      os: string | null;
      device: string | null;
    }
  >();
  if (variationIds.length > 0) {
    const rows = await db
      .select({
        id: testVariations.id,
        projectId: testVariations.projectId,
        name: testVariations.name,
        viewport: testVariations.viewport,
        browser: testVariations.browser,
        os: testVariations.os,
        device: testVariations.device,
      })
      .from(testVariations)
      .where(inArray(testVariations.id, variationIds));
    for (const v of rows) variationIdentity.set(v.id, v);
  }
  // Project-scoped identity key: the shared `variationIdentityKey` (branch-
  // agnostic, cross-branch canonical) plus `projectId` so siblings never match
  // across projects.
  const scopedKey = (v: { projectId: string } & VariationIdentity): string =>
    `${v.projectId}::${variationIdentityKey(v)}`;

  // Identity keys whose default-branch sibling variation has a baseline.
  const baselinedDefaultSiblings = new Set<string>();
  const defaultBranches = [...new Set(projectDefault.values())];
  const candidateNames = [
    ...new Set([...variationIdentity.values()].map((v) => v.name)),
  ];
  if (defaultBranches.length > 0 && candidateNames.length > 0) {
    const siblingRows = await db
      .select({
        id: testVariations.id,
        projectId: testVariations.projectId,
        name: testVariations.name,
        viewport: testVariations.viewport,
        browser: testVariations.browser,
        os: testVariations.os,
        device: testVariations.device,
        branchName: testVariations.branchName,
      })
      .from(testVariations)
      .where(
        and(
          inArray(testVariations.projectId, projectIds),
          inArray(testVariations.name, candidateNames),
          inArray(testVariations.branchName, defaultBranches),
        ),
      );
    if (siblingRows.length > 0) {
      const siblingBaselined = new Set(
        (
          await db
            .select({ testVariationId: baselines.testVariationId })
            .from(baselines)
            .where(
              inArray(
                baselines.testVariationId,
                siblingRows.map((s) => s.id),
              ),
            )
        ).map((r) => r.testVariationId),
      );
      for (const s of siblingRows) {
        // Only siblings that are actually ON their project's default branch and
        // carry a baseline count as default-branch coverage.
        if (
          s.branchName === projectDefault.get(s.projectId) &&
          siblingBaselined.has(s.id)
        ) {
          baselinedDefaultSiblings.add(scopedKey(s));
        }
      }
    }
  }

  const hasBaseline = (c: CheckpointStatusInput): boolean => {
    const meta = runMeta.get(c.runId);
    const branches = baselineBranches.get(c.testVariationId);
    // this_branch: the candidate's own variation has a baseline on its branch.
    if (branches && meta?.branchName && branches.has(meta.branchName))
      return true;
    // default_branch: a same-identity sibling variation on the default branch
    // has a baseline (the cross-branch case the candidate-scoped lookup misses).
    const ident = variationIdentity.get(c.testVariationId);
    if (ident && baselinedDefaultSiblings.has(scopedKey(ident))) return true;
    // Legacy: a candidate variation tagged directly with a default-branch
    // baseline row (pre-ADR-054 shared-variation data).
    const def = meta ? projectDefault.get(meta.projectId) : undefined;
    return !!branches && def !== undefined && branches.has(def);
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
  // baselines_variation_run_unique constraint / append a duplicate row. Both
  // branches stamp baselineWriteTime so the checkpoint approved last wins.
  await tx
    .insert(baselines)
    .values({
      baselineName: s.imageKey ?? run.name ?? "auto",
      testVariationId: s.testVariationId,
      testRunId: run.id,
      userId,
      ...(run.branchName ? { branchName: run.branchName } : {}),
      createdAt: baselineWriteTime(),
    })
    .onConflictDoUpdate({
      target: [baselines.testVariationId, baselines.testRunId],
      set: {
        baselineName: s.imageKey ?? run.name ?? "auto",
        userId,
        ...(run.branchName ? { branchName: run.branchName } : {}),
        createdAt: baselineWriteTime(),
        updatedAt: new Date(),
      },
    });

  await tx
    .update(testRuns)
    .set({ status: "passed", merge: true })
    .where(eq(testRuns.id, run.id));
}
