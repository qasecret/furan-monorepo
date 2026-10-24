import {
  and,
  asc,
  autoRuleApplications,
  autoRules,
  diffRegions,
  eq,
  healPipelineAbort,
  inArray,
  recomputeRunStatus,
  recomputeRunTotals,
  recordBaseline,
  screenshots,
  sql,
  testRuns,
  withProjectScope,
  type RunStatus,
} from "@furan/db";
import type { Telemetry } from "@furan/telemetry";

import { autoApproveBaselineBlock } from "./auto-approve-guard.js";
import { pgErrorCode } from "./diff-error.js";
import type { StepResult } from "./diff-step.js";
import type { HandlerDeps } from "./handler.js";

type Logger = Telemetry["logger"];

/** The step job a result is committed for. */
export interface StepCommitJob {
  runId: string;
  projectId: string;
  screenshotId: string;
  /** The step's version (`screenshots.diff_generation`) the job was queued at. */
  generation: number;
}

/** What `commitStep` did. */
export type StepCommit =
  /** The step (or its run) is gone, or a newer version owns it: nothing written. */
  | { kind: "stale" }
  | {
      kind: "committed";
      /** The run status before and after the commit (`recomputeRunStatus`). */
      rollup: { before: RunStatus; after: RunStatus };
      /** The inserted `diff_regions` ids, in `result.regions` order. */
      regionIds: string[];
    };

const STALE: StepCommit = { kind: "stale" };

/**
 * Commits one step's diff result (spec 2026-10-23 §4.3), in ONE transaction
 * (READ COMMITTED), in this order:
 *  1. lock the run row (`FOR NO KEY UPDATE`);
 *  2. lock the step row (`FOR UPDATE`) and re-check its version: if it is no
 *     longer `job.generation` (or the run or the step is gone), a newer job
 *     owns the step and nothing is written (`stale`). This guard is what keeps
 *     two jobs of one step from duplicating or losing its regions, and what
 *     discards a job in flight against a baseline an undo replaced;
 *  3. replace the step's `diff_regions` (its `auto_rule_applications` go with
 *     them, by cascade), returning the new ids;
 *  4. write the step's verdict and its own result columns, and clear any
 *     earlier failure;
 *  5. auto-approved: the step becomes its variation's baseline, unless
 *     `autoApproveBaselineBlock` keeps the one there. That guard locks the
 *     step's single variation, the last lock taken (run -> step -> variation,
 *     the order every review path follows: runs, then variations);
 *  6. the step's dynamic-text OCR audit rows;
 *  7. the run totals, rebuilt from the steps' stored columns;
 *  8. heal an abort the old whole-run pipeline wrote;
 *  9. the run status, derived last (`recomputeRunStatus`, the only writer of
 *     `test_runs.status` after a diff, so a reviewer's decision survives).
 * The totals and the status land in the same transaction, so a reader that
 * sees the run leave `running` sees its final totals too.
 */
