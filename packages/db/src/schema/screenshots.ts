import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { checkpointVerdictEnum } from "./enums.js";
import { projects } from "./projects.js";
import { testRuns } from "./test_runs.js";
import { testVariations } from "./test_variations.js";

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
    testVariationId: uuid("test_variation_id")
      .notNull()
      .references(() => testVariations.id, { onDelete: "cascade" }),
    name: text("name").notNull(), // ADR-038: checkpoint name from snapshot(name)
    viewport: text("viewport").notNull(),
    browser: text("browser").notNull(),
    os: text("os"),
    device: text("device"),
    matchLevel: text("match_level").notNull().default("Strict"),
    imageKey: text("image_key").notNull(),
    domKey: text("dom_key"),
    elementMapKey: text("element_map_key"),
    ignoreRegions: jsonb("ignore_regions"),
    layoutRegions: jsonb("layout_regions"),
    floatingRegions: jsonb("floating_regions"),
    contentRegions: jsonb("content_regions"),
    accessibilityRegions: jsonb("accessibility_regions"),
    // Tier 1.4: when true, the diff engine drops L2
    // relocateGroup regions for this checkpoint. Pixel-level (L1)
    // displacement detection is a separate engine pass.
    ignoreDisplacements: boolean("ignore_displacements")
      .notNull()
      .default(false),
    // Tier 2.5: when set, the diff-worker runs axe-core
    // against the captured DOM snapshot and surfaces WCAG violations
    // as diff_regions with source='axe', category='accessibility'.
    // NULL = no accessibility check requested.
    accessibilityLevel: text("accessibility_level"),
    accessibilityVersion: text("accessibility_version"),
    // ADR-042: stable per-checkpoint diff signature (v1:<sha256> or NULL when
    // no meaningful diff). Computed at diff-time by the diff-worker; powers
    // build-scoped similarity grouping. Legacy rows stay NULL ("ungrouped").
    diffSignature: text("diff_signature"),
    // Review model (0035): what the diff found for this checkpoint against its
    // own baseline. NULL = not diffed yet (the run stays `running`). Written by
    // the diff-worker; a reviewer's decision lives in `checkpoint_decisions`.
    verdict: checkpointVerdictEnum("verdict"),
    verdictAt: timestamp("verdict_at", { withTimezone: true }),
    // Migration 0041: the storage key of this checkpoint's own diff image (PNG),
    // written by the diff-worker in the same UPDATE as `verdict`. A re-diff
    // rewrites it, to NULL when the new diff produced no image. NULL on every
    // row diffed before 0041 (the run's `test_runs.diff_name` is only its worst
    // checkpoint's). Every key-bearing column must be registered with the
    // storage proxy's ownership probes and the orphan reconcile
    // (`gatherReferencedKeys`).
    diffImageKey: text("diff_image_key"),
    // ADR-074 (migration 0040): true exactly when the step has an active
    // decision (a `checkpoint_decisions` row with `reverted_at IS NULL`).
    // A decision never rewrites the verdict, so without it every scan for
    // pending steps had to probe `checkpoint_decisions` for all of a project's
    // history. Maintained ONLY by the trigger
    // `checkpoint_decisions_sync_active_flag` on `checkpoint_decisions`
    // (insert, update of `reverted_at` / `screenshot_id`, delete); never write
    // it from the app. It is an index-usable pre-filter: `pendingStepCondition`
    // still decides with its `NOT EXISTS` on `checkpoint_decisions`.
    //
    // Not visible to Drizzle, so drizzle-kit neither creates nor drops them:
    // the trigger and its function `checkpoint_decisions_sync_active_flag()`,
    // and the MCV statistics object `screenshots_verdict_decision_stats` on
    // (`verdict`, `has_active_decision`), which keeps the planner's estimate of
    // the open steps right. They live only in migration 0040's SQL.
    hasActiveDecision: boolean("has_active_decision").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    runNameViewportUnique: unique("screenshots_run_id_name_viewport_unique").on(
      t.runId,
      t.name,
      t.viewport,
    ),
    runIdx: index("screenshots_run_idx").on(t.runId),
    testVariationIdx: index("screenshots_test_variation_id_idx").on(
      t.testVariationId,
    ),
    diffSignatureIdx: index("screenshots_diff_signature_idx").on(
      t.diffSignature,
    ),
    // ADR-074: the open steps, those a verdict makes candidates for review
    // and no active decision has settled. It holds only the work still to do,
    // so the project-wide pending scans (the queue's next batch and counts,
    // the badge, the "needs review" list) stay proportional to it rather than
    // to the project's history. `id` makes it covering: those scans need only
    // the step's id, run and project, so they read the index alone.
    pendingOpenIdx: index("screenshots_pending_open_idx")
      .on(t.projectId, t.runId, t.createdAt, t.id)
      .where(
        sql`${t.verdict} IN ('new', 'unresolved') AND NOT ${t.hasActiveDecision}`,
      ),
    // ADR-074: the steps not diffed yet (a NULL verdict), which make their
    // run non-reviewable (`reviewableRunCondition`). Every pending scan asks
    // that of each candidate step's run; this answers from a tiny index
    // instead of reading every step of the run.
    undiffedIdx: index("screenshots_undiffed_idx")
      .on(t.runId)
      .where(sql`${t.verdict} IS NULL`),
  }),
);
