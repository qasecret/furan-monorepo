import { sql, type SQL } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createDb, type DB } from "./client.js";
import { projectMembers, projects, users } from "./schema/index.js";
import {
  currentProjectId,
  currentUserId,
  currentUserRole,
  gateProjectMember,
  withProjectScope,
  withUserScope,
  type GateResult,
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

  test("onBegin runs once, after BEGIN and before the scope is set", async () => {
    const statements: string[] = [];
    const counted = createDb();
    const client = (
      counted.db as unknown as { $client: { options: { debug: unknown } } }
    ).$client;
    const events: string[] = [];
    try {
      // Connect first: a new connection reads its types before anything else.
      await counted.db.execute(sql`SELECT 1`);
      client.options.debug = (_conn: number, query: string) => {
        statements.push(query);
      };
      await withUserScope(
        counted.db,
        { userId: "77777777-7777-7777-7777-777777777777", role: "editor" },
        async (tx) => {
          events.push(`body after ${statements.length} statements`);
          await currentUserId(tx);
        },
        { onBegin: () => events.push(`onBegin after ${statements.length}`) },
      );
    } finally {
      client.options.debug = false;
      await counted.close();
    }
    // BEGIN, then onBegin; then the scope's set_config, then the body.
    expect(statements[0]).toMatch(/^begin/i);
    expect(statements[1]).toMatch(/set_config\('app\.user_id'/);
    expect(events).toEqual(["onBegin after 1", "body after 2 statements"]);
  });
});

