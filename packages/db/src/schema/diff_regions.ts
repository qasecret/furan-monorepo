import {
  pgTable,
  uuid,
  text,
  varchar,
  jsonb,
  timestamp,
  index,
  boolean,
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
    // v0.5+: viewport this region was detected in (e.g. "1280x720"). NULL
    // marks a legacy v0.4 single-viewport row from before multi-viewport
    // diffs landed.
    viewport: text("viewport"),
    ocrText: text("ocr_text"),
    ocrMatched: boolean("ocr_matched"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    runIdx: index("diff_regions_run_idx").on(t.runId),
    projectIdx: index("diff_regions_project_idx").on(t.projectId),
  }),
);
