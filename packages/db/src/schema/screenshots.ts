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
    elementMapKey: text("element_map_key"),
    viewport: text("viewport").notNull(),
    browser: text("browser").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    // ADR-033: compound uniqueness for capture-worker retry idempotency.
    // Replaces the prior global UNIQUE on image_key, which blocked
    // legitimate bytes-identical cross-run captures.
    runViewportUnique: uniqueIndex("screenshots_run_id_viewport_unique").on(
      t.runId,
      t.viewport,
    ),
    runIdx: index("screenshots_run_idx").on(t.runId),
    // Non-unique index for content-addressed lookups (ADR-032 auto-approve
    // match query reads runs by image_key).
    imageKeyIdx: index("screenshots_image_key_idx").on(t.imageKey),
  }),
);
