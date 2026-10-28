import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";

import {
  baselines,
  builds,
  checkpointDecisions,
  diffRegions,
  eq,
  inArray,
  projectMembers,
  projects,
  screenshots,
  testRuns,
  testVariations,
  users,
  type DB,
  type RunStatus,
} from "@furan/db";
import { createTRPCClient, httpBatchLink, TRPCClientError } from "@trpc/client";
import type { inferRouterInputs } from "@trpc/server";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";

import { hashPassword } from "../src/lib/password.js";
import type { Context } from "../src/trpc/context.js";
import type { AppRouter } from "../src/trpc/v1/router.js";
import { runsRouter } from "../src/trpc/v1/runs.js";

import { createTestApp, type TestApp } from "./helpers.js";
import {
  addReviewBuild,
  addReviewRun,
  cleanupReviewSeeds,
  seedReviewRun,
  type ReviewRunSpec,
  type ReviewSeed,
} from "./review-fixtures.js";

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
    .values({ userId: member!.id, projectId: project!.id });

  const [build] = await h.db
    .insert(builds)
    .values({ projectId: project!.id, userId: member!.id, isRunning: true })
    .returning();

  const [variation] = await h.db
    .insert(testVariations)
    .values({ name: "home", projectId: project!.id })
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
    let status: RunStatus = "new";
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
        buildId: build!.id,
        projectId: project!.id,
        status,
        branchName,
        name: `run-${i}`,
        createdAt,
        updatedAt: createdAt,
      })
      .returning();
    runIdsAsc.push(row!.id);
  }

  return {
    memberId: member!.id,
    memberJwt: h.app.jwt.sign({ sub: member!.id, role: "editor" }),
    nonMemberId: nonMember!.id,
    nonMemberJwt: h.app.jwt.sign({ sub: nonMember!.id, role: "editor" }),
    projectId: project!.id,
    variationId: variation!.id,
    buildId: build!.id,
    runIdsAsc,
  };
}

/**
 * Gives each of `runIds` one diffed checkpoint (on the seed's variation) with
 * the verdict `verdictOf(index)`: "Approve all" decides pending checkpoints
 * (spec §5.4), not run statuses.
 */
