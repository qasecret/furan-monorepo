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
    completedAt: timestamp("completed_at", { withTimezone: true }), // set by POST /runs/:id/complete
    primarySignature: text("primary_signature"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    projectIdx: index("test_runs_project_id_idx").on(t.projectId),
    buildIdx: index("test_runs_build_id_idx").on(t.buildId),
    statusCreatedIdx: index("test_runs_status_created_idx").on(
      t.status,
      t.createdAt,
    ),
    primarySignatureIdx: index("test_runs_project_primary_sig_idx").on(
      t.projectId,
      t.primarySignature,
    ),
  }),
);
