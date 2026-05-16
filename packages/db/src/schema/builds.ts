import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

import { environmentEnum } from "./enums.js";
import { projects } from "./projects.js";
import { users } from "./users.js";

export const builds = pgTable(
  "builds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ciBuildId: text("ci_build_id"),
    number: integer("number"),
    branchName: text("branch_name"),
    status: text("status"),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    isRunning: boolean("is_running").notNull().default(false),
    environment: environmentEnum("environment").notNull().default("default"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    projectIdx: index("builds_project_id_idx").on(t.projectId),
    ciBuildIdx: index("builds_ci_build_id_idx").on(t.projectId, t.ciBuildId),
  }),
);
