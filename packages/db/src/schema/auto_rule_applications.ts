import {
  boolean,
  index,
  integer,
  pgTable,
  real,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { autoRules } from "./auto_rules.js";
import { diffRegions } from "./diff_regions.js";
import { testRuns } from "./test_runs.js";

export const autoRuleApplications = pgTable(
  "auto_rule_applications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ruleId: uuid("rule_id")
      .notNull()
      .references(() => autoRules.id, { onDelete: "cascade" }),
    ruleVersion: integer("rule_version").notNull(),
    testRunId: uuid("test_run_id")
      .notNull()
      .references(() => testRuns.id, { onDelete: "cascade" }),
    diffRegionId: uuid("diff_region_id")
      .notNull()
      .references(() => diffRegions.id, { onDelete: "cascade" }),
    regionDiffPct: real("region_diff_pct").notNull(),
    severity: integer("severity").notNull(),
    won: boolean("won").notNull().default(false),
    appliedAt: timestamp("applied_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    testRunIdx: index("auto_rule_applications_test_run_idx").on(t.testRunId),
    diffRegionIdx: index("auto_rule_applications_diff_region_idx").on(
      t.diffRegionId,
    ),
    ruleIdx: index("auto_rule_applications_rule_idx").on(t.ruleId),
  }),
);
