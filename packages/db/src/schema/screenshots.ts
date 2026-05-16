import {
  pgTable,
  uuid,
  text,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

import { projects } from "./projects.js";
import { testRuns } from "./test_runs.js";

export const screenshots = pgTable(
  "screenshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => testRuns.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    imageKey: text("image_key").notNull(),
    domKey: text("dom_key"),
    viewport: text("viewport").notNull(),
    browser: text("browser").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    imageKeyUnique: uniqueIndex("screenshots_image_key_unique").on(t.imageKey),
    runIdx: index("screenshots_run_idx").on(t.runId),
  }),
);
