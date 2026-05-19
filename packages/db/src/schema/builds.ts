import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  index,
  uniqueIndex,
  jsonb,
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
    /**
     * Human-readable batch name (Applitools BATCH_NAME parallel). Distinct from
     * `ciBuildId`. Populated by the SDK from `FURAN_BUILD_NAME`. Display fallback
     * chain: name → "#{number}" → first 12 chars of ciBuildId → "(unnamed)".
     */
    name: text("name"),
    /**
     * Free-form K/V tags on a build (Applitools `addProperty` parallel). Enforced
     * at the Zod boundary, not via CHECK: ≤ 20 keys; keys 1–64 chars matching
     * /^[a-zA-Z0-9_.-]+$/; values ≤ 256 chars; values strings only. GIN-indexed
     * for `@>` containment filters from the dashboard.
     */
    properties: jsonb("properties")
      .$type<Record<string, string>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
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
    /**
     * Partial UNIQUE on (project_id, ci_build_id) WHERE ci_build_id IS NOT NULL.
     * Replaces the v0.x non-unique compound `builds_ci_build_id_idx`. Makes the
     * find-or-create path race-safe (8 concurrent shards → 1 row) by letting
     * Postgres resolve the conflict via `ON CONFLICT DO UPDATE`.
     */
    ciBuildUnique: uniqueIndex("builds_project_ci_build_id_unique")
      .on(t.projectId, t.ciBuildId)
      .where(sql`${t.ciBuildId} IS NOT NULL`),
    /**
     * GIN index for `properties @> '{key:value}'::jsonb` containment filters
     * from `GET /projects/:id/builds` and the tRPC `builds.list` procedure.
     */
    propertiesIdx: index("builds_properties_gin_idx").using(
      "gin",
      t.properties,
    ),
  }),
);
