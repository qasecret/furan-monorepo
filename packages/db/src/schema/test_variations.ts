import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { projects } from "./projects.js";

export const testVariations = pgTable(
  "test_variations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    branchName: text("branch_name"),
    browser: text("browser"),
    device: text("device"),
    os: text("os"),
    viewport: text("viewport"),
    customTags: text("custom_tags"),
    baselineName: text("baseline_name"),
    ignoreRegions: jsonb("ignore_regions"), // renamed from ignore_areas
    layoutRegions: jsonb("layout_regions"),
    floatingRegions: jsonb("floating_regions"),
    contentRegions: jsonb("content_regions"),
    accessibilityRegions: jsonb("accessibility_regions"),
    matchLevel: text("match_level").notNull().default("Strict"),
    comment: text("comment"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    projectIdx: index("test_variations_project_id_idx").on(t.projectId),
  }),
);
