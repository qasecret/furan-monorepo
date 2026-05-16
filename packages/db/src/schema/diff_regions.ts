import {
  pgTable,
  uuid,
  text,
  varchar,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

import { projects } from "./projects.js";
import { testRuns } from "./test_runs.js";

export const diffRegions = pgTable(
  "diff_regions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => testRuns.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    severity: text("severity").notNull(),
    category: text("category").notNull(),
    bbox: jsonb("bbox").notNull(),
    description: varchar("description", { length: 200 }).notNull(),
    source: text("source").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    runIdx: index("diff_regions_run_idx").on(t.runId),
    projectIdx: index("diff_regions_project_idx").on(t.projectId),
  }),
);
