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
import { screenshots } from "./screenshots.js";
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
    // v1.1.20+: screenshot (= checkpoint) this region was detected on.
    // Required for per-checkpoint accuracy in the diff viewer + rail —
    // before this column, two checkpoints in one run that shared a
    // viewport (e.g. HomePage + searchResult both at 1280x720) would
    // see each other's diff regions because the previous unique key
    // was just (run_id, viewport). Nullable so legacy rows from pre-
    // v1.1.20 runs survive; the diff viewer treats null as "show on
    // every checkpoint" (fallback).
    screenshotId: uuid("screenshot_id").references(() => screenshots.id, {
      onDelete: "cascade",
    }),
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
    // The auto_rule_application that resolved this region (auto_approve), or
    // null. Intentionally NOT a DB foreign key: auto_rule_applications already
    // references diff_regions.id (cascade), so a real FK here would create a
    // circular table dependency. The diff-worker writes this only with ids it
    // just inserted in the same flow, and an orphan would at worst lose
    // provenance (the join returns no row) — never corrupt a diff. If this is
    // ever widened to external writers, add a deferred FK with ON DELETE SET NULL.
    resolvedByApplicationId: uuid("resolved_by_application_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    runIdx: index("diff_regions_run_idx").on(t.runId),
    projectIdx: index("diff_regions_project_idx").on(t.projectId),
    screenshotIdx: index("diff_regions_screenshot_idx").on(t.screenshotId),
  }),
);
