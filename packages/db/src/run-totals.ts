import { severityRank, type Severity } from "@furan/shared-types";
import { and, asc, eq, notInArray, sql } from "drizzle-orm";

import type { DB } from "./client.js";
import { computePrimarySignature } from "./primary-signature.js";
import type { Tx } from "./review-status.js";
import { diffRegions, screenshots, testRuns } from "./schema/index.js";

/**
 * Region sources that never count towards a run's `primary_signature`: the
 * synthetic audit rows (dynamic-text OCR and layout-suppressed), hidden from
 * the diff list and not a "what changed" signal.
 *
 * KEEP IN SYNC with `EXCLUDED_SOURCES` in `@furan/diff-engine`, the rule the
 * per-step signature itself is built with. (Not a shared import: this package
 * must not depend on the diff engine. The diff-worker's tests pin the two
 * sets equal.)
 */
export const PRIMARY_SIGNATURE_EXCLUDED_SOURCES: readonly string[] = [
  "dynamic_text",
  "layout_suppressed",
];

/** The worst of a step's region severities, `none` when it has no region. */
function worstSeverity(severities: readonly string[] | null): Severity {
  let worst: Severity = "none";
  for (const s of severities ?? []) {
    if (severityRank(s as Severity) > severityRank(worst)) {
      worst = s as Severity;
    }
  }
  return worst;
}

interface StepRow {
  verdict: "new" | "passed" | "unresolved" | null;
  diffPercent: number | null;
  pixelMismatchCount: number | null;
  diffImageKey: string | null;
  baselineSource: "this_branch" | "parent_pr" | "default_branch" | null;
  vlmDescription: string | null;
  ruleResolved: boolean;
  diffSignature: string | null;
  diffGeneration: number;
  severities: string[] | null;
}

/** What `recomputeRunTotals` writes: the run-level totals of spec §5. */
interface RunTotals {
  diffPercent: number | null;
  pixelMisMatchCount: number | null;
  baselineSource: StepRow["baselineSource"];
  vlmDescription: string | null;
  resolutionSource: "rule" | null;
  primarySignature: string | null;
  /** `undefined` = keep the stored value (the legacy exception). */
  diffName: string | null | undefined;
}

/**
 * The pure fold from a run's steps (in capture order) to its totals. Rules,
 * from spec 2026-10-23 §5; they reproduce the diff-worker's old in-memory fold
 * over a whole run.
 *
 * A step is *compared* when it has a verdict other than `new` and its own
 * `diff_percent`: it had a baseline to diff against. Steps not yet diffed
 * (NULL verdict) and `new` steps contribute no diff numbers, whatever their
 * columns hold.
 */
function foldRunTotals(steps: readonly StepRow[]): RunTotals {
  const isCompared = (s: StepRow): boolean =>
    s.verdict !== null && s.verdict !== "new" && s.diffPercent !== null;
  const compared = steps.filter(isCompared);

  // The max `diff_percent`; a tie goes to the step captured first.
  const worstOf = (candidates: readonly StepRow[]): StepRow | null =>
    candidates.reduce<StepRow | null>(
      (acc, s) =>
        acc === null || (s.diffPercent ?? 0) > (acc.diffPercent ?? 0) ? s : acc,
      null,
    );

  const worst = worstOf(compared);

  // `diff_name` and `baseline_source` rank steps exactly as the old fold did:
  // a step that was not compared ranks as 0, ties to the step captured first.
  // `diff_name` ranks every step with a verdict, so when no compared step
  // differs (max 0%) the first such step names the image, and a `new` one
  // names none. `baseline_source` ranks every step that resolved a baseline,
  // new or not.
  const rank = (s: StepRow): number =>
    isCompared(s) ? (s.diffPercent ?? 0) : 0;
  const worstRanked = (candidates: readonly StepRow[]): StepRow | null =>
    candidates.reduce<StepRow | null>(
      (acc, s) => (acc === null || rank(s) > rank(acc) ? s : acc),
      null,
    );
  const named = worstRanked(steps.filter((s) => s.verdict !== null));
  const worstWithSource = worstRanked(
    steps.filter((s) => s.baselineSource !== null),
  );

  // A legacy run, never diffed by the per-step pipeline, has no per-step
  // image (they date from before 0041): its stored `diff_name` is the only one
  // the viewer's legacy fallback, the storage proxy's ownership probe and the
  // orphan reconcile can use. The pipeline bumps a step's version when it
  // queues it, so every step that has a verdict still at version 0 means no
  // step of the run was diffed by it. Keyed on the version, not on whether an
  // image exists: a run re-diffed to "no image anywhere" must clear its name.
  const legacy = steps.every(
    (s) => s.verdict === null || s.diffGeneration === 0,
  );

  return {
    diffPercent: worst ? worst.diffPercent : null,
    pixelMisMatchCount:
      compared.length > 0
        ? compared.reduce((sum, s) => sum + (s.pixelMismatchCount ?? 0), 0)
        : null,
    // Only a compared step's image counts, whatever a `new` step stores.
    diffName: legacy
      ? undefined
      : named !== null && isCompared(named)
        ? named.diffImageKey
        : null,
    baselineSource: worstWithSource?.baselineSource ?? null,
    vlmDescription:
      steps.find((s) => s.vlmDescription !== null && s.vlmDescription !== "")
        ?.vlmDescription ?? null,
    resolutionSource:
      !steps.some((s) => s.verdict === "unresolved") &&
      steps.some((s) => s.ruleResolved)
        ? "rule"
        : null,
    primarySignature: computePrimarySignature(
      steps.map((s) => ({
        diffSignature: s.diffSignature,
        worstSeverity: worstSeverity(s.severities),
      })),
    ),
  };
}

