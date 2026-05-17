import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDb, type DB } from "./client.js";
import { projects } from "./schema/index.js";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN_INTEGRATION = !!DATABASE_URL;

/**
 * Behavior-level test for migration `0006_smiling_boomerang.sql`.
 *
 * The migration has two statements:
 *   1. ALTER TABLE projects ALTER COLUMN image_comparison SET DEFAULT 'odiff';
 *   2. UPDATE projects SET image_comparison = 'odiff'
 *        WHERE image_comparison = 'pixelmatch';
 *
 * We can't re-run the migration in isolation (it already ran on this DB),
 * but we can verify the semantic guarantees the migration encodes:
 *
 *   - New rows default to 'odiff' (validates statement #1's effect).
 *   - The UPDATE's WHERE clause only rewrites 'pixelmatch' rows.
 *   - 'looks_same' and existing 'odiff' rows are untouched.
 *   - Re-running the UPDATE is idempotent.
 *
 * Each scenario inserts a unique project row, exercises the UPDATE
 * statement against it, asserts behavior, then deletes the row. The
 * tests do not depend on prior DB state.
 */
describe.runIf(RUN_INTEGRATION)(
  "migration 0006 — image_comparison default + data rewrite",
  () => {
    let db: DB;
    let close: () => Promise<void>;
    const createdProjectNames: string[] = [];

    beforeAll(() => {
      const created = createDb();
      db = created.db;
      close = created.close;
    });

    afterAll(async () => {
      if (createdProjectNames.length > 0) {
        for (const name of createdProjectNames) {
          await db.delete(projects).where(eq(projects.name, name));
        }
      }
      await close();
    });

    function uniqueName(label: string): string {
      const name = `migration-0006-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      createdProjectNames.push(name);
      return name;
    }

    it("new projects inserted without imageComparison default to 'odiff' (statement #1)", async () => {
      const name = uniqueName("default");
      const [row] = await db
        .insert(projects)
        .values({ name })
        .returning({ imageComparison: projects.imageComparison });
      expect(row?.imageComparison).toBe("odiff");
    });

    it("UPDATE rewrites 'pixelmatch' rows to 'odiff' (statement #2 forward case)", async () => {
      const name = uniqueName("rewrite-pixelmatch");
      const [row] = await db
        .insert(projects)
        .values({ name, imageComparison: "pixelmatch" })
        .returning({ id: projects.id });
      const id = row!.id;

      // Run the exact UPDATE from the migration.
      await db.execute(
        sql`UPDATE "projects" SET "image_comparison" = 'odiff' WHERE "image_comparison" = 'pixelmatch'`,
      );

      const [after] = await db
        .select({ imageComparison: projects.imageComparison })
        .from(projects)
        .where(eq(projects.id, id))
        .limit(1);
      expect(after?.imageComparison).toBe("odiff");
    });

    it("UPDATE leaves 'looks_same' rows unchanged (statement #2 WHERE-clause guard)", async () => {
      const name = uniqueName("preserve-looks-same");
      const [row] = await db
        .insert(projects)
        .values({ name, imageComparison: "looks_same" })
        .returning({ id: projects.id });
      const id = row!.id;

      await db.execute(
        sql`UPDATE "projects" SET "image_comparison" = 'odiff' WHERE "image_comparison" = 'pixelmatch'`,
      );

      const [after] = await db
        .select({ imageComparison: projects.imageComparison })
        .from(projects)
        .where(eq(projects.id, id))
        .limit(1);
      expect(after?.imageComparison).toBe("looks_same");
    });

    it("UPDATE leaves existing 'odiff' rows unchanged", async () => {
      const name = uniqueName("preserve-odiff");
      const [row] = await db
        .insert(projects)
        .values({ name, imageComparison: "odiff" })
        .returning({ id: projects.id });
      const id = row!.id;

      await db.execute(
        sql`UPDATE "projects" SET "image_comparison" = 'odiff' WHERE "image_comparison" = 'pixelmatch'`,
      );

      const [after] = await db
        .select({ imageComparison: projects.imageComparison })
        .from(projects)
        .where(eq(projects.id, id))
        .limit(1);
      expect(after?.imageComparison).toBe("odiff");
    });

    it("UPDATE is idempotent — re-running on already-migrated state is a no-op", async () => {
      const name = uniqueName("idempotent");
      const [row] = await db
        .insert(projects)
        .values({ name, imageComparison: "pixelmatch" })
        .returning({ id: projects.id });
      const id = row!.id;

      // First UPDATE: rewrites this row. RETURNING gives us the affected count.
      const first = await db.execute<{ id: string }>(
        sql`UPDATE "projects" SET "image_comparison" = 'odiff' WHERE "image_comparison" = 'pixelmatch' AND "id" = ${id} RETURNING "id"`,
      );
      expect(first.length).toBe(1);

      // Second UPDATE: WHERE clause matches nothing now.
      const second = await db.execute<{ id: string }>(
        sql`UPDATE "projects" SET "image_comparison" = 'odiff' WHERE "image_comparison" = 'pixelmatch' AND "id" = ${id} RETURNING "id"`,
      );
      expect(second.length).toBe(0);

      const [after] = await db
        .select({ imageComparison: projects.imageComparison })
        .from(projects)
        .where(eq(projects.id, id))
        .limit(1);
      expect(after?.imageComparison).toBe("odiff");
    });
  },
);
