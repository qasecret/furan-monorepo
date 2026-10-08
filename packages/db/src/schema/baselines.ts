import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  unique,
} from "drizzle-orm/pg-core";

import { environmentEnum } from "./enums.js";
import { testRuns } from "./test_runs.js";
import { testVariations } from "./test_variations.js";
import { users } from "./users.js";

export const baselines = pgTable(
  "baselines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    baselineName: text("baseline_name"),
    testVariationId: uuid("test_variation_id")
      .notNull()
      .references(() => testVariations.id, { onDelete: "cascade" }),
    testRunId: uuid("test_run_id")
      .notNull()
      .references(() => testRuns.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    environment: environmentEnum("environment").notNull().default("default"),
    branchName: text("branch_name").notNull().default("main"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    variationIdx: index("baselines_test_variation_id_idx").on(
      t.testVariationId,
    ),
    runIdx: index("baselines_test_run_id_idx").on(t.testRunId),
    // One baseline per (variation, run): makes recordBaseline's upsert
    // idempotent so a diff-worker retry / re-approve can't append duplicates.
    variationRunUnique: unique("baselines_variation_run_unique").on(
      t.testVariationId,
      t.testRunId,
    ),
  }),
);
