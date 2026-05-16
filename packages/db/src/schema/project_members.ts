import { pgTable, uuid, timestamp, unique, index } from "drizzle-orm/pg-core";

import { projects } from "./projects.js";
import { users } from "./users.js";

export const projectMembers = pgTable(
  "project_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    userProjectUnique: unique("project_members_user_project_unique").on(
      t.userId,
      t.projectId,
    ),
    projectIdx: index("project_members_project_id_idx").on(t.projectId),
  }),
);