describe.runIf(RUN_INTEGRATION)("gateProjectMember (integration)", () => {
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

  /** Rolls back whatever `fn` wrote: the rows below never outlive a test. */
  class Rollback extends Error {}
  async function inRolledBackTx<T>(fn: (tx: DB) => Promise<T>): Promise<T> {
    let out: T | undefined;
    await db
      .transaction(async (tx) => {
        out = await fn(tx as DB);
        throw new Rollback();
      })
      .catch((err: unknown) => {
        if (!(err instanceof Rollback)) throw err;
      });
    return out as T;
  }

  /** A project with one member, in `tx`, scoped as that member (an editor). */
  async function seeded(tx: DB) {
    const tag = crypto.randomUUID();
    const [user] = await tx
      .insert(users)
      .values({
        email: `gate-${tag}@scope.example`,
        hashedPassword: "x",
        firstName: "Gate",
        lastName: "Scope",
        role: "editor",
      })
      .returning({ id: users.id });
    const [member] = await tx
      .insert(projects)
      .values({ name: `gate-member-${tag}` })
      .returning({ id: projects.id });
    const [other] = await tx
      .insert(projects)
      .values({ name: `gate-other-${tag}` })
      .returning({ id: projects.id });
    await tx
      .insert(projectMembers)
      .values({ userId: user!.id, projectId: member!.id });
    await tx.execute(
      sql`SELECT set_config('app.user_id', ${user!.id}, true),
                 set_config('app.user_role', 'editor', true)`,
    );
    return { userId: user!.id, member: member!.id, other: other!.id };
  }

  const projectById = (id: string) =>
    sql`SELECT ${projects.id} FROM ${projects} WHERE ${projects.id} = ${id}`;

  test("member, non-member and missing, by query and by resolve; the role restored", async () => {
    const seen = await inRolledBackTx(async (tx) => {
      const s = await seeded(tx);
      const missing = crypto.randomUUID();
      const out: Array<[GateResult, string | null]> = [];
      for (const id of [s.member, s.other, missing]) {
        out.push([
          await gateProjectMember(tx, s.userId, { query: projectById(id) }),
          await currentUserRole(tx),
        ]);
        out.push([
          await gateProjectMember(tx, s.userId, {
            resolve: async () => (id === missing ? null : id),
          }),
          await currentUserRole(tx),
        ]);
      }
      out.push([
        await gateProjectMember(tx, s.userId, { resolve: async () => "" }),
        await currentUserRole(tx),
      ]);
      return { out, member: s.member };
    });
    // On `ok`, the project it resolved: the one it checked membership in.
    const ok = { outcome: "ok", projectId: seen.member };
    expect(seen.out).toEqual([
      [ok, "editor"],
      [ok, "editor"],
      [{ outcome: "forbidden" }, "editor"],
      [{ outcome: "forbidden" }, "editor"],
      [{ outcome: "not_found" }, "editor"],
      [{ outcome: "not_found" }, "editor"],
      [{ outcome: "not_found" }, "editor"],
    ]);
  });

  test("the lookup and a resolver's reads run as owner", async () => {
    const seen = await inRolledBackTx(async (tx) => {
      const s = await seeded(tx);
      const viaQuery = await gateProjectMember(tx, s.userId, {
        query: sql`SELECT ${projects.id} FROM ${projects}
          WHERE ${projects.id} = ${s.member}
            AND current_setting('app.user_role', true) = 'owner'`,
      });
      let roleInResolver: string | null = null;
      const viaResolve = await gateProjectMember(tx, s.userId, {
        resolve: async () => {
          roleInResolver = await currentUserRole(tx);
          return s.member;
        },
      });
      return {
        viaQuery: viaQuery.outcome,
        viaResolve: viaResolve.outcome,
        roleInResolver,
      };
    });
    expect(seen).toEqual({
      viaQuery: "ok",
      viaResolve: "ok",
      roleInResolver: "owner",
    });
  });

  test("a resolver that throws: the role is restored, the error rethrown", async () => {
    const seen = await inRolledBackTx(async (tx) => {
      const s = await seeded(tx);
      const boom = new Error("resolver failed");
      const thrown = await gateProjectMember(tx, s.userId, {
        resolve: () => Promise.reject(boom),
      }).then(
        () => null,
        (err: unknown) => err,
      );
      return { same: thrown === boom, role: await currentUserRole(tx) };
    });
    expect(seen).toEqual({ same: true, role: "editor" });
  });

  /** The Postgres error code of a query error (drizzle wraps it in `cause`). */
  const codeOf = (err: unknown): string | undefined => {
    const e = err as { code?: string; cause?: { code?: string } } | null;
    return e?.code ?? e?.cause?.code;
  };

  test("a query that raises: its own error is rethrown, not the restore's", async () => {
    const seen = await inRolledBackTx(async (tx) => {
      const s = await seeded(tx);
      // A `query` that slips its contract (two rows) raises inside the gate's
      // statement (21000), which aborts the transaction. The restore then
      // fails too (25P02), and that failure is swallowed: the caller sees the
      // query's error.
      const thrown = await gateProjectMember(tx, s.userId, {
        query: sql`SELECT ${projects.id} FROM ${projects}
          WHERE ${projects.id} IN (${s.member}, ${s.other})`,
      }).then(
        () => null,
        (err: unknown) => err,
      );
      return { code: codeOf(thrown) };
    });
    expect(seen).toEqual({ code: "21000" });
  });

  test("a failure in JS, before the statement is sent: the role is restored, the same error rethrown", async () => {
    const seen = await inRolledBackTx(async (tx) => {
      const s = await seeded(tx);
      const boom = new Error("the query could not be built");
      // drizzle calls a chunk's getSQL() while it builds the gate's statement,
      // so this one fails in JS, after the elevation and before anything is
      // sent: the transaction is still usable, and the restore must run.
      const unbuildable = {
        getSQL: (): never => {
          throw boom;
        },
      };
      const thrown = await gateProjectMember(tx, s.userId, {
        query: sql`SELECT ${unbuildable as unknown as SQL}`,
      }).then(
        () => null,
        (err: unknown) => err,
      );
      return { same: thrown === boom, role: await currentUserRole(tx) };
    });
    expect(seen).toEqual({ same: true, role: "editor" });
  });

  test("two statements, every setting transaction-local", async () => {
    const statements: string[] = [];
    const counted = createDb();
    const client = (
      counted.db as unknown as { $client: { options: { debug: unknown } } }
    ).$client;
    try {
      const outcome = await counted.db.transaction(async (tx) => {
        const s = await seeded(tx as DB);
        client.options.debug = (_conn: number, query: string) => {
          statements.push(query);
        };
        try {
          return await gateProjectMember(tx as DB, s.userId, {
            query: projectById(s.member),
          });
        } finally {
          client.options.debug = false;
          // Undo the seed: the outcome is all this test keeps.
          await tx
            .delete(projects)
            .where(sql`${projects.id} IN (${s.member}, ${s.other})`);
          await tx.delete(users).where(sql`${users.id} = ${s.userId}`);
        }
      });
      expect(outcome.outcome).toBe("ok");
      expect(statements).toHaveLength(2);
      for (const q of statements) {
        expect(q.match(/set_config\([^)]*\)/g)).toEqual([
          expect.stringMatching(/, true\)$/),
        ]);
      }
      expect(await currentUserRole(counted.db)).toBeNull();
    } finally {
      await counted.close();
    }
  });
});
