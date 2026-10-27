import { sql } from "drizzle-orm";
import {
  boolean,
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { builds } from "./builds.js";
import {
  baselineSourceEnum,
  environmentEnum,
  resolutionSourceEnum,
  runStatusEnum,
  runStatusOverrideEnum,
} from "./enums.js";
import { projects } from "./projects.js";

export const testRuns = pgTable(
  "test_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    imageName: text("image_name"),
    diffName: text("diff_name"),
    diffPercent: doublePrecision("diff_percent"),
    diffTollerancePercent: doublePrecision("diff_tollerance_percent"),
    /**
     * Per-run override for `projects.diffThreshold`. Null = inherit the
     * project default. Same units as the project field: a 0-1 fraction
     * (e.g. 0.001 = 0.1%). Set by the in-viewer "sensitivity" slider so
     * reviewers can re-run the diff at a different threshold without
     * altering the project-wide default that every other run inherits.
     *
     * The diff worker reads `run.diffThresholdOverride ?? project.diffThreshold`
     * at the top of the handler so a setIgnoreAreas-style re-enqueue picks
     * up the override automatically.
     */
    diffThresholdOverride: doublePrecision("diff_threshold_override"),
    pixelMisMatchCount: integer("pixel_mis_match_count"),
    status: runStatusEnum("status").notNull().default("running"),
    // Review model (0035): the run-level "Force passed / Force failed" action.
    // NULL = the status is the computed rollup of checkpoint verdicts and
    // decisions ("Reset to computed" clears it).
    statusOverride: runStatusOverrideEnum("status_override"),
    // Migration 0038 (Ruling R46): true when the diff-worker's final failed
    // attempt wrote `aborted`. A later diff job that leaves every checkpoint
    // with a verdict heals such a run (back to `running`, then the rollup).
    // An SDK `/abort` or a capture-worker abort leaves it false: those stay
    // `aborted`.
    abortedByDiff: boolean("aborted_by_diff").notNull().default(false),
    buildId: uuid("build_id")
      .notNull()
      .references(() => builds.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    merge: boolean("merge").notNull().default(false),
    name: text("name").notNull(), // ADR-038: from furan.open(testName)
    customTags: text("custom_tags"),
    baselineName: text("baseline_name"),
    comment: text("comment"),
    vlmDescription: text("vlm_description"),
    branchName: text("branch_name"),
    // ADR-055: the run's parent branch in the branch hierarchy. Feeds the
    // `parent_pr` tier of `resolveBaseline` (a run with no baseline on its
    // own branch inherits from the parent). Null = no parent supplied →
    // parent tier skipped (backfill-safe). Distinct from `baselineBranchName`
    // (explicit baseline override, currently unused).
    parentBranchName: text("parent_branch_name"),
    baselineBranchName: text("baseline_branch_name"),
    tempIgnoreAreas: text("temp_ignore_areas"),
    environment: environmentEnum("environment").notNull().default("default"),
    baselineSource: baselineSourceEnum("baseline_source"),
    resolutionSource: resolutionSourceEnum("resolution_source"),
    thumbnailUrl: text("thumbnail_url"),
    checkpointCount: integer("checkpoint_count").notNull().default(0), // denormalized rollup
    // Migration 0043 (spec 2026-10-27 server reads §3.1): the run's pending
    // review work, stored so the queue, counts and lists stop re-deriving it.
    // Both are 0 unless the run is reviewable (`reviewableRunCondition`: its
    // lifecycle is not running / aborted / empty, it has no status_override
    // and no step has a NULL verdict). Then `pending_steps` counts its steps
    // with verdict `new` or `unresolved` and no active decision (exactly
    // `pendingStepCondition` without facets, diff-failed steps included), and
    // `failed_steps` those of them whose diff failed (`diff_failed_at` set).
    // Approvable = pending_steps - failed_steps. Migration 0043 backfilled
    // them (`COUNTERS_BACKFILL_SQL`, `run-counters.ts`); spec §3.2 makes
    // `recomputeRunStatus`, under the run lock, their only writer.
    pendingSteps: integer("pending_steps").notNull().default(0),
    failedSteps: integer("failed_steps").notNull().default(0),
    completedAt: timestamp("completed_at", { withTimezone: true }), // set by POST /runs/:id/complete
    primarySignature: text("primary_signature"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  // Not visible to Drizzle, so drizzle-kit neither creates nor drops it:
  // `test_runs_build_status_idx` on (build_id, status) INCLUDE (name), which
  // serves the builds list's per-page aggregation and status filters (spec
  // 2026-10-27 §2). Drizzle's index builder cannot express INCLUDE, so the
  // index lives only in migration 0043's SQL.
  (t) => ({
    projectIdx: index("test_runs_project_id_idx").on(t.projectId),
    primarySignatureIdx: index("test_runs_project_primary_sig_idx").on(
      t.projectId,
      t.primarySignature,
    ),
    // Migration 0014: the inbox reads (`inbox.list`, `inbox.count`), a
    // project's open runs newest first. Declared here since 0043; DESC NULLS
    // FIRST is what `ORDER BY ... DESC` reads.
    inboxIdx: index("test_runs_inbox_idx")
      .on(
        t.projectId,
        t.status,
        t.createdAt.desc().nullsFirst(),
        t.id.desc().nullsFirst(),
      )
      .where(sql`${t.status} IN ('unresolved', 'failed')`),
    // Migration 0043 (spec 2026-10-27 §2). The runs with pending work, for
    // the review queue, the pending counts and the "needs review" filter, so
    // they stay proportional to the open work rather than to the history.
    pendingIdx: index("test_runs_pending_idx")
      .on(t.projectId, t.buildId)
      .where(sql`${t.pendingSteps} > 0`),
    // A build's runs in capture order: `runs.list` pages. Its leading
    // `build_id` also serves every lookup by build (the FK cascade from
    // `builds` included), so 0043 dropped the narrower
    // `test_runs_build_id_idx` it supersedes.
    buildCreatedIdx: index("test_runs_build_created_idx").on(
      t.buildId,
      t.createdAt,
      t.id,
    ),
    // The storage proxy's legacy ownership probe on the run's diff image.
    diffNameIdx: index("test_runs_diff_name_idx")
      .on(t.diffName)
      .where(sql`${t.diffName} IS NOT NULL`),
    // The diff-worker reconciler's empty-run rule (every 30 s): running runs
    // not updated since its cutoff. Only the runs in flight are in it.
    runningIdx: index("test_runs_running_idx")
      .on(t.updatedAt)
      .where(sql`${t.status} = 'running'`),
  }),
);