/**
 * Rebuilds a run's totals on `test_runs` from its steps' own columns (spec
 * 2026-10-23 §5), so the totals follow whichever step was diffed last, in
 * whatever order the per-step jobs commit:
 *
 * | column                 | rule (steps in capture order: `created_at, id`)     |
 * | ---------------------- | --------------------------------------------------- |
 * | `diff_percent`         | max over compared steps; NULL if none               |
 * | `pixel_mis_match_count`| sum over the same steps; NULL if none               |
 * | `diff_name`            | `diff_image_key` of the max step among steps with a |
 * |                        | verdict, a step not compared ranking 0 (ties:       |
 * |                        | first); NULL if it has none or was not compared.    |
 * |                        | Kept as stored on a legacy run: one                 |
 * |                        | where every step with a verdict is still at version |
 * |                        | 0 (never diffed by the per-step pipeline).          |
 * | `baseline_source`      | source of the max step among steps with a source    |
 * | `vlm_description`      | the first non-empty one                             |
 * | `resolution_source`    | `rule` iff no step is `unresolved` and one step was |
 * |                        | `rule_resolved`; else NULL                          |
 * | `primary_signature`    | `computePrimarySignature` over the steps            |
 *
 * It locks the run itself (`FOR NO KEY UPDATE`, the lock `recomputeRunStatus`
 * takes) before it reads a single step, so a step that committed while this
 * waited is visible (READ COMMITTED) and two recomputes serialize. A caller
 * that has the run locked already (every diff commit does) pays nothing for
 * the re-lock; one that holds a step lock must have taken the run first (lock
 * order: run, then step, then the step's variation).
 *
 * Writes nothing when every total is already right, so a burst of per-step
 * commits does not rewrite the hot run row for no reason.
 *
 * `tx` is the caller's transaction: a Drizzle transaction, or the scoped
 * handle `withProjectScope` passes (typed `DB`), as `recomputeRunStatus`
 * accepts. Called on a bare pool connection it would lock nothing past its
 * first statement.
 *
 * @throws `run_not_found:<runId>` when the run does not exist.
 */
export async function recomputeRunTotals(
  tx: DB | Tx,
  runId: string,
): Promise<void> {
  const [run] = await tx
    .select({
      diffPercent: testRuns.diffPercent,
      pixelMisMatchCount: testRuns.pixelMisMatchCount,
      diffName: testRuns.diffName,
      baselineSource: testRuns.baselineSource,
      vlmDescription: testRuns.vlmDescription,
      resolutionSource: testRuns.resolutionSource,
      primarySignature: testRuns.primarySignature,
    })
    .from(testRuns)
    .where(eq(testRuns.id, runId))
    .for("no key update");
  if (!run) throw new Error(`run_not_found:${runId}`);

  // One query: each step with the severities of its (non-audit) regions.
  const severities = tx
    .select({
      screenshotId: diffRegions.screenshotId,
      severities: sql<string[]>`array_agg(DISTINCT ${diffRegions.severity})`.as(
        "severities",
      ),
    })
    .from(diffRegions)
    .where(
      and(
        eq(diffRegions.runId, runId),
        notInArray(diffRegions.source, [...PRIMARY_SIGNATURE_EXCLUDED_SOURCES]),
      ),
    )
    .groupBy(diffRegions.screenshotId)
    .as("step_severities");
  const steps: StepRow[] = await tx
    .select({
      verdict: screenshots.verdict,
      diffPercent: screenshots.diffPercent,
      pixelMismatchCount: screenshots.pixelMismatchCount,
      diffImageKey: screenshots.diffImageKey,
      baselineSource: screenshots.baselineSource,
      vlmDescription: screenshots.vlmDescription,
      ruleResolved: screenshots.ruleResolved,
      diffSignature: screenshots.diffSignature,
      diffGeneration: screenshots.diffGeneration,
      severities: severities.severities,
    })
    .from(screenshots)
    .leftJoin(severities, eq(severities.screenshotId, screenshots.id))
    .where(eq(screenshots.runId, runId))
    .orderBy(asc(screenshots.createdAt), asc(screenshots.id));

  const totals = foldRunTotals(steps);
  const next = {
    diffPercent: totals.diffPercent,
    pixelMisMatchCount: totals.pixelMisMatchCount,
    diffName: totals.diffName === undefined ? run.diffName : totals.diffName,
    baselineSource: totals.baselineSource,
    vlmDescription: totals.vlmDescription,
    resolutionSource: totals.resolutionSource,
    primarySignature: totals.primarySignature,
  };
  const unchanged = (Object.keys(next) as Array<keyof typeof next>).every(
    (k) => next[k] === run[k],
  );
  if (unchanged) return;

  // Not `status` (only `recomputeRunStatus` writes it) and not `updated_at`
  // (the diff's old whole-run write never touched it either).
  await tx.update(testRuns).set(next).where(eq(testRuns.id, runId));
}
