import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { testRuns } from "./test_runs.js";
import { users } from "./users.js";

/**
 * A reviewer's marker on a run. v1 supports `decision = "rejected"` only —
 * approve uses the existing baseline-acceptance path, which already records
 * the approver on the variation's baseline row.
 *
 * One row per (run, user). Re-rejecting is an UPSERT in the application layer.
 */
export const runReviewerDecisions = pgTable(
  "run_reviewer_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => testRuns.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    decision: text("decision").notNull(),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    runIdx: index("run_reviewer_decisions_run_idx").on(t.runId),
    uniquePerReviewer: unique("run_reviewer_decisions_run_user_uniq").on(
      t.runId,
      t.userId,
    ),
    decisionCheck: check(
      "run_reviewer_decisions_decision_chk",
      sql`${t.decision} IN ('rejected')`,
    ),
  }),
);
