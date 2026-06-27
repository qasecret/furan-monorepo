import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Durable, queryable trail of privileged actions (who did what to whom).
 *
 * `actor_id` is intentionally FK-less so a record survives the actor's deletion
 * (the actor's email is LEFT-JOINed from `users` at read time, null if gone) —
 * same rationale as diff_regions.resolved_by_application_id. Written best-effort
 * by `emitAudit()` (a failure is logged, never blocks the audited mutation).
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorId: uuid("actor_id"),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: uuid("target_id"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    createdIdx: index("audit_log_created_idx").on(t.createdAt),
    targetIdx: index("audit_log_target_idx").on(t.targetType, t.targetId),
    actorIdx: index("audit_log_actor_idx").on(t.actorId),
  }),
);
