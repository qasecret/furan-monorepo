import type { AddressInfo } from "node:net";

import {
  baselines,
  builds,
  diffRegions,
  projectMembers,
  projects,
  screenshots,
  testRuns,
  testVariations,
  users,
} from "@furan/db";
import { createTRPCClient, httpBatchLink, TRPCClientError } from "@trpc/client";
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

const skip = !process.env.DATABASE_URL;
const d = skip ? describe.skip : describe;

interface Seeded {
  memberId: string;
  memberJwt: string;
  nonMemberId: string;
  nonMemberJwt: string;
  projectId: string;
  variationId: string;
  buildId: string;
  /** Run IDs in INSERTION order (oldest createdAt first). */
  runIdsAsc: string[];
}

/**
 * Seed 26 test_runs with strictly monotonic `created_at` (1s apart so the
 * desc(createdAt) ordering is deterministic). 24 are on `main`+status="new",
 * 1 is on `feature/x`+status="passed", 1 is on `feature/x`+status="failed".
 */
async function seed(h: TestApp): Promise<Seeded> {
  // FK-order: dependents before parents.
  await h.db.delete(diffRegions);
  await h.db.delete(screenshots);
  await h.db.delete(baselines);
  await h.db.delete(testRuns);
  await h.db.delete(testVariations);
  await h.db.delete(builds);
  await h.db.delete(projectMembers);
  await h.db.delete(projects);
  await h.db.delete(users);

  const [member] = await h.db
    .insert(users)
    .values({
      email: "member@t.example",
      hashedPassword: await hashPassword("x"),
      firstName: "Mem",
      lastName: "Ber",
      role: "editor",
      isActive: true,
    })
    .returning();
  const [nonMember] = await h.db
    .insert(users)
    .values({
      email: "nonmember@t.example",
      hashedPassword: await hashPassword("x"),
      firstName: "Non",
      lastName: "Mem",
      role: "editor",
      isActive: true,
    })
    .returning();

  const [project] = await h.db
    .insert(projects)
    .values({ name: "alpha" })
    .returning();

  await h.db
    .insert(projectMembers)
    .values({ userId: member.id, projectId: project.id });

  const [build] = await h.db
    .insert(builds)
    .values({ projectId: project.id, userId: member.id, isRunning: true })
    .returning();

  const [variation] = await h.db
    .insert(testVariations)
    .values({ name: "home", projectId: project.id })
    .returning();

  // 26 runs total. Index 0 is the OLDEST, index 25 the NEWEST.
  // 24 base runs on `main` with status="new", then 2 distinguished runs on
  // `feature/x` (one passed, one failed) at the most-recent timestamps so
  // they come out at the top of the default desc(createdAt) listing.
  const now = Date.now();
  const total = 26;
  const runIdsAsc: string[] = [];
  for (let i = 0; i < total; i += 1) {
    // i=0 → oldest (now - 25_000ms); i=25 → newest (now).
    const createdAt = new Date(now - (total - 1 - i) * 1000);
    let branchName = "main";
    let status: string = "new";
    if (i === total - 2) {
      // 2nd newest: feature/x + passed
      branchName = "feature/x";
      status = "passed";
    } else if (i === total - 1) {
      // newest: feature/x + failed
      branchName = "feature/x";
      status = "failed";
    }
    const [row] = await h.db
      .insert(testRuns)
      .values({
        buildId: build.id,
        projectId: project.id,
        status,
        branchName,
        name: `run-${i}`,
        createdAt,
        updatedAt: createdAt,
      })
      .returning();
    runIdsAsc.push(row.id);
  }

  return {
    memberId: member.id,
    memberJwt: h.app.jwt.sign({ sub: member.id, role: "editor" }),
    nonMemberId: nonMember.id,
    nonMemberJwt: h.app.jwt.sign({ sub: nonMember.id, role: "editor" }),
    projectId: project.id,
    variationId: variation.id,
    buildId: build.id,
    runIdsAsc,
  };
}

function makeClient(baseUrl: string, jwt?: string) {
  return createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: `${baseUrl}/trpc`,
        headers: jwt ? { authorization: `Bearer ${jwt}` } : {},
      }),
    ],
  });
}

