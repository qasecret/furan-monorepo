import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { autoRuleActionEnum } from "./enums.js";
import { projects } from "./projects.js";
import { users } from "./users.js";

export const autoRules = pgTable(
  "auto_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    match: jsonb("match").notNull(),
    conditions: jsonb("conditions"),
    action: autoRuleActionEnum("action").notNull(),
    version: integer("version").notNull().default(1),
    appliedCount: integer("applied_count").notNull().default(0),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    updatedBy: uuid("updated_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => ({
    projectEnabledIdx: index("auto_rules_project_enabled_idx")
      .on(t.projectId, t.enabled)
      .where(sql`${t.deletedAt} IS NULL`),
    projectDeletedIdx: index("auto_rules_project_deleted_idx").on(
      t.projectId,
      t.deletedAt,
    ),
  }),
);
