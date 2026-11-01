import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  unique,
  index,
  inet,
  check,
} from "drizzle-orm/pg-core";

import { projects } from "./projects.js";
import { users } from "./users.js";

export const tokens = pgTable(
  "tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    hash: text("hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    // What the token may do (ADR-064 step B): `sdk`, `read`, or `legacy` for
    // a token minted before scopes existed. Closed set enforced by
    // `tokens_scopes_chk`; mirrors `tokenScopeSchema` in `@furan/shared-types`.
    scopes: text("scopes").array().notNull().default(["sdk"]),
    // The one project the token works on. NULL = every project the owner is a
    // member of.
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "cascade",
    }),
    // NULL = never expires (only when the operator allows it).
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastUsedIp: inet("last_used_ip"),
  },
  (t) => ({
    hashUnique: unique("tokens_hash_unique").on(t.hash),
    userIdx: index("tokens_user_id_idx").on(t.userId),
    projectIdx: index("tokens_project_id_idx").on(t.projectId),
    scopesCheck: check(
      "tokens_scopes_chk",
      sql`cardinality(${t.scopes}) > 0 AND ${t.scopes} <@ ARRAY['legacy', 'sdk', 'read']::text[]`,
    ),
  }),
);