d("tRPC runs.list", () => {
  let h: TestApp;
  let baseUrl: string;
  let s: Seeded;

  beforeAll(async () => {
    h = await createTestApp();
    await h.app.listen({ port: 0, host: "127.0.0.1" });
    const addr = h.app.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    s = await seed(h);
  });

  test("list: returns 25 items + nextCursor when 26 runs exist (default page size)", async () => {
    const client = makeClient(baseUrl, s.memberJwt);
    const page = await client.runs.list.query({ projectId: s.projectId });
    expect(page.items).toHaveLength(25);
    expect(page.nextCursor).not.toBeNull();
    // Newest first: the failed feature/x run is the very first.
    expect(page.items[0]?.id).toBe(s.runIdsAsc[s.runIdsAsc.length - 1]);
    // The 25th item (index 24) of the desc-sorted list is runIdsAsc[1].
    expect(page.items[24]?.id).toBe(s.runIdsAsc[1]);
  });

  test("list: second page via cursor returns the 26th item with nextCursor=null", async () => {
    const client = makeClient(baseUrl, s.memberJwt);
    const first = await client.runs.list.query({ projectId: s.projectId });
    expect(first.nextCursor).toBeTruthy();
    const second = await client.runs.list.query({
      projectId: s.projectId,
      cursor: first.nextCursor!,
    });
    expect(second.items).toHaveLength(1);
    expect(second.items[0]?.id).toBe(s.runIdsAsc[0]); // oldest
    expect(second.nextCursor).toBeNull();
  });

  test("list: filters by branch (exact match)", async () => {
    const client = makeClient(baseUrl, s.memberJwt);
    const page = await client.runs.list.query({
      projectId: s.projectId,
      branch: "feature/x",
    });
    expect(page.items).toHaveLength(2);
    expect(page.items.every((r) => r.branchName === "feature/x")).toBe(true);
    expect(page.nextCursor).toBeNull();
  });

  test("list: filters by status enum (single value)", async () => {
    const client = makeClient(baseUrl, s.memberJwt);
    const page = await client.runs.list.query({
      projectId: s.projectId,
      status: ["passed"],
    });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.status).toBe("passed");
    expect(page.items[0]?.branchName).toBe("feature/x");
    expect(page.nextCursor).toBeNull();
  });

  test("list: filters by status enum (multi-select array)", async () => {
    // Spec §3.5: reviewers can pick e.g. 'Unresolved + Failed' or, here,
    // the two distinguished feature/x runs (passed + failed). The seed
    // has exactly two such runs; the 24 'new' runs must NOT come back.
    const client = makeClient(baseUrl, s.memberJwt);
    const page = await client.runs.list.query({
      projectId: s.projectId,
      status: ["passed", "failed"],
    });
    expect(page.items).toHaveLength(2);
    const statuses = page.items.map((r) => r.status).sort();
    expect(statuses).toEqual(["failed", "passed"]);
    expect(page.items.every((r) => r.branchName === "feature/x")).toBe(true);
    expect(page.nextCursor).toBeNull();
  });

  test("list: empty status array behaves like 'no filter' (returns all)", async () => {
    // The API treats `status: []` the same as `status: undefined` so the
    // dashboard's "all checkboxes off" state never accidentally compiles
    // to `status IN ()` (which would return zero rows). With 26 seeded
    // runs and default page size 25, we expect a full page + cursor.
    const client = makeClient(baseUrl, s.memberJwt);
    const page = await client.runs.list.query({
      projectId: s.projectId,
      status: [],
    });
    expect(page.items).toHaveLength(25);
    expect(page.nextCursor).not.toBeNull();
  });

  test("list: non-member editor receives FORBIDDEN", async () => {
    const client = makeClient(baseUrl, s.nonMemberJwt);
    let err: TRPCClientError<AppRouter> | undefined;
    try {
      await client.runs.list.query({ projectId: s.projectId });
    } catch (e) {
      err = e as TRPCClientError<AppRouter>;
    }
    expect(err).toBeDefined();
    expect(err?.data?.code).toBe("FORBIDDEN");
  });

  test("list: filters by buildId (drill-in from Builds tab)", async () => {
    // Seed already created `s.buildId` with 26 runs attached. Add a SECOND
    // build under the same project + variation with 2 runs; the buildId
    // filter should return exactly those 2.
    const [b2] = await h.db
      .insert(builds)
      .values({ projectId: s.projectId, ciBuildId: "build-B" })
      .returning();
    if (!b2) throw new Error("second build not seeded");
    await h.db.insert(testRuns).values([
      {
        projectId: s.projectId,
        buildId: b2.id,
        name: "run-b-1",
        branchName: "main",
        status: "passed",
      },
      {
        projectId: s.projectId,
        buildId: b2.id,
        name: "run-b-2",
        branchName: "main",
        status: "passed",
      },
    ]);
    const client = makeClient(baseUrl, s.memberJwt);
    const page = await client.runs.list.query({
      projectId: s.projectId,
      buildId: b2.id,
    });
    expect(page.items).toHaveLength(2);
    expect(page.items.every((r) => r.buildId === b2.id)).toBe(true);
    expect(page.nextCursor).toBeNull();
  });

  test("bulkApproveByBuild: approves every run that needs review, skipping already-passed runs", async () => {
    const client = makeClient(baseUrl, s.memberJwt);
    const res = await client.runs.bulkApproveByBuild.mutate({
      buildId: s.buildId,
    });
    // Seed build: 24 `new` (no baseline yet) + 1 `passed` (nothing to
    // approve) + 1 `failed` → only the failed run is approved.
    expect(res.approved).toBe(1);
    expect(res.runIds).toEqual([s.runIdsAsc[25]]);
    expect(res.capped).toBe(false);
    // Both are passed now; the 24 `new` are untouched.
    const passed = await client.runs.list.query({
      projectId: s.projectId,
      buildId: s.buildId,
      status: ["passed"],
    });
    expect(passed.items).toHaveLength(2);
  });

  test("bulkApproveByBuild: a capped approve is progressive — the next call approves the rest", async () => {
    // A fresh build with one already-passed run (the OLDEST, so an unordered
    // or passed-inclusive selection would pick it first) followed by 201
    // runs that need review, alternating unresolved / failed.
    const [b2] = await h.db
      .insert(builds)
      .values({ projectId: s.projectId, ciBuildId: "build-cap" })
      .returning();
    if (!b2) throw new Error("cap build not seeded");
    const t0 = Date.now() - 300_000;
    const rows = await h.db
      .insert(testRuns)
      .values(
        Array.from({ length: 202 }, (_, i) => ({
          projectId: s.projectId,
          buildId: b2.id,
          name: `cap-${i}`,
          branchName: "main",
          status: i === 0 ? "passed" : i % 2 === 0 ? "failed" : "unresolved",
          createdAt: new Date(t0 + i * 1000),
          updatedAt: new Date(t0 + i * 1000),
        })),
      )
      .returning({ id: testRuns.id, name: testRuns.name });
    const byName = new Map(rows.map((r) => [r.name, r.id]));
    const needsReviewAsc = Array.from({ length: 201 }, (_, i) => {
      const id = byName.get(`cap-${i + 1}`);
      if (!id) throw new Error(`cap-${i + 1} not seeded`);
      return id;
    });

    const client = makeClient(baseUrl, s.memberJwt);

    // First click: the 200 oldest runs that need review, in createdAt order.
    const first = await client.runs.bulkApproveByBuild.mutate({
      buildId: b2.id,
    });
    expect(first.approved).toBe(200);
    expect(first.capped).toBe(true);
    expect(first.runIds).toEqual(needsReviewAsc.slice(0, 200));

    // Second click: only the one run left — not the 200 just approved.
    const second = await client.runs.bulkApproveByBuild.mutate({
      buildId: b2.id,
    });
    expect(second.approved).toBe(1);
    expect(second.capped).toBe(false);
    expect(second.runIds).toEqual([needsReviewAsc[200]]);

    // Nothing left to review.
    const third = await client.runs.bulkApproveByBuild.mutate({
      buildId: b2.id,
    });
    expect(third.approved).toBe(0);
    const remaining = await client.runs.list.query({
      projectId: s.projectId,
      buildId: b2.id,
      status: ["unresolved", "failed"],
    });
    expect(remaining.items).toHaveLength(0);
  });

  test("bulkApproveByBuild: non-member editor receives FORBIDDEN", async () => {
    const client = makeClient(baseUrl, s.nonMemberJwt);
    let err: TRPCClientError<AppRouter> | undefined;
    try {
      await client.runs.bulkApproveByBuild.mutate({ buildId: s.buildId });
    } catch (e) {
      err = e as TRPCClientError<AppRouter>;
    }
    expect(err).toBeDefined();
    expect(err?.data?.code).toBe("FORBIDDEN");
  });

  describe("device/environment filters (parity with legacy DataGrid)", () => {
    // Each test seeds a small set of runs with diverse columns and asserts
    // the single filter narrows correctly. Shares the project + variation
    // from the outer seed; uses a fresh build to avoid cursor noise from
    // the 26 base runs.
    // ADR-038: browser/viewport/os/device moved from test_runs to screenshots.
    // Filters on those dimensions are Phase 5 work (sub-query against screenshots).
    // The seed below stores the columns on screenshots, not on testRuns.
    async function seedDeviceVariants() {
      const [b] = await h.db
        .insert(builds)
        .values({ projectId: s.projectId, ciBuildId: "device-test" })
        .returning();
      if (!b) throw new Error("device-test build not seeded");
      const runs = await h.db
        .insert(testRuns)
        .values([
          {
            projectId: s.projectId,
            buildId: b.id,
            status: "passed",
            branchName: "main",
            customTags: "smoke,login,critical",
            name: "row-1",
          },
          {
            projectId: s.projectId,
            buildId: b.id,
            status: "passed",
            branchName: "main",
            customTags: "regression",
            name: "row-2",
          },
          {
            projectId: s.projectId,
            buildId: b.id,
            status: "passed",
            branchName: "main",
            customTags: "smoke,mobile",
            name: "row-3",
          },
        ])
        .returning();
      // Store browser/viewport/os/device on screenshots (ADR-038 home for these).
      const screenshotData = [
        {
          run: runs[0]!,
          browser: "chromium",
          viewport: "1280x720",
          os: "linux",
          device: "desktop",
        },
        {
          run: runs[1]!,
          browser: "firefox",
          viewport: "1280x720",
          os: "linux",
          device: "desktop",
        },
        {
          run: runs[2]!,
          browser: "chromium",
          viewport: "375x667",
          os: "ios",
          device: "iphone-12",
        },
      ];
      for (const d of screenshotData) {
        await h.db.insert(screenshots).values({
          runId: d.run.id,
          projectId: s.projectId,
          testVariationId: s.variationId,
          name: d.run.name!,
          imageKey: `key-${d.run.name}`,
          viewport: d.viewport,
          browser: d.browser,
          os: d.os,
          device: d.device,
        });
      }
      return b.id;
    }

    // ADR-038 Phase 5 TODO: browser/viewport/os/device filters sub-query screenshots.
    // These tests are skipped until the sub-query filters are implemented.
    test.skip("list: filters by browser", async () => {
      const buildId = await seedDeviceVariants();
      const client = makeClient(baseUrl, s.memberJwt);
      const page = await client.runs.list.query({
        projectId: s.projectId,
        buildId,
        browser: "firefox",
      });
      expect(page.items).toHaveLength(1);
      expect(page.items[0]?.browser).toBe("firefox");
    });

    test.skip("list: filters by viewport", async () => {
      const buildId = await seedDeviceVariants();
      const client = makeClient(baseUrl, s.memberJwt);
      const page = await client.runs.list.query({
        projectId: s.projectId,
        buildId,
        viewport: "375x667",
      });
      expect(page.items).toHaveLength(1);
      expect(page.items[0]?.viewport).toBe("375x667");
    });

    test.skip("list: filters by os", async () => {
      const buildId = await seedDeviceVariants();
      const client = makeClient(baseUrl, s.memberJwt);
      const page = await client.runs.list.query({
        projectId: s.projectId,
        buildId,
        os: "ios",
      });
      expect(page.items).toHaveLength(1);
      expect(page.items[0]?.os).toBe("ios");
    });

    test.skip("list: filters by device", async () => {
      const buildId = await seedDeviceVariants();
      const client = makeClient(baseUrl, s.memberJwt);
      const page = await client.runs.list.query({
        projectId: s.projectId,
        buildId,
        device: "iphone-12",
      });
      expect(page.items).toHaveLength(1);
      expect(page.items[0]?.device).toBe("iphone-12");
    });

    test("list: filters by customTags (ILIKE substring)", async () => {
      const buildId = await seedDeviceVariants();
      const client = makeClient(baseUrl, s.memberJwt);
      // 'smoke' matches rows 1 + 3 (both have "smoke" in their tag bag).
      const page = await client.runs.list.query({
        projectId: s.projectId,
        buildId,
        customTags: "smoke",
      });
      expect(page.items).toHaveLength(2);
      expect(page.items.every((r) => r.customTags?.includes("smoke"))).toBe(
        true,
      );
    });

    test.skip("list: filters compose (browser + viewport)", async () => {
      const buildId = await seedDeviceVariants();
      const client = makeClient(baseUrl, s.memberJwt);
      const page = await client.runs.list.query({
        projectId: s.projectId,
        buildId,
        browser: "chromium",
        viewport: "375x667",
      });
      // Only row-3 matches both.
      expect(page.items).toHaveLength(1);
      expect(page.items[0]?.name).toBe("row-3");
    });
  });

  test("runs.list returns thumbnailUrl", async () => {
    const [b] = await h.db
      .insert(builds)
      .values({ projectId: s.projectId, ciBuildId: "thumb-b" })
      .returning();
    if (!b) throw new Error("build not seeded");
    await h.db.insert(testRuns).values({
      projectId: s.projectId,
      buildId: b.id,
      name: "thumbed",
      branchName: "main",
      status: "unresolved",
      thumbnailUrl: "https://example/thumb.webp",
    });
    const client = makeClient(baseUrl, s.memberJwt);
    const res = await client.runs.list.query({
      projectId: s.projectId,
      buildId: b.id,
    });
    const row = res.items.find((r) => r.name === "thumbed");
    expect(row?.thumbnailUrl).toBe("https://example/thumb.webp");
  });
});
