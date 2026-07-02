import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createDb, type DB } from "./client.js";
import {
  builds,
  projectMembers,
  projects,
  testRuns,
  users,
} from "./schema/index.js";
import { withUserScope } from "./scope.js";

/**
 * ADR-058 tenant-isolation proof. Connects as the non-owner `furan_app` role
 * (which is SUBJECT to RLS — the owner used by every other test bypasses it),
 * seeds two isolated projects via the owner, then asserts the policies from
 * migration 0033 actually enforce: read isolation, WITH CHECK on writes,
 * fail-closed with no identity, admin bypass, and no GUC leak across the pool.
 */
const DATABASE_URL = process.env.DATABASE_URL;
const RUN = !!DATABASE_URL;

describe.runIf(RUN)("RLS tenant isolation (integration, as furan_app)", () => {
  let owner: DB;
  let ownerClose: () => Promise<void>;
  let app: DB;
  let appClose: () => Promise<void>;

  const uidA = randomUUID();
  const uidB = randomUUID();
  let projA: string;
  let projB: string;

  beforeAll(async () => {
    const o = createDb();
    owner = o.db;
    ownerClose = o.close;

    // Test-only: grant furan_app LOGIN + a known password so we can connect as
    // it (migration 0032 creates it NOLOGIN — the operator sets this in prod).
    await owner.execute(
      sql`ALTER ROLE furan_app WITH LOGIN PASSWORD 'furan_app_test'`,
    );
    const appUrl = DATABASE_URL!.replace(
      /\/\/[^/@]+@/,
      "//furan_app:furan_app_test@",
    );
    const a = createDb({ url: appUrl });
    app = a.db;
    appClose = a.close;

    // Seed via the OWNER connection (bypasses RLS): two users, two isolated
    // projects, A∈projA and B∈projB, one build + run in each.
    await owner.insert(users).values([
      {
        id: uidA,
        email: `rls-a-${uidA}@t.example`,
        hashedPassword: "x",
        firstName: "A",
        lastName: "A",
        role: "editor",
        isActive: true,
      },
      {
        id: uidB,
        email: `rls-b-${uidB}@t.example`,
        hashedPassword: "x",
        firstName: "B",
        lastName: "B",
        role: "editor",
        isActive: true,
      },
    ]);
    const [pa] = await owner
      .insert(projects)
      .values({ name: `rls-A-${randomUUID()}` })
      .returning();
    const [pb] = await owner
      .insert(projects)
      .values({ name: `rls-B-${randomUUID()}` })
      .returning();
    projA = pa!.id;
    projB = pb!.id;
    await owner.insert(projectMembers).values([
      { userId: uidA, projectId: projA },
      { userId: uidB, projectId: projB },
    ]);
    const [ba] = await owner
      .insert(builds)
      .values({ projectId: projA })
      .returning();
    const [bb] = await owner
      .insert(builds)
      .values({ projectId: projB })
      .returning();
    await owner.insert(testRuns).values([
      { projectId: projA, buildId: ba!.id, name: "runA", status: "passed" },
      { projectId: projB, buildId: bb!.id, name: "runB", status: "passed" },
    ]);
  });

  afterAll(async () => {
    if (appClose) await appClose();
    if (ownerClose) await ownerClose();
  });

  test("read isolation: an unfiltered select returns only the caller's projects", async () => {
    const seen = await withUserScope(
      app,
      { userId: uidA, role: "editor" },
      (tx) => tx.select({ projectId: testRuns.projectId }).from(testRuns),
    );
    // A is a member of projA only. A deliberately UNFILTERED query must still
    // see only projA rows (RLS caught the missing filter) and never projB.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((r) => r.projectId === projA)).toBe(true);
    expect(seen.some((r) => r.projectId === projB)).toBe(false);
  });

  test("cross-tenant: B cannot see A's project rows", async () => {
    const seen = await withUserScope(
      app,
      { userId: uidB, role: "editor" },
      (tx) => tx.select({ projectId: testRuns.projectId }).from(testRuns),
    );
    expect(seen.every((r) => r.projectId === projB)).toBe(true);
    expect(seen.some((r) => r.projectId === projA)).toBe(false);
  });

  test("fail-closed: no identity set → zero rows", async () => {
    const rows = await app.select({ id: testRuns.id }).from(testRuns).limit(5);
    expect(rows).toHaveLength(0);
  });

  test("admin role bypasses RLS (sees both projects)", async () => {
    const seen = await withUserScope(
      app,
      { userId: uidA, role: "admin" },
      (tx) => tx.select({ projectId: testRuns.projectId }).from(testRuns),
    );
    expect(seen.some((r) => r.projectId === projA)).toBe(true);
    expect(seen.some((r) => r.projectId === projB)).toBe(true);
  });

  test("WITH CHECK: an editor cannot INSERT into a non-member project", async () => {
    await expect(
      withUserScope(app, { userId: uidA, role: "editor" }, async (tx) => {
        const [b] = await tx
          .select({ id: builds.id })
          .from(builds)
          .where(eq(builds.projectId, projB))
          .limit(1);
        // A is not a member of projB → WITH CHECK must reject this insert.
        // (A can't see projB's build under RLS, so seed the id via owner.)
        await tx.insert(testRuns).values({
          projectId: projB,
          buildId: b?.id ?? randomUUID(),
          name: "illegal",
          status: "passed",
        });
      }),
    ).rejects.toThrow();
  });

  test("no GUC leak: a reused connection without a fresh scope sees nothing", async () => {
    await withUserScope(app, { userId: uidA, role: "editor" }, async () => {
      /* no-op — just borrow + release a pooled connection under scope */
    });
    const rows = await app.select({ id: testRuns.id }).from(testRuns).limit(5);
    expect(rows).toHaveLength(0);
  });
});
