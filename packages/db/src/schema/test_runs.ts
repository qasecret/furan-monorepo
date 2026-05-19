import {
  pgTable,
  uuid,
  text,
  integer,
  doublePrecision,
  boolean,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

import { builds } from "./builds.js";
import { baselineSourceEnum, environmentEnum, runStatusEnum } from "./enums.js";
import { projects } from "./projects.js";
import { testVariations } from "./test_variations.js";

export const testRuns = pgTable(
  "test_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    imageName: text("image_name"),
    diffName: text("diff_name"),
    diffPercent: doublePrecision("diff_percent"),
    diffTollerancePercent: doublePrecision("diff_tollerance_percent"),
    pixelMisMatchCount: integer("pixel_mis_match_count"),
    status: runStatusEnum("status").notNull().default("running"),
    buildId: uuid("build_id")
      .notNull()
      .references(() => builds.id, { onDelete: "cascade" }),
    testVariationId: uuid("test_variation_id")
      .notNull()
      .references(() => testVariations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    merge: boolean("merge").notNull().default(false),
    name: text("name"),
    browser: text("browser"),
    device: text("device"),
    os: text("os"),
    viewport: text("viewport"),
    customTags: text("custom_tags"),
    baselineName: text("baseline_name"),
    comment: text("comment"),
    branchName: text("branch_name"),
    baselineBranchName: text("baseline_branch_name"),
    ignoreAreas: text("ignore_areas"),
    tempIgnoreAreas: text("temp_ignore_areas"),
    environment: environmentEnum("environment").notNull().default("default"),
    baselineSource: baselineSourceEnum("baseline_source"),
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
    variationIdx: index("test_runs_test_variation_id_idx").on(
      t.testVariationId,
    ),
  }),
);
