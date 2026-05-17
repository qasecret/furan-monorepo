import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

import { projects } from "./projects.js";

export const webhooks = pgTable(
  "webhooks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    // T9 (additive): `secret` is the plain shared-secret the delivery worker
    // signs payloads with. Nullable for compatibility with legacy rows
    // populated only with `secret_hash`; the T9 delivery worker DLQs any
    // delivery whose webhook has `secret IS NULL` (defensive).
    // The pre-existing `secret_hash` column is kept in place to avoid a
    // destructive rename — drizzle-kit rename detection is fragile, no
    // application code reads `secret_hash` today, so a future housekeeping
    // migration can drop it once we're sure nothing else regenerated it.
    secret: text("secret"),
    secretHash: text("secret_hash").notNull(),
    events: text("events").array().notNull().default([]),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastDeliveredAt: timestamp("last_delivered_at", { withTimezone: true }),
    lastStatus: text("last_status"),
  },
  (t) => ({
    projectIdx: index("webhooks_project_id_idx").on(t.projectId),
  }),
);
