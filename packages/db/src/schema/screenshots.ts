import { sql, type AnyColumn, type SQL } from "drizzle-orm";
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { baselineSourceEnum, checkpointVerdictEnum } from "./enums.js";
import { projects } from "./projects.js";
import { testRuns } from "./test_runs.js";
import { testVariations } from "./test_variations.js";

/**
 * The steps still awaiting a diff result (ruling R23): not failed for good,
 * and with no result newer than their queue time. That is either no verdict
 * at all or one from before the step was last queued: a re-diff keeps the
 * step's old result until the new one replaces it, so an old verdict alone
 * does not mean the current version was diffed.
 *
 * Both times are stamped with `clock_timestamp()` while the writer holds the
 * run's row lock (`FOR NO KEY UPDATE`): the queueing (`bumpStepGenerations`,
 * the reconciler's re-queue) sets `diff_queued_at`, a diff commit sets
 * `verdict_at`. The lock orders them, so both directions hold:
 *  - a result committed after the step was (re-)queued is newer than its
 *    queue time, and takes the step out of the set;
 *  - a result committed before it, even while the queueing transaction was
 *    already open and waiting for the run, is older, so the step still awaits
 *    its new version's result. (A transaction-start `now()` would not be.)
 * A comparison with NULL is unknown, so a step with a verdict but no
 * `verdict_at` or no `diff_queued_at` (rows from before the per-step
 * pipeline) does not await one.
 *
 * `screenshots_stuck_idx` is partial on exactly this predicate: a query that
 * includes it (pass `screenshots`) can read that index. Parenthesised, so it
 * composes inside `and()` and `or()` alike.
 */
export function stepAwaitingDiff(t: {
  diffFailedAt: AnyColumn;
  verdict: AnyColumn;
  verdictAt: AnyColumn;
  diffQueuedAt: AnyColumn;
}): SQL {
  return sql`(${t.diffFailedAt} IS NULL AND (${t.verdict} IS NULL OR ${t.verdictAt} < ${t.diffQueuedAt}))`;
}

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
    // (`gatherReferencedKeys`), and indexed for the probe (migration 0043).
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
    // Migration 0042: the per-step diff pipeline (spec 2026-10-23 §2). A diff
    // job is one step at one version; the version guard in the diff commit
    // turns a stale job into a no-op. None of these columns holds a storage
    // key.
    //
    // The step's version: bumped each time the step needs a new diff
    // (`bumpStepGenerations`); the reconciler re-adds a lost job at the same
    // version, except a step queued before per-step jobs, which its first
    // claim versions. A job whose generation no longer matches is stale and
    // writes nothing.
    diffGeneration: integer("diff_generation").notNull().default(0),
    // When the current version was queued; the reconciler's stuck clock.
    diffQueuedAt: timestamp("diff_queued_at", { withTimezone: true }),
    // How many times the reconciler re-queued the current version. Reset to 0
    // by `bumpStepGenerations`; the reconciler's versioning claim of a step
    // queued before per-step jobs counts as its first re-queue (1).
    diffRequeues: smallint("diff_requeues").notNull().default(0),
    // The step's own result, written with its verdict. NULL = the step had no
    // baseline pair (or predates 0042). `recomputeRunTotals` folds them into
    // the run's totals.
    diffPercent: doublePrecision("diff_percent"),
    pixelMismatchCount: integer("pixel_mismatch_count"),
    baselineSource: baselineSourceEnum("baseline_source"),
    vlmDescription: text("vlm_description"),
    // At least one of the step's regions was auto-approved by a rule.
    ruleResolved: boolean("rule_resolved").notNull().default(false),
    // Set when the step's diff failed permanently (its verdict is then
    // `unresolved`). `diff_error` is one of the fixed `DiffErrorCode`s, never a
    // message or a stack trace.
    diffFailedAt: timestamp("diff_failed_at", { withTimezone: true }),
    diffError: varchar("diff_error", { length: 64 }),
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
    // Migration 0042: the steps still awaiting a diff result
    // (`stepAwaitingDiff`, a lost re-diff included), oldest queue time first.
    // The reconciler's scan reads only this index, so it stays proportional to
    // the work in flight, not to the project's history.
    stuckIdx: index("screenshots_stuck_idx")
      .on(t.diffQueuedAt)
      .where(stepAwaitingDiff(t)),
    // Migration 0043 (spec 2026-10-27 §2). A variation's captures newest
    // first: the viewer's "newer capture" (a top-1) and `variations.history`.
    // DESC NULLS FIRST is what `ORDER BY ... DESC` reads. Its leading
    // `test_variation_id` also serves every lookup by variation (the FK
    // cascade from `test_variations` included), so 0043 dropped the narrower
    // `screenshots_test_variation_id_idx` it supersedes.
    variationCreatedIdx: index("screenshots_variation_created_idx").on(
      t.testVariationId,
      t.createdAt.desc().nullsFirst(),
      t.id.desc().nullsFirst(),
    ),
    // The storage proxy's ownership probes, one index per key column; the
    // sparse keys are partial on their own column being set.
    imageKeyIdx: index("screenshots_image_key_idx").on(t.imageKey),
    domKeyIdx: index("screenshots_dom_key_idx")
      .on(t.domKey)
      .where(sql`${t.domKey} IS NOT NULL`),
    elementMapKeyIdx: index("screenshots_element_map_key_idx")
      .on(t.elementMapKey)
      .where(sql`${t.elementMapKey} IS NOT NULL`),
    diffImageKeyIdx: index("screenshots_diff_image_key_idx")
      .on(t.diffImageKey)
      .where(sql`${t.diffImageKey} IS NOT NULL`),
  }),
);
