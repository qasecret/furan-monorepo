import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { users } from "./users.js";

/**
 * Append-only log of dashboard-side telemetry events.
 *
 * Schema deliberately wide-open: `event` is a free-form dot-case identifier
 * (e.g. `inbox.viewed`, `runs.filter_changed`), `props` is an opaque JSONB
 * blob. Downstream analytics queries narrow on `event` first (covered by
 * the composite index), then unpack `props` as needed.
 *
 * `userId` is nullable (ON DELETE SET NULL) so deletion of a user preserves
 * the historical event stream for aggregate analysis.
 */
export const dashboardTelemetryEvents = pgTable(
  "dashboard_telemetry_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    event: text("event").notNull(),
    props: jsonb("props").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    eventCreatedIdx: index("dashboard_telemetry_events_event_created_idx").on(
      t.event,
      t.createdAt,
    ),
  }),
);
