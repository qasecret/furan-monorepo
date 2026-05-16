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
