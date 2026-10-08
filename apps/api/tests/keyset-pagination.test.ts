import type { AddressInfo } from "node:net";

import {
  auditLog,
  autoRuleApplications,
  autoRules,
  builds,
  diffRegions,
  projectMembers,
  projects,
  runReviewerDecisions,
  screenshots,
  sql,
  testRuns,
  testVariations,
  users,
} from "@furan/db";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";

import { hashPassword } from "../src/lib/password.js";
import type { AppRouter } from "../src/trpc/v1/router.js";

import { createTestApp, type TestApp } from "./helpers.js";

const d = !process.env.DATABASE_URL ? describe.skip : describe;

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/**
 * Timestamps are microsecond-precision; a JS Date is not. Six rows share the
 * millisecond .123 at different µs (two share one exact instant — what one
 * transaction's now() gives — and one sits on the ms boundary), bracketed by
 * a row in the next and previous ms. Ids are chosen so id order disagrees
 * with time order. Listed newest first, id DESC on the tie: the order every
 * list must return.
 */
const SEEDS: { id: string; at: string }[] = [
  { id: id(7), at: "2026-01-01T00:00:00.124100Z" },
  { id: id(1), at: "2026-01-01T00:00:00.123900Z" },
  { id: id(5), at: "2026-01-01T00:00:00.123700Z" },
  { id: id(4), at: "2026-01-01T00:00:00.123500Z" },
  { id: id(3), at: "2026-01-01T00:00:00.123500Z" },
  { id: id(6), at: "2026-01-01T00:00:00.123300Z" },
  { id: id(2), at: "2026-01-01T00:00:00.123000Z" },
  { id: id(8), at: "2026-01-01T00:00:00.122999Z" },
];
const at = (s: { at: string }) => sql`${s.at}::timestamptz`;

interface Page {
  items: { id: string }[];
  nextCursor?: string | null;
}

/** Page through at limit 1..3: every seed exactly once, in SEEDS order. */
async function expectPagedInOrder(
  fetchPage: (limit: number, cursor: string | undefined) => Promise<Page>,
): Promise<void> {
  for (const limit of [1, 2, 3]) {
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await fetchPage(limit, cursor);
      expect(page.items.length).toBeGreaterThan(0);
      expect(page.items.length).toBeLessThanOrEqual(limit);
      seen.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor ?? undefined;
      pages++;
    } while (cursor && pages <= SEEDS.length);
    expect(seen, `limit=${limit}`).toEqual(SEEDS.map((s) => s.id));
    expect(pages, `limit=${limit}`).toBe(Math.ceil(SEEDS.length / limit));
  }
}

