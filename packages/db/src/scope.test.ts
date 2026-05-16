import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createDb, type DB } from "./client.js";
import { currentProjectId, withProjectScope } from "./scope.js";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN_INTEGRATION = !!DATABASE_URL;

describe.runIf(RUN_INTEGRATION)("withProjectScope (integration)", () => {
  let db: DB;
  let close: () => Promise<void>;

  beforeAll(() => {
    const created = createDb();
    db = created.db;
    close = created.close;
  });

  afterAll(async () => {
    await close();
  });

  test("sets app.current_project_id within the transaction", async () => {
    const projectId = "11111111-1111-1111-1111-111111111111";
    const seen = await withProjectScope(db, projectId, async (tx) => {
      const rows = await tx.execute<{ current_setting: string }>(
        sql`SELECT current_setting('app.current_project_id', true) AS current_setting`,
      );
      return rows[0]?.current_setting;
    });
    expect(seen).toBe(projectId);
  });

  test("setting is local to the transaction (not visible outside)", async () => {
    const projectId = "22222222-2222-2222-2222-222222222222";
    await withProjectScope(db, projectId, async () => {
      /* no-op */
    });
    const outside = await currentProjectId(db);
    expect(outside).toBeNull();
  });

  test("concurrent scopes don't leak across transactions", async () => {
    const idA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const idB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

    const [seenA, seenB] = await Promise.all([
      withProjectScope(db, idA, async (tx) => {
        const rows = await tx.execute<{ current_setting: string }>(
          sql`SELECT current_setting('app.current_project_id', true) AS current_setting`,
        );
        return rows[0]?.current_setting;
      }),
      withProjectScope(db, idB, async (tx) => {
        const rows = await tx.execute<{ current_setting: string }>(
          sql`SELECT current_setting('app.current_project_id', true) AS current_setting`,
        );
        return rows[0]?.current_setting;
      }),
    ]);

    expect(seenA).toBe(idA);
    expect(seenB).toBe(idB);
  });

  test("currentProjectId returns null when not inside a scope", async () => {
    const value = await currentProjectId(db);
    expect(value).toBeNull();
  });
});