async function addCheckpoints(
  h: TestApp,
  s: Pick<Seeded, "projectId" | "variationId">,
  runIds: string[],
  verdictOf: (i: number) => "new" | "unresolved" | "passed",
) {
  if (runIds.length === 0) return;
  await h.db.insert(screenshots).values(
    runIds.map((runId, i) => ({
      runId,
      projectId: s.projectId,
      testVariationId: s.variationId,
      name: "home",
      viewport: "1280x720",
      browser: "chromium",
      imageKey: `bulk-${runId}`,
      verdict: verdictOf(i),
    })),
  );
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

  test("review.approveBuild: approves every run that needs review, skipping already-passed runs", async () => {
    // Seed build: 24 `new` runs (a first capture: verdict `new`), 1 `passed`
    // (nothing to approve) and 1 `failed`, here a reviewer's reject of its
    // unresolved step. "Approve pending" decides PENDING checkpoints (`new` or
    // `unresolved`, undecided; spec §5.4): the 24 first captures are approved,
    // the passed run has nothing to approve and the rejected step stays
    // rejected (a decision changes only through undo, R19).
    await addCheckpoints(h, s, s.runIdsAsc.slice(0, 24), () => "new");
    await addCheckpoints(h, s, [s.runIdsAsc[24]!], () => "passed");
    await addCheckpoints(h, s, [s.runIdsAsc[25]!], () => "unresolved");
    const client = makeClient(baseUrl, s.memberJwt);
    await client.review.reject.mutate({
      runId: s.runIdsAsc[25]!,
      actionId: randomUUID(),
    });

    const res = await client.review.approveBuild.mutate({
      buildId: s.buildId,
      actionId: randomUUID(),
      expectedCount: 24,
    });
    expect(res.decided).toHaveLength(24);
    expect(res.runs.map((r) => r.runId).sort()).toEqual(
      s.runIdsAsc.slice(0, 24).sort(),
    );
    expect(res.capped).toBe(false);
    // The 24 approved runs + the already-passed one; the rejected run is not.
    const passed = await client.runs.list.query({
      projectId: s.projectId,
      buildId: s.buildId,
      status: ["passed"],
    });
    expect(passed.items).toHaveLength(25);
    const failed = await client.runs.list.query({
      projectId: s.projectId,
      buildId: s.buildId,
      status: ["failed"],
    });
    expect(failed.items.map((r) => r.id)).toEqual([s.runIdsAsc[25]]);
  });

  describe("device/environment filters (parity with legacy DataGrid)", () => {
    // Each test seeds a small set of runs with diverse columns and asserts
    // the single filter narrows correctly. Shares the project + variation
    // from the outer seed; uses a fresh build to avoid cursor noise from
    // the 26 base runs.
    // ADR-038: browser/viewport/os/device live on screenshots (steps), not on
    // test_runs; a run matches a filter when one of its steps does. The seed
    // below stores the columns on screenshots.
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

    test("list: filters by browser", async () => {
      const buildId = await seedDeviceVariants();
      const client = makeClient(baseUrl, s.memberJwt);
      const page = await client.runs.list.query({
        projectId: s.projectId,
        buildId,
        browser: "firefox",
      });
      expect(page.items.map((r) => r.name)).toEqual(["row-2"]);
    });

    test("list: filters by viewport", async () => {
      const buildId = await seedDeviceVariants();
      const client = makeClient(baseUrl, s.memberJwt);
      const page = await client.runs.list.query({
        projectId: s.projectId,
        buildId,
        viewport: "375x667",
      });
      expect(page.items.map((r) => r.name)).toEqual(["row-3"]);
    });

    test("list: filters by os", async () => {
      const buildId = await seedDeviceVariants();
      const client = makeClient(baseUrl, s.memberJwt);
      const page = await client.runs.list.query({
        projectId: s.projectId,
        buildId,
        os: "ios",
      });
      expect(page.items.map((r) => r.name)).toEqual(["row-3"]);
    });

    test("list: filters by device", async () => {
      const buildId = await seedDeviceVariants();
      const client = makeClient(baseUrl, s.memberJwt);
      const page = await client.runs.list.query({
        projectId: s.projectId,
        buildId,
        device: "iphone-12",
      });
      expect(page.items.map((r) => r.name)).toEqual(["row-3"]);
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

    test("list: filters compose (browser + viewport)", async () => {
      const buildId = await seedDeviceVariants();
      const client = makeClient(baseUrl, s.memberJwt);
      const page = await client.runs.list.query({
        projectId: s.projectId,
        buildId,
        browser: "chromium",
        viewport: "375x667",
      });
      // Only row-3 matches both.
      expect(page.items.map((r) => r.name)).toEqual(["row-3"]);
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

/** Counts the statements a read issues (`select*` / `execute` on the handle). */
function countingDb(db: DB): { db: DB; count: () => number } {
  let n = 0;
  const counted = new Set([
    "select",
    "selectDistinct",
    "selectDistinctOn",
    "execute",
  ]);
  const proxy = new Proxy(db, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (counted.has(String(prop))) n++;
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { db: proxy, count: () => n };
}

type ListQuery = Omit<
  inferRouterInputs<AppRouter>["runs"]["list"],
  "projectId"
>;

d("tRPC runs.list: step environment, pending steps, order and counts", () => {
  let h: TestApp;
  let baseUrl: string;
  const seeds: ReviewSeed[] = [];

  async function seed(
    spec: ReviewRunSpec,
    opts?: { branch?: string },
  ): Promise<ReviewSeed> {
    const s = await seedReviewRun(h, spec, opts);
    seeds.push(s);
    return s;
  }

  /** `runs.list` as the seed's editor (a project member). */
  function list(s: ReviewSeed, query: ListQuery = {}) {
    return makeClient(baseUrl, s.editor.jwt).runs.list.query({
      projectId: s.projectId,
      ...query,
    });
  }

  const idsOf = (page: { items: Array<{ id: string }> }) =>
    page.items.map((i) => i.id);
  const sorted = (ids: string[]) => [...ids].sort();

  /** A decision row (an approve unless `decision`), active unless `reverted`. */
  async function decide(
    s: ReviewSeed,
    runId: string,
    shotId: string,
    opts: { reverted?: boolean; decision?: "approved" | "rejected" } = {},
  ): Promise<void> {
    await h.db.insert(checkpointDecisions).values({
      projectId: s.projectId,
      runId,
      screenshotId: shotId,
      actionId: randomUUID(),
      decision: opts.decision ?? "approved",
      actorId: s.editor.id,
      source: "viewer",
      before: null,
      revertedAt: opts.reverted ? new Date() : null,
      revertedBy: opts.reverted ? s.editor.id : null,
    });
  }

  beforeAll(async () => {
    h = await createTestApp();
    h.app.log.level = "silent";
    await h.app.listen({ port: 0, host: "127.0.0.1" });
    const addr = h.app.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });
  afterAll(async () => {
    await cleanupReviewSeeds(h, seeds);
    await h.close();
  });

  test("browser/viewport/os/device filter runs by their steps", async () => {
    // A: chromium at two viewports.
    const s = await seed({
      checkpoints: [
        { name: "home", verdict: "passed", viewport: "1280x720" },
        { name: "home", verdict: "passed", viewport: "375x812" },
      ],
    });
    const a = s.runId;
    // B: firefox on desktop.
    const b = (
      await addReviewRun(h, s, {
        checkpoints: [{ name: "home", verdict: "passed", browser: "firefox" }],
      })
    ).runId;
    // C: a phone (webkit, iOS, iPhone 12).
    const c = (
      await addReviewRun(h, s, {
        checkpoints: [
          {
            name: "home",
            verdict: "passed",
            browser: "webkit",
            viewport: "390x844",
            os: "iOS",
            device: "iPhone 12",
          },
        ],
      })
    ).runId;
    // D: no single step is firefox at 375x812: chromium is at 375x812 and
    // firefox is at 1280x720.
    const d2 = (
      await addReviewRun(h, s, {
        checkpoints: [
          { name: "x", verdict: "passed", viewport: "375x812" },
          { name: "y", verdict: "passed", browser: "firefox" },
        ],
      })
    ).runId;

    const filtered = async (q: ListQuery) => sorted(idsOf(await list(s, q)));

    expect(await filtered({})).toEqual(sorted([a, b, c, d2]));

    // One facet at a time: a run matches when at least one of its steps does.
    expect(await filtered({ browser: "firefox" })).toEqual(sorted([b, d2]));
    expect(await filtered({ browser: "chromium" })).toEqual(sorted([a, d2]));
    expect(await filtered({ browser: "webkit" })).toEqual([c]);
    expect(await filtered({ viewport: "375x812" })).toEqual(sorted([a, d2]));
    expect(await filtered({ viewport: "1280x720" })).toEqual(
      sorted([a, b, d2]),
    );
    expect(await filtered({ os: "iOS" })).toEqual([c]);
    expect(await filtered({ device: "iPhone 12" })).toEqual([c]);
    expect(await filtered({ browser: "opera" })).toEqual([]);

    // Facets combine on ONE step (AND), not across a run's steps.
    expect(
      await filtered({ browser: "firefox", viewport: "1280x720" }),
    ).toEqual(sorted([b, d2]));
    expect(
      await filtered({ browser: "chromium", viewport: "375x812" }),
    ).toEqual(sorted([a, d2]));
    expect(await filtered({ browser: "firefox", viewport: "375x812" })).toEqual(
      [],
    );
    expect(
      await filtered({ browser: "webkit", os: "iOS", device: "iPhone 12" }),
    ).toEqual([c]);
    expect(await filtered({ browser: "chromium", os: "iOS" })).toEqual([]);

    // They combine with the other filters, and stay inside the project.
    expect(await filtered({ browser: "firefox", buildId: s.buildId })).toEqual(
      sorted([b, d2]),
    );
    expect(await filtered({ browser: "firefox", branch: "elsewhere" })).toEqual(
      [],
    );
    const other = await seed({
      checkpoints: [{ name: "home", verdict: "passed", browser: "firefox" }],
    });
    expect(await filtered({ browser: "firefox" })).toEqual(sorted([b, d2]));
    expect(idsOf(await list(other, { browser: "firefox" }))).toEqual([
      other.runId,
    ]);
  });

  test("pending: true keeps runs with ≥1 pending step inside the facets", async () => {
    // (a) one step of each verdict: pending (new + unresolved)
    const s = await seed({
      checkpoints: [
        { name: "a-new", verdict: "new" },
        { name: "a-unresolved", verdict: "unresolved" },
        { name: "a-passed", verdict: "passed" },
      ],
    });
    // (b) unresolved with an active approve, (b2) with an active reject: decided
    const b = await addReviewRun(h, s, {
      lifecycle: "passed",
      checkpoints: [{ name: "b", verdict: "unresolved" }],
    });
    await decide(s, b.runId, b.shots.b!.id);
    const b2 = await addReviewRun(h, s, {
      lifecycle: "failed",
      checkpoints: [{ name: "b2", verdict: "unresolved" }],
    });
    await decide(s, b2.runId, b2.shots.b2!.id, { decision: "rejected" });
    // (c) unresolved, its approve reverted: pending again
    const c = await addReviewRun(h, s, {
      checkpoints: [{ name: "c", verdict: "unresolved" }],
    });
    await decide(s, c.runId, c.shots.c!.id, { reverted: true });
    // (d) running, (e) aborted, (f) empty, (g) overridden, (h) a sibling not yet
    // diffed: not reviewable, so nothing in them is pending
    for (const [name, spec] of [
      ["d", { lifecycle: "running" }],
      ["e", { lifecycle: "aborted" }],
      ["f", { lifecycle: "empty" }],
      ["g", { override: "failed" }],
    ] as const) {
      await addReviewRun(h, s, {
        ...spec,
        checkpoints: [{ name, verdict: "unresolved" }],
      });
    }
    await addReviewRun(h, s, {
      lifecycle: "failed",
      checkpoints: [
        { name: "h-unresolved", verdict: "unresolved" },
        { name: "h-undiffed", verdict: null },
      ],
    });
    // (n) a first capture only: every step `new`
    const n = await addReviewRun(h, s, {
      checkpoints: [
        { name: "n1", verdict: "new" },
        { name: "n2", verdict: "new" },
      ],
    });
    // (p) all passed; (q) failed lifecycle with a pending step
    await addReviewRun(h, s, {
      checkpoints: [{ name: "p", verdict: "passed" }],
    });
    const q = await addReviewRun(h, s, {
      lifecycle: "failed",
      checkpoints: [{ name: "q", verdict: "unresolved" }],
    });

    const everything = await list(s, { limit: 100 });
    expect(everything.items).toHaveLength(12);

    const pending = await list(s, { pending: true, limit: 100 });
    expect(sorted(idsOf(pending))).toEqual(
      sorted([s.runId, c.runId, n.runId, q.runId]),
    );
    // Newest first, like every other listing.
    expect(idsOf(pending)).toEqual([q.runId, n.runId, c.runId, s.runId]);

    // `pending: false` is no filter, like leaving it out.
    expect(idsOf(await list(s, { pending: false, limit: 100 }))).toEqual(
      idsOf(everything),
    );

    // The status filter stays as it is and combines with `pending` by AND.
    expect(
      idsOf(await list(s, { pending: true, status: ["new"], limit: 100 })),
    ).toEqual([n.runId]);
    expect(
      sorted(
        idsOf(
          await list(s, { pending: true, status: ["unresolved"], limit: 100 }),
        ),
      ),
    ).toEqual(sorted([s.runId, c.runId]));
    expect(
      idsOf(await list(s, { pending: true, status: ["failed"], limit: 100 })),
    ).toEqual([q.runId]);
    expect(
      await list(s, { pending: true, status: ["passed"], limit: 100 }),
    ).toMatchObject({ items: [] });

    // Pending steps count only inside the facets: every pending step here is
    // chromium at 1280x720.
    expect(
      sorted(
        idsOf(
          await list(s, { pending: true, browser: "chromium", limit: 100 }),
        ),
      ),
    ).toEqual(sorted([s.runId, c.runId, n.runId, q.runId]));
    expect(
      idsOf(await list(s, { pending: true, browser: "firefox", limit: 100 })),
    ).toEqual([]);

    // It pages like any other filter.
    const first = await list(s, { pending: true, limit: 3 });
    expect(idsOf(first)).toEqual([q.runId, n.runId, c.runId]);
    const second = await list(s, {
      pending: true,
      limit: 3,
      cursor: first.nextCursor!,
    });
    expect(idsOf(second)).toEqual([s.runId]);
    expect(second.nextCursor).toBeNull();
  });

  test("order: capture lists oldest first and pages forward", async () => {
    const s = await seed({ checkpoints: [{ name: "a", verdict: "passed" }] });
    const r2 = await addReviewRun(h, s, {
      checkpoints: [{ name: "b", verdict: "passed" }],
    });
    const r3 = await addReviewRun(h, s, {
      checkpoints: [{ name: "c", verdict: "passed" }],
    });
    const r1 = { runId: s.runId };

    const first = await list(s, { order: "capture", limit: 2 });
    expect(idsOf(first)).toEqual([r1.runId, r2.runId]);
    expect(first.nextCursor).not.toBeNull();
    const second = await list(s, {
      order: "capture",
      limit: 2,
      cursor: first.nextCursor!,
    });
    expect(idsOf(second)).toEqual([r3.runId]);
    expect(second.nextCursor).toBeNull();

    // Newest first stays the default, and `order: "newest"` is the same thing.
    const newest = [r3.runId, r2.runId, r1.runId];
    expect(idsOf(await list(s))).toEqual(newest);
    expect(idsOf(await list(s, { order: "newest" }))).toEqual(newest);
    const newestFirst = await list(s, { limit: 2 });
    expect(
      idsOf(await list(s, { limit: 2, cursor: newestFirst.nextCursor! })),
    ).toEqual([r1.runId]);

    // Runs sharing a created_at are not skipped or repeated: the id breaks the tie.
    const [r1Row] = await h.db
      .select({ createdAt: testRuns.createdAt })
      .from(testRuns)
      .where(eq(testRuns.id, r1.runId));
    const tie = new Date(r1Row!.createdAt.getTime() + 60_000);
    await h.db
      .update(testRuns)
      .set({ createdAt: tie })
      .where(inArray(testRuns.id, [r2.runId, r3.runId]));
    const walked: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 5; i++) {
      const page = await list(s, {
        order: "capture",
        limit: 1,
        ...(cursor ? { cursor } : {}),
      });
      walked.push(...idsOf(page));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    // r1 stays first (the shared instant is later than its capture time).
    expect(walked).toEqual([r1.runId, ...sorted([r2.runId, r3.runId])]);
  });

  test("pendingCount and stepCount per row", async () => {
    // A: three steps, two of them pending
    const s = await seed({
      checkpoints: [
        { name: "a-new", verdict: "new" },
        { name: "a-unresolved", verdict: "unresolved" },
        { name: "a-passed", verdict: "passed" },
      ],
    });
    // B: nothing to review
    const b = await addReviewRun(h, s, {
      checkpoints: [{ name: "b", verdict: "passed" }],
    });
    // C: still running, so not reviewable: two steps, none pending
    const c = await addReviewRun(h, s, {
      lifecycle: "running",
      checkpoints: [
        { name: "c1", verdict: "unresolved" },
        { name: "c2", verdict: "unresolved" },
      ],
    });
    // D: one of two pending steps already decided
    const d2 = await addReviewRun(h, s, {
      checkpoints: [
        { name: "d1", verdict: "unresolved" },
        { name: "d2", verdict: "unresolved" },
      ],
    });
    await decide(s, d2.runId, d2.shots.d1!.id);
    // E: no steps at all
    const e = await addReviewRun(h, s, { lifecycle: "empty", checkpoints: [] });

    const page = await list(s, { limit: 100 });
    const counts = Object.fromEntries(
      page.items.map((i) => [i.id, [i.pendingCount, i.stepCount]]),
    );
    expect(counts).toEqual({
      [s.runId]: [2, 3],
      [b.runId]: [0, 1],
      [c.runId]: [0, 2],
      [d2.runId]: [1, 2],
      [e.runId]: [0, 0],
    });
    // The run's own columns are still there beside the new ones.
    expect(page.items[0]).toMatchObject({
      id: e.runId,
      projectId: s.projectId,
      buildId: s.buildId,
    });
  });

  test("the counts come from one grouped query each, however many rows", async () => {
    const s = await seed({
      checkpoints: [{ name: "a", verdict: "unresolved" }],
    });
    const caller = (db: DB) =>
      runsRouter.createCaller({
        user: { id: s.admin.id, role: "admin", via: "jwt" },
        db,
      } as unknown as Context);

    const one = countingDb(h.db);
    const small = await caller(one.db).list({ projectId: s.projectId });
    for (let i = 0; i < 6; i++) {
      await addReviewRun(h, s, {
        checkpoints: [
          { name: `r${i}-1`, verdict: "unresolved" },
          { name: `r${i}-2`, verdict: "new" },
        ],
      });
    }
    const many = countingDb(h.db);
    const big = await caller(many.db).list({ projectId: s.projectId });

    expect(small.items).toHaveLength(1);
    expect(big.items).toHaveLength(7);
    expect(big.items.map((i) => i.pendingCount)).toEqual([2, 2, 2, 2, 2, 2, 1]);
    // The page, the pending counts and the step counts: three statements for
    // one row or for seven.
    expect(one.count()).toBe(many.count());
    expect(many.count()).toBeLessThanOrEqual(3);
    // An empty page asks nothing about its (absent) rows.
    const none = countingDb(h.db);
    const empty = await caller(none.db).list({
      projectId: s.projectId,
      branch: "no-such-branch",
    });
    expect(empty.items).toEqual([]);
    expect(none.count()).toBeLessThanOrEqual(1);
  });

  test("pending + facets: membership and pendingCount respect the facets, stepCount does not", async () => {
    // X: pending at both viewports
    const s = await seed({
      checkpoints: [
        { name: "home", verdict: "unresolved", viewport: "1280x720" },
        { name: "home", verdict: "unresolved", viewport: "375x812" },
      ],
    });
    const x = s.runId;
    // Y: pending on desktop only
    const y = (
      await addReviewRun(h, s, {
        checkpoints: [
          { name: "home", verdict: "unresolved", viewport: "1280x720" },
        ],
      })
    ).runId;
    // Z: has a mobile step, but it is passed; its pending step is on desktop
    const z = (
      await addReviewRun(h, s, {
        checkpoints: [
          { name: "home", verdict: "passed", viewport: "375x812" },
          { name: "about", verdict: "unresolved", viewport: "1280x720" },
        ],
      })
    ).runId;
    // V: mobile only, passed
    const v = (
      await addReviewRun(h, s, {
        checkpoints: [{ name: "home", verdict: "passed", viewport: "375x812" }],
      })
    ).runId;

    const summary = async (q: ListQuery) =>
      Object.fromEntries(
        (await list(s, { limit: 100, ...q })).items.map((i) => [
          i.id,
          [i.pendingCount, i.stepCount],
        ]),
      );

    // No facets: pending anywhere in the run.
    expect(await summary({ pending: true })).toEqual({
      [x]: [2, 2],
      [y]: [1, 1],
      [z]: [1, 2],
    });
    // The mobile facet: only X has a pending MOBILE step. Z has a mobile step
    // and a pending step, but they are two different steps, so Z is out. The
    // counts are of the mobile steps; stepCount still counts every step.
    expect(await summary({ pending: true, viewport: "375x812" })).toEqual({
      [x]: [1, 2],
    });
    expect(await summary({ pending: true, viewport: "1280x720" })).toEqual({
      [x]: [1, 2],
      [y]: [1, 1],
      [z]: [1, 2],
    });
    expect(await summary({ pending: true, viewport: "1024x768" })).toEqual({});

    // Facets without `pending` filter by step only, while pendingCount is
    // still the pending steps inside them.
    expect(await summary({ viewport: "375x812" })).toEqual({
      [x]: [1, 2],
      [z]: [0, 2],
      [v]: [0, 1],
    });

    // Combined with status (AND): X and Y are `unresolved`, V is `passed`.
    expect(
      await summary({
        pending: true,
        viewport: "375x812",
        status: ["passed"],
      }),
    ).toEqual({});
    expect(
      await summary({
        pending: true,
        viewport: "375x812",
        status: ["unresolved"],
      }),
    ).toEqual({ [x]: [1, 2] });

    // A step decided on mobile is no longer pending there.
    await h.db.insert(checkpointDecisions).values({
      projectId: s.projectId,
      runId: x,
      screenshotId: s.shotsInOrder[1]!.id,
      actionId: randomUUID(),
      decision: "approved",
      actorId: s.editor.id,
      source: "viewer",
      before: null,
    });
    expect(await summary({ pending: true, viewport: "375x812" })).toEqual({});
    expect(await summary({ pending: true })).toEqual({
      [x]: [1, 2],
      [y]: [1, 1],
      [z]: [1, 2],
    });
  });

  test("counts and filters follow runs added to later builds", async () => {
    const s = await seed({ checkpoints: [{ name: "a", verdict: "passed" }] });
    const later = await addReviewBuild(h, s, {
      branch: "feature/other",
      spec: {
        checkpoints: [{ name: "b", verdict: "unresolved", browser: "firefox" }],
      },
    });
    const sibling = await addReviewRun(
      h,
      s,
      {
        checkpoints: [{ name: "c", verdict: "new", browser: "firefox" }],
      },
      { buildId: later.buildId },
    );
    expect(
      sorted(idsOf(await list(s, { buildId: later.buildId, pending: true }))),
    ).toEqual(sorted([later.runId, sibling.runId]));
    expect(
      sorted(idsOf(await list(s, { pending: true, browser: "firefox" }))),
    ).toEqual(sorted([later.runId, sibling.runId]));
    expect(await list(s, { pending: true, browser: "chromium" })).toMatchObject(
      { items: [] },
    );
  });

  describe("runs.facets", () => {
    /** `runs.facets` for a build, as `user` (the seed's editor by default). */
    function facets(
      s: ReviewSeed,
      buildId: string = s.buildId,
      user: { jwt: string } = s.editor,
    ) {
      return makeClient(baseUrl, user.jwt).runs.facets.query({ buildId });
    }

    test("runs.facets lists the batch's values with pending counts", async () => {
      // Run 1: a pending desktop chromium step, a passed phone step.
      const s = await seed({
        checkpoints: [
          { name: "home", verdict: "unresolved", viewport: "1280x720" },
          { name: "home", verdict: "passed", viewport: "375x812" },
        ],
      });
      // Run 2: a new firefox step, and a webkit iPhone step that is pending
      // too (an undecided one in a reviewable run).
      await addReviewRun(h, s, {
        checkpoints: [
          { name: "about", verdict: "new", browser: "firefox" },
          {
            name: "about",
            verdict: "unresolved",
            browser: "webkit",
            viewport: "390x844",
            os: "iOS",
            device: "iPhone 12",
          },
        ],
      });
      // Run 3: a pending step that is decided, so it is not pending.
      const decided = await addReviewRun(h, s, {
        lifecycle: "passed",
        checkpoints: [
          { name: "decided", verdict: "unresolved", browser: "firefox" },
        ],
      });
      await decide(s, decided.runId, decided.shots.decided!.id);
      // Run 4: still running (not reviewable), so its step is not pending,
      // but its environment still counts as a value of the batch.
      await addReviewRun(h, s, {
        lifecycle: "running",
        checkpoints: [
          { name: "running", verdict: "unresolved", browser: "opera" },
        ],
      });
      // Another build of the same project, and another project, do not leak in.
      await addReviewBuild(h, s, {
        spec: {
          checkpoints: [
            {
              name: "elsewhere",
              verdict: "unresolved",
              browser: "edge",
              viewport: "800x600",
              os: "Linux",
              device: "Pixel",
            },
          ],
        },
      });
      await seed({
        checkpoints: [
          { name: "foreign", verdict: "unresolved", browser: "safari" },
        ],
      });

      const values = await facets(s);
      expect(values).toEqual({
        browser: [
          { value: "chromium", pending: 1 },
          { value: "firefox", pending: 1 },
          { value: "opera", pending: 0 },
          { value: "webkit", pending: 1 },
        ],
        viewport: [
          { value: "1280x720", pending: 2 },
          { value: "375x812", pending: 0 },
          { value: "390x844", pending: 1 },
        ],
        // NULL os / device (the desktop steps) are omitted.
        os: [{ value: "iOS", pending: 1 }],
        device: [{ value: "iPhone 12", pending: 1 }],
      });

      // One pending definition: each value's count is what the batch page's
      // list reports for that facet (its runs' summed pendingCount).
      for (const dimension of [
        "browser",
        "viewport",
        "os",
        "device",
      ] as const) {
        for (const { value, pending } of values[dimension]) {
          const page = await list(s, {
            buildId: s.buildId,
            pending: true,
            limit: 100,
            [dimension]: value,
          });
          const summed = page.items.reduce((n, r) => n + r.pendingCount, 0);
          expect([dimension, value, summed]).toEqual([
            dimension,
            value,
            pending,
          ]);
        }
      }
    });

    test("a build with no step has no values; one with no os or device lists none", async () => {
      const s = await seed({ checkpoints: [] });
      expect(await facets(s)).toEqual({
        browser: [],
        viewport: [],
        os: [],
        device: [],
      });

      await addReviewRun(h, s, {
        checkpoints: [{ name: "a", verdict: "passed" }],
      });
      expect(await facets(s)).toEqual({
        browser: [{ value: "chromium", pending: 0 }],
        viewport: [{ value: "1280x720", pending: 0 }],
        os: [],
        device: [],
      });
    });

    test("a pending step counts once however many runs share the value; a sibling undiffed step makes the whole run non-pending", async () => {
      const s = await seed({
        checkpoints: [
          { name: "a", verdict: "unresolved" },
          { name: "b", verdict: "new" },
        ],
      });
      await addReviewRun(h, s, {
        checkpoints: [{ name: "c", verdict: "unresolved" }],
      });
      // An undiffed step blocks its run: neither of the run's steps is pending.
      await addReviewRun(h, s, {
        checkpoints: [
          { name: "d", verdict: "unresolved" },
          { name: "e", verdict: null },
        ],
      });
      expect((await facets(s)).browser).toEqual([
        { value: "chromium", pending: 3 },
      ]);
    });

    test("values come back in ascending order", async () => {
      const s = await seed({
        checkpoints: [
          { name: "a", verdict: "passed", browser: "webkit", viewport: "9x9" },
          {
            name: "b",
            verdict: "passed",
            browser: "chromium",
            viewport: "1x1",
          },
          { name: "c", verdict: "passed", browser: "firefox", viewport: "5x5" },
        ],
      });
      const res = await facets(s);
      expect(res.browser.map((v) => v.value)).toEqual([
        "chromium",
        "firefox",
        "webkit",
      ]);
      expect(res.viewport.map((v) => v.value)).toEqual(["1x1", "5x5", "9x9"]);
    });

    test("an admin who is not a member can read it; a guest, an outsider and another project's member cannot; an unknown build is NOT_FOUND", async () => {
      const s = await seed({
        checkpoints: [{ name: "a", verdict: "unresolved" }],
      });
      const expected = {
        browser: [{ value: "chromium", pending: 1 }],
        viewport: [{ value: "1280x720", pending: 1 }],
        os: [],
        device: [],
      };
      expect(await facets(s, s.buildId, s.admin)).toEqual(expected);
      // The membership gate rejects a guest, member or not.
      await expect(facets(s, s.buildId, s.guest)).rejects.toMatchObject({
        data: { code: "FORBIDDEN" },
      });
      await expect(facets(s, s.buildId, s.outsider)).rejects.toMatchObject({
        data: { code: "FORBIDDEN" },
      });
      // A member of another project is an outsider to this build.
      const other = await seed({
        checkpoints: [{ name: "a", verdict: "unresolved" }],
      });
      await expect(facets(s, s.buildId, other.editor)).rejects.toMatchObject({
        data: { code: "FORBIDDEN" },
      });
      await expect(
        facets(s, "00000000-0000-0000-0000-000000000000", s.admin),
      ).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
      await expect(
        facets(s, "00000000-0000-0000-0000-000000000000", s.editor),
      ).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
    });
  });
});