export async function commitStep(
  deps: HandlerDeps,
  job: StepCommitJob,
  result: StepResult,
  logger: Logger,
): Promise<StepCommit> {
  return withProjectScope(deps.db, job.projectId, async (tx) => {
    // 1. The run first: every diff commit of the run queues here.
    const [run] = await tx
      .select({
        id: testRuns.id,
        name: testRuns.name,
        baselineName: testRuns.baselineName,
        branchName: testRuns.branchName,
      })
      .from(testRuns)
      .where(eq(testRuns.id, job.runId))
      .for("no key update");
    if (!run) return STALE;

    // 2. Then the step, and the version guard.
    const [step] = await tx
      .select({
        generation: screenshots.diffGeneration,
        testVariationId: screenshots.testVariationId,
        imageKey: screenshots.imageKey,
      })
      .from(screenshots)
      .where(
        and(
          eq(screenshots.id, job.screenshotId),
          eq(screenshots.runId, job.runId),
        ),
      )
      .for("update");
    if (!step || step.generation !== job.generation) return STALE;

    // 3. Replace, never append: a retry or a re-diff of the step rewrites its
    // regions (and its OCR audit rows, re-inserted below).
    await tx
      .delete(diffRegions)
      .where(eq(diffRegions.screenshotId, job.screenshotId));
    let regionIds: string[] = [];
    if (result.regions.length > 0) {
      const inserted = await tx
        .insert(diffRegions)
        .values(
          result.regions.map((r) => ({
            runId: job.runId,
            projectId: job.projectId,
            screenshotId: job.screenshotId,
            severity: r.severity,
            category: r.category,
            bbox: r.bbox,
            description: r.description,
            source: r.source,
            viewport: r.viewport,
          })),
        )
        .returning({ id: diffRegions.id });
      regionIds = inserted.map((r) => r.id);
    }

    // 4. The step's verdict (spec §3), its ADR-042 signature, its own diff
    // image and numbers. A re-diff rewrites them all, so a step that no
    // longer differs loses its image; a success clears an earlier failure.
    await tx
      .update(screenshots)
      .set({
        verdict: result.verdict,
        verdictAt: sql`clock_timestamp()`,
        diffSignature: result.diffSignature,
        diffImageKey: result.diffImageKey,
        diffPercent: result.diffPercent,
        pixelMismatchCount: result.pixelMismatchCount,
        baselineSource: result.baselineSource,
        vlmDescription: result.vlmDescription,
        ruleResolved: result.ruleResolved,
        diffFailedAt: null,
        diffError: null,
      })
      .where(eq(screenshots.id, job.screenshotId));

    // 5. Auto-approved: the step becomes its own variation's baseline; no
    // user (NULL) marks it as auto (the SDK's per-run `autoApproved` flag
    // reads exactly that). The verdict is the auto-approve's either way; the
    // baseline is written only when no reviewer decided the step, its paired
    // baseline is not its own row, and no baseline of the variation is newer
    // than this run, so a re-diff never rewrites a reviewer's baseline or puts
    // an older image back as the current one.
    if (result.autoApprove) {
      if (!run.branchName) {
        throw new Error(`run_missing_branch_name:${job.runId}`);
      }
      const blocked = await autoApproveBaselineBlock(tx, {
        screenshotId: job.screenshotId,
        testVariationId: step.testVariationId,
        runId: run.id,
        branchName: run.branchName,
        pairedBaselineRunId: result.autoApprove.pairedBaselineRunId,
      });
      if (blocked) {
        logger.info(
          {
            runId: job.runId,
            screenshotId: job.screenshotId,
            variationId: step.testVariationId,
            reason: blocked,
          },
          "diff_auto_approve_baseline_kept",
        );
      } else {
        await recordBaseline(tx, {
          testVariationId: step.testVariationId,
          testRunId: run.id,
          imageKey: step.imageKey,
          runName: run.baselineName ?? run.name,
          branchName: run.branchName,
        });
      }
    }

    // 6. Synthetic audit rows for the step's dynamic-text OCR decisions
    // (matched OR unmatched), one per region.
    if (result.ocrAudit.length > 0) {
      await tx.insert(diffRegions).values(
        result.ocrAudit.map((row) => ({
          runId: job.runId,
          projectId: job.projectId,
          ...row,
        })),
      );
    }

    // 7. The run totals, from every step's stored columns (spec §5).
    await recomputeRunTotals(tx, job.runId);

    // 8. An abort the old whole-run pipeline wrote heals once every step of
    // the run has a verdict (`healPipelineAbort`, under the run lock held).
    if (await healPipelineAbort(tx, job.runId)) {
      logger.info({ runId: job.runId }, "diff_pipeline_abort_healed");
    }

    // 9. Last, after every child-row write: derive the run status.
    const { before, after } = await recomputeRunStatus(tx, job.runId);
    return { kind: "committed", rollup: { before, after }, regionIds };
  });
}

/**
 * After a step's commit: the `auto_rule_applications` of its regions, and each
 * region's link to the application that won it (`resolved_by_application_id`).
 *
 * Runs in its OWN transaction, fail-open: a failure here loses only the rule
 * audit trail (logged, and counted on the rules-errors metric), never the
 * step's verdict or regions. `regionIds` are the ids the commit inserted, in
 * `result.regions` order, so zipping them with `result.engineIds` maps each
 * rule decision to its stored region. A foreign-key violation (`23503`) means
 * a newer version of the step committed in between and replaced those
 * regions: the trail is stale, not failed, so it is logged at info only.
 *
 * `auto_rules.applied_count` is credited in ascending rule id: the rows are
 * locked in that order first, so two jobs crediting the same rules at once
 * queue on them instead of deadlocking.
 */