d("keyset pagination over same-millisecond timestamps", () => {
  let h: TestApp;
  let client: ReturnType<typeof createTRPCClient<AppRouter>>;
  let adminId: string;
  let projectId: string;
  let buildId: string;

  beforeAll(async () => {
    process.env.S3_ENDPOINT ??= "http://localhost:9000";
    process.env.S3_BUCKET ??= "furan-dev";
    process.env.S3_ACCESS_KEY ??= "furan";
    process.env.S3_SECRET_KEY ??= "devpw_must_be_long"; // gitleaks:allow
    h = await createTestApp();
    await h.app.listen({ host: "127.0.0.1", port: 0 });
  });

  afterAll(async () => {
    await h.close();
  });

  beforeEach(async () => {
    // FK-order: dependents before parents.
    await h.db.delete(autoRuleApplications);
    await h.db.delete(diffRegions);
    await h.db.delete(screenshots);
    await h.db.delete(autoRules);
    await h.db.delete(auditLog);
    await h.db.delete(runReviewerDecisions);
    await h.db.delete(testRuns);
    await h.db.delete(testVariations);
    await h.db.delete(builds);
    await h.db.delete(projectMembers);
    await h.db.delete(projects);
    await h.db.delete(users);

    // Admin: auditLog.list is admin-only; the project-scoped lists let
    // admins through regardless of membership.
    const [admin] = await h.db
      .insert(users)
      .values({
        email: "keyset-admin@t.example",
        hashedPassword: await hashPassword("x"),
        firstName: "Key",
        lastName: "Set",
        role: "admin",
        isActive: true,
      })
      .returning();
    if (!admin) throw new Error("admin not seeded");
    adminId = admin.id;

    const [project] = await h.db
      .insert(projects)
      .values({ name: "keyset-project" })
      .returning();
    if (!project) throw new Error("project not seeded");
    projectId = project.id;
    await h.db.insert(projectMembers).values({ userId: adminId, projectId });

    const [build] = await h.db
      .insert(builds)
      .values({ projectId, branchName: "main" })
      .returning();
    if (!build) throw new Error("build not seeded");
    buildId = build.id;

    const jwt = h.app.jwt.sign({ sub: adminId, role: "admin" });
    const addr = h.app.server.address() as AddressInfo;
    client = createTRPCClient<AppRouter>({
      links: [
        httpBatchLink({
          url: `http://127.0.0.1:${addr.port}/trpc`,
          headers: { authorization: `Bearer ${jwt}` },
        }),
      ],
    });
  });

  test("runs.list", async () => {
    for (const s of SEEDS) {
      await h.db.insert(testRuns).values({
        id: s.id,
        projectId,
        buildId,
        name: "run",
        branchName: "main",
        status: "unresolved",
        createdAt: at(s),
      });
    }
    await expectPagedInOrder((limit, cursor) =>
      client.runs.list.query({ projectId, limit, cursor }),
    );
  });

  test("variations.list", async () => {
    for (const s of SEEDS) {
      await h.db.insert(testVariations).values({
        id: s.id,
        projectId,
        name: `variation-${s.id.slice(-1)}`,
        createdAt: at(s),
      });
    }
    await expectPagedInOrder((limit, cursor) =>
      client.variations.list.query({ projectId, limit, cursor }),
    );
  });

  test("variations.history", async () => {
    const [variation] = await h.db
      .insert(testVariations)
      .values({ projectId, name: "history" })
      .returning();
    if (!variation) throw new Error("variation not seeded");
    for (const s of SEEDS) {
      await h.db.insert(testRuns).values({
        id: s.id,
        projectId,
        buildId,
        name: "run",
        branchName: "main",
        status: "passed",
        createdAt: at(s),
      });
      await h.db.insert(screenshots).values({
        runId: s.id,
        projectId,
        testVariationId: variation.id,
        name: "history",
        viewport: "1280x720",
        browser: "chromium",
        imageKey: "aaaa",
      });
    }
    await expectPagedInOrder((limit, cursor) =>
      client.variations.history.query({
        projectId,
        variationId: variation.id,
        limit,
        cursor,
      }),
    );
  });

  test("autoRules.applications", async () => {
    const [rule] = await h.db
      .insert(autoRules)
      .values({
        projectId,
        label: "keyset",
        match: {},
        action: "flag",
        createdBy: adminId,
        updatedBy: adminId,
      })
      .returning();
    if (!rule) throw new Error("rule not seeded");
    const [run] = await h.db
      .insert(testRuns)
      .values({ projectId, buildId, name: "run", status: "unresolved" })
      .returning();
    if (!run) throw new Error("run not seeded");
    const [region] = await h.db
      .insert(diffRegions)
      .values({
        runId: run.id,
        projectId,
        severity: "high",
        category: "layout",
        source: "l2_dom",
        description: "diff",
        bbox: { x: 0, y: 0, width: 10, height: 10 },
      })
      .returning();
    if (!region) throw new Error("region not seeded");
    for (const s of SEEDS) {
      await h.db.insert(autoRuleApplications).values({
        id: s.id,
        ruleId: rule.id,
        ruleVersion: 1,
        testRunId: run.id,
        diffRegionId: region.id,
        regionDiffPct: 0.1,
        actionPriority: 2,
        appliedAt: at(s),
      });
    }
    await expectPagedInOrder((limit, cursor) =>
      client.autoRules.applications.query({ ruleId: rule.id, limit, cursor }),
    );
  });

  test("auditLog.list", async () => {
    for (const s of SEEDS) {
      await h.db.insert(auditLog).values({
        id: s.id,
        actorId: adminId,
        action: "keyset.test",
        targetType: "project",
        targetId: projectId,
        createdAt: at(s),
      });
    }
    await expectPagedInOrder((limit, cursor) =>
      client.auditLog.list.query({ action: "keyset.test", limit, cursor }),
    );
  });
});
