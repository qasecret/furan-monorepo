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
  }),
);
