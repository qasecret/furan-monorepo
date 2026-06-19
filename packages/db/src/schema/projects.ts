import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  doublePrecision,
  timestamp,
} from "drizzle-orm/pg-core";

import { imageComparisonEnum } from "./enums.js";

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  mainBranchName: text("main_branch_name").notNull().default("main"),
  buildsCounter: integer("builds_counter").notNull().default(0),
  maxBuildAllowed: integer("max_build_allowed").notNull().default(100),
  maxBranchLifetime: integer("max_branch_lifetime").notNull().default(30),
  // Default flipped to false in migration 0016 (audit 2026-05-29): new
  // projects now require an explicit Save-as-baseline for the first run
  // of each test variation, which is the ADR-036/ADR-037 first-baseline
  // path users expect. Existing projects keep whatever they were saved
  // with; flip per-project from /projects/:id/settings.
  autoApproveFeature: boolean("auto_approve_feature").notNull().default(false),
  imageComparison: imageComparisonEnum("image_comparison")
    .notNull()
    .default("odiff"),
  imageComparisonConfig: text("image_comparison_config")
    .notNull()
    .default(
      '{"threshold":0.1,"ignoreAntialiasing":true,"allowDiffDimensions":false}',
    ),
  retentionDays: integer("retention_days").notNull().default(90),
  diffThreshold: doublePrecision("diff_threshold").notNull().default(0.001),
  dynamicTextEnabled: boolean("dynamic_text_enabled").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
