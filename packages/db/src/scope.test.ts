import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createDb, type DB } from "./client.js";
import {
  currentProjectId,
  currentUserId,
  currentUserRole,
  withProjectScope,
  withUserScope,
} from "./scope.js";

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

describe.runIf(RUN_INTEGRATION)("withUserScope (integration)", () => {
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

  test("pins user_id + user_role (+ project marker) within the transaction", async () => {
    const userId = "33333333-3333-3333-3333-333333333333";
    const projectId = "44444444-4444-4444-4444-444444444444";
    const seen = await withUserScope(
      db,
      { userId, role: "editor", projectId },
      async (tx) => ({
        uid: await currentUserId(tx),
        role: await currentUserRole(tx),
        pid: await currentProjectId(tx),
      }),
    );
    expect(seen).toEqual({ uid: userId, role: "editor", pid: projectId });
  });

  test("identity is local to the transaction (does not leak to the pool)", async () => {
    await withUserScope(
      db,
      { userId: "55555555-5555-5555-5555-555555555555", role: "admin" },
      async () => {
        /* no-op */
      },
    );
    // A subsequent query on a reused pooled connection must see no identity —
    // this is the fail-closed guarantee RLS depends on.
    expect(await currentUserId(db)).toBeNull();
    expect(await currentUserRole(db)).toBeNull();
  });

  test("omitted projectId leaves the project marker unset", async () => {
    const pid = await withUserScope(
      db,
      { userId: "66666666-6666-6666-6666-666666666666", role: "guest" },
      async (tx) => currentProjectId(tx),
    );
    expect(pid).toBeNull();
  });

  test("concurrent user scopes don't leak across transactions", async () => {
    const [a, b] = await Promise.all([
      withUserScope(
        db,
        { userId: "aaaaaaaa-0000-0000-0000-000000000001", role: "editor" },
        async (tx) => currentUserId(tx),
      ),
      withUserScope(
        db,
        { userId: "bbbbbbbb-0000-0000-0000-000000000002", role: "admin" },
        async (tx) => currentUserId(tx),
      ),
    ]);
    expect(a).toBe("aaaaaaaa-0000-0000-0000-000000000001");
    expect(b).toBe("bbbbbbbb-0000-0000-0000-000000000002");
  });

  test("currentUserId / currentUserRole return null with no identity set", async () => {
    expect(await currentUserId(db)).toBeNull();
    expect(await currentUserRole(db)).toBeNull();
  });
});
