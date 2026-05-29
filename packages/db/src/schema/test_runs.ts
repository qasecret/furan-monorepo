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
import { projects } from "./projects.js";
import { builds } from "./builds.js";
import { baselineSourceEnum, environmentEnum, runStatusEnum } from "./enums.js";

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
    branchName: text("branch_name"),
    baselineBranchName: text("baseline_branch_name"),
    tempIgnoreAreas: text("temp_ignore_areas"),
    environment: environmentEnum("environment").notNull().default("default"),
    baselineSource: baselineSourceEnum("baseline_source"),
    thumbnailUrl: text("thumbnail_url"),
    checkpointCount: integer("checkpoint_count").notNull().default(0), // denormalized rollup
    completedAt: timestamp("completed_at", { withTimezone: true }), // set by POST /runs/:id/complete
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
  }),
);
