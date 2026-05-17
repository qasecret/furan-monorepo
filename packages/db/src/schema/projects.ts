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
  autoApproveFeature: boolean("auto_approve_feature").notNull().default(true),
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
  l2Enabled: boolean("l2_enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