export async function persistRuleApplications(
  deps: HandlerDeps,
  args: {
    runId: string;
    projectId: string;
    result: StepResult;
    regionIds: string[];
  },
  logger: Logger,
): Promise<void> {
  const { runId, projectId, result, regionIds } = args;
  if (result.ruleDecisions.length === 0 || regionIds.length === 0) return;
  try {
    const regionIdByEngineId = new Map<string, string>();
    result.engineIds.forEach((engineId, i) => {
      const regionId = regionIds[i];
      if (regionId !== undefined) regionIdByEngineId.set(engineId, regionId);
    });

    const applicationRows = result.ruleDecisions.flatMap((decision) => {
      const diffRegionId = regionIdByEngineId.get(decision.regionId);
      if (!diffRegionId) return [];
      return decision.matchedRules.map((rm) => ({
        ruleId: rm.ruleId,
        ruleVersion: rm.ruleVersion,
        testRunId: runId,
        diffRegionId,
        regionDiffPct: rm.regionDiffPct,
        // Policy rank of the rule's ACTION (1=auto_approve, 2=flag), not the
        // region's visual severity — see auto_rule_applications schema.
        actionPriority: rm.severity,
        won: rm.won,
      }));
    });
    if (applicationRows.length === 0) return;

    await withProjectScope(deps.db, projectId, async (tx) => {
      const insertedApps = await tx
        .insert(autoRuleApplications)
        .values(applicationRows)
        .returning({
          id: autoRuleApplications.id,
          diffRegionId: autoRuleApplications.diffRegionId,
          won: autoRuleApplications.won,
        });

      // Link each region to its WINNING application in one statement
      // (UPDATE … FROM VALUES) rather than one round-trip per winner.
      const wonApps = insertedApps.filter((a) => a.won);
      if (wonApps.length > 0) {
        await tx.execute(sql`
          UPDATE diff_regions SET resolved_by_application_id = v.app_id::uuid
          FROM (VALUES ${sql.join(
            wonApps.map((a) => sql`(${a.diffRegionId}::uuid, ${a.id}::uuid)`),
            sql`, `,
          )}) AS v(region_id, app_id)
          WHERE diff_regions.id = v.region_id
        `);
      }

      // Credit applied_count ONLY to rules that actually won a region; a rule
      // that matched but lost the severity tiebreak resolved nothing.
      const countsByRule = new Map<string, number>();
      for (const row of applicationRows) {
        if (!row.won) continue;
        countsByRule.set(row.ruleId, (countsByRule.get(row.ruleId) ?? 0) + 1);
      }
      if (countsByRule.size === 0) return;
      // Lowercase uuid text sorts like Postgres's uuid order.
      const credits = [...countsByRule].sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      );
      // The UPDATE's join order is the planner's, so take the row locks
      // first, in ascending id, then credit them.
      await tx
        .select({ id: autoRules.id })
        .from(autoRules)
        .where(
          inArray(
            autoRules.id,
            credits.map(([id]) => id),
          ),
        )
        .orderBy(asc(autoRules.id))
        .for("no key update");
      await tx.execute(sql`
        UPDATE auto_rules SET applied_count = applied_count + v.cnt
        FROM (VALUES ${sql.join(
          credits.map(([id, cnt]) => sql`(${id}::uuid, ${cnt}::int)`),
          sql`, `,
        )}) AS v(id, cnt)
        WHERE auto_rules.id = v.id
      `);
    });
  } catch (err) {
    if (pgErrorCode(err) === "23503") {
      logger.info(
        { runId, projectId, screenshotId: result.screenshotId },
        "auto_rule_applications_stale",
      );
      return;
    }
    logger.error(
      { err, runId, projectId, screenshotId: result.screenshotId },
      "auto-rule application persistence failed; run result preserved",
    );
    deps.metrics?.rulesEvaluationErrors.inc();
  }
}
