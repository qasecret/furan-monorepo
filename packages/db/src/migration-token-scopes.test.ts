import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDb, eq, projects, tokens, users, type DB } from "./index.js";

/**
 * Migration `0046_token_scopes` (ADR-064 step B): `tokens.scopes` (default
 * `{sdk}`, closed set), `project_id` (cascades with the project), `expires_at`,
 * `last_used_ip`, and the backfill that turns every existing token into a
 * `legacy` one expiring 90 days later.
 *
 * The schema half runs on the already-migrated database. The backfill
 * statement is global, so it runs inside a transaction that is rolled back,
 * leaving every other token as it was.
 *
 * Skipped when `DATABASE_URL` is unset, like the other migration tests.
 */
const RUN_INTEGRATION = !!process.env.DATABASE_URL;

const MIGRATION_SQL = RUN_INTEGRATION
  ? readFileSync(
      fileURLToPath(
        new URL("../migrations/0046_token_scopes.sql", import.meta.url),
      ),
      "utf8",
    )
  : "";

class Rollback extends Error {}

describe.runIf(RUN_INTEGRATION)("0046_token_scopes migration", () => {
  let db: DB;
  let close: () => Promise<void>;

  const tag = randomUUID().slice(0, 8);
  let userId: string;
  let projectId: string;

  beforeAll(async () => {
    const handle = createDb();
    db = handle.db;
    close = handle.close;
    const [user] = await db
      .insert(users)
      .values({
        email: `token-scopes-${tag}@t.example`,
        hashedPassword: "x",
        firstName: "Token",
        lastName: "Scopes",
      })
      .returning({ id: users.id });
    userId = user!.id;
    const [project] = await db
      .insert(projects)
      .values({ name: `token-scopes-${tag}` })
      .returning({ id: projects.id });
    projectId = project!.id;
  });

  afterAll(async () => {
    await db.delete(projects).where(eq(projects.id, projectId));
    await db.delete(users).where(eq(users.id, userId));
    await close();
  });

  const insert = (values: Partial<typeof tokens.$inferInsert> = {}) =>
    db
      .insert(tokens)
      .values({ userId, label: "t", hash: randomUUID(), ...values })
      .returning();

  it("a token without scopes gets `sdk`, no project and no expiry", async () => {
    const [row] = await insert();
    expect(row).toMatchObject({
      scopes: ["sdk"],
      projectId: null,
      expiresAt: null,
      lastUsedIp: null,
    });
  });

  it("the scopes are a non-empty subset of legacy / sdk / read", async () => {
    await expect(insert({ scopes: ["admin"] })).rejects.toThrow();
    await expect(insert({ scopes: [] })).rejects.toThrow();
    await expect(insert({ scopes: ["sdk", "nope"] })).rejects.toThrow();
    const [row] = await insert({ scopes: ["read"] });
    expect(row?.scopes).toEqual(["read"]);
  });

  it("deleting the project deletes the tokens bound to it", async () => {
    const [p] = await db
      .insert(projects)
      .values({ name: `token-scopes-gone-${tag}` })
      .returning({ id: projects.id });
    const [bound] = await insert({ projectId: p!.id });
    await db.delete(projects).where(eq(projects.id, p!.id));
    const left = await db
      .select({ id: tokens.id })
      .from(tokens)
      .where(eq(tokens.id, bound!.id));
    expect(left).toEqual([]);
  });

  it("the backfill makes existing tokens legacy, expiring in 90 days", async () => {
    const backfill = MIGRATION_SQL.split("--> statement-breakpoint")
      .map((s) => s.trim())
      .find((s) => s.startsWith('UPDATE "tokens"'));
    expect(backfill).toBeDefined();

    const [row] = await insert();
    let seen: { scopes: string[]; days: number } | undefined;
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql.raw(backfill!));
        const [after] = await tx
          .select({
            scopes: tokens.scopes,
            days: sql<number>`extract(epoch from (${tokens.expiresAt} - now())) / 86400`,
          })
          .from(tokens)
          .where(eq(tokens.id, row!.id));
        seen = { scopes: after!.scopes, days: Number(after!.days) };
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);

    expect(seen?.scopes).toEqual(["legacy"]);
    expect(seen?.days).toBeCloseTo(90, 3);
  });
});
