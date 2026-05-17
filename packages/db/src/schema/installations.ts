import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { projects } from "./projects.js";

/**
 * GitHub App installations.
 *
 * One row per `installation` event from the GitHub App webhook
 * (T8: `apps/integrations/src/github/webhook-handlers.ts`).
 *
 * `installationId` is the GitHub-provided numeric ID (unique across the App).
 * `repositoryIds` mirrors the set of repos the App is installed against —
 * mutated on `installation_repositories.{added,removed}` events.
 *
 * `projectId` is nullable because the link from an installation to a Furan
 * project is established later (project settings UI or auto-match by repo
 * name). T8 just writes the inbound state; later tasks add the link.
 */
export const installations = pgTable(
  "installations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    installationId: integer("installation_id").notNull(),
    accountLogin: text("account_login").notNull(),
    repositoryIds: integer("repository_ids").array().notNull().default([]),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "cascade",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    installationIdUnique: uniqueIndex(
      "installations_installation_id_unique",
    ).on(t.installationId),
  }),
);
