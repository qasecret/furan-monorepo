import { pgTable, uuid, text, boolean, timestamp } from "drizzle-orm/pg-core";

import { userRoleEnum } from "./enums.js";
import { projects } from "./projects.js";

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  hashedPassword: text("hashed_password").notNull(),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  role: userRoleEnum("role").notNull().default("guest"),
  isActive: boolean("is_active").notNull().default(true),
  defaultProjectId: uuid("default_project_id").references(() => projects.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
