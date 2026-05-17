import {
  pgTable,
  uuid,
  text,
  integer,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

import { webhooks } from "./webhooks.js";

/**
 * Outbound-webhook delivery attempts (T9).
 *
 * One row per (webhook, event-instance). The delivery worker writes a row
 * on each attempt — `attempts` increments, `status` flips between
 * `pending`, `delivered`, or `dlq`. Cascade-deleted with the parent
 * `webhooks` row so a project teardown clears history without orphans.
 *
 * `payload` is JSONB so the consumer can re-render or inspect the delivered
 * body without having to reconstruct it from event sources.
 */
export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    webhookId: uuid("webhook_id")
      .notNull()
      .references(() => webhooks.id, { onDelete: "cascade" }),
    event: text("event").notNull(),
    payload: jsonb("payload").notNull(),
    attempts: integer("attempts").notNull().default(0),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    // pending | delivered | dlq
    status: text("status").notNull().default("pending"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    statusIdx: index("webhook_deliveries_status_idx").on(t.status),
    webhookIdx: index("webhook_deliveries_webhook_idx").on(t.webhookId),
  }),
);
