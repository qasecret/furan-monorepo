import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";

import { projects } from "./projects.js";

export const testVariations = pgTable(
  "test_variations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    branchName: text("branch_name"),
    browser: text("browser"),
    device: text("device"),
    os: text("os"),
    viewport: text("viewport"),
    customTags: text("custom_tags"),
    baselineName: text("baseline_name"),
    ignoreAreas: text("ignore_areas"),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
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
