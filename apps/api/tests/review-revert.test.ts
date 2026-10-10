import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";

import {
  and,
  asc,
  auditLog,
  baselines,
  builds,
  checkpointDecisions,
  createDb,
  eq,
  recomputeRunStatus,
  resolveBaseline,
  screenshots,
  sql,
  testRuns,
  testVariations,
  users,
  type CheckpointDecisionRow,
} from "@furan/db";
import type { RevertSkipReason } from "@furan/shared-types";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { TRPCError } from "@trpc/server";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";

import { decideCheckpoints } from "../src/lib/review/decide.js";
import { ReviewRefusal } from "../src/lib/review/errors.js";
import { SDK_REGION_SOURCE } from "../src/lib/review/promote.js";
import {
  assessRevert,
  isoToMicros,
  jsonEqual,
  revertAction,
  type RevertResult,
} from "../src/lib/review/revert.js";
import type { AuthedUser } from "../src/plugins/auth.js";
import type { AppRouter } from "../src/trpc/v1/router.js";

import { createTestApp, type TestApp } from "./helpers.js";
import {
  addReviewRun,
  cleanupReviewSeeds,
  seedReviewRun,
  type ReviewRunSpec,
  type ReviewSeed,
  type ReviewUser,
} from "./review-fixtures.js";

// A test-only failure hook: `recomputeRunStatus` calls straight through unless
// a test queues a one-off implementation (the R16 JS-throw test does).
vi.mock("@furan/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@furan/db")>();
  return { ...actual, recomputeRunStatus: vi.fn(actual.recomputeRunStatus) };
});

/** The fixture's branch, viewport and browser (`review-fixtures.ts`). */
const BRANCH = "feature/review";
const VIEWPORT = "1280x720";
const BROWSER = "chromium";

const skip = !process.env.DATABASE_URL;
const d = skip ? describe.skip : describe;

const logger = { info: vi.fn(), error: vi.fn() };

function actorOf(u: Pick<ReviewUser, "id" | "role">): AuthedUser {
  return { id: u.id, role: u.role, via: "jwt" };
}

const target = (runId: string, screenshotId: string) => ({
  runId,
  screenshotId,
});

/** The structured refusal a review error carries. */
function refusal(err: unknown): { code: string; message: string } {
  expect(err).toBeInstanceOf(TRPCError);
  const e = err as TRPCError;
  expect(e.cause).toBeInstanceOf(ReviewRefusal);
  return { code: e.code, message: e.message };
}

/** The rejection of `p`, failing the test if it resolves. */
async function rejection(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    (v) => {
      throw new Error(`expected a rejection, got ${JSON.stringify(v)}`);
    },
    (e: unknown) => e,
  );
}

/** The SQLSTATE somewhere in an error's cause chain. */
function pgCode(err: unknown): string | undefined {
  let cur: unknown = err;
  for (let depth = 0; cur && depth < 6; depth++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

/** A row without `updated_at`, which a restore legitimately bumps. */
function stable<T extends { updatedAt: Date }>(row: T): Omit<T, "updatedAt"> {
  const { updatedAt: _updatedAt, ...rest } = row;
  return rest;
}

/** A timestamptz column as µs-exact ISO text (what a JS Date can't hold). */
const isoMicros = (col: unknown) =>
  sql<string>`to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

// ---------------------------------------------------------------------------
// isoToMicros (pure): how the assessment orders a snapshot's `prev.createdAt`.
// ---------------------------------------------------------------------------

/** Timestamps a snapshot may carry, as Postgres reads them back unchanged. */
const RESTORABLE_TIMESTAMPS = [
  "2026-01-02T03:04:05.123456Z",
  "2026-01-02T03:04:05.123400Z",
  "2026-01-02T03:04:05Z",
  "2026-01-02T03:04:05.5Z",
  "2026-01-02T05:34:05.000001+02:30",
  "2025-12-31T21:04:05.999999-06:00",
  "2024-02-29T00:00:00.000000Z",
];

describe("isoToMicros", () => {
  test("keeps the microseconds a JS Date drops", () => {
    expect(isoToMicros("2026-01-02T03:04:05.123456Z")).toBe(
      BigInt(Date.parse("2026-01-02T03:04:05.123Z")) * 1000n + 456n,
    );
    expect(
      isoToMicros("2026-01-02T03:04:05.123456Z")! -
        isoToMicros("2026-01-02T03:04:05.123400Z")!,
    ).toBe(56n);
  });

  test("applies the offset", () => {
    expect(isoToMicros("2026-01-02T05:34:05.5+02:30")).toBe(
      isoToMicros("2026-01-02T03:04:05.500000Z"),
    );
  });

  test.each([
    "yesterday",
    "",
    "2026-01-02 03:04:05Z",
    "2026-01-02T03:04:05",
    "2026-01-02T03:04:05.1234567Z",
    "2026-02-31T00:00:00Z",
    "2026-13-01T00:00:00Z",
    "2026-01-02T24:00:00Z",
    "2026-01-02T03:60:00Z",
    "0099-01-01T00:00:00Z",
    "2026-01-02T03:04:05+16:00",
  ])("rejects %j", (s) => {
    expect(isoToMicros(s)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// jsonEqual (pure): the R25 edit check compares variation fields by value.
// ---------------------------------------------------------------------------

describe("jsonEqual", () => {
  test.each<[string, unknown, unknown]>([
    [
      "object keys in another order",
      { a: 1, b: [2, { c: 3, d: 4 }] },
      { b: [2, { d: 4, c: 3 }], a: 1 },
    ],
    ["null and null", null, null],
    ["equal primitives", "Strict", "Strict"],
    ["empty arrays", [], []],
  ])("equal: %s", (_label, a, b) => {
    expect(jsonEqual(a, b)).toBe(true);
    expect(jsonEqual(b, a)).toBe(true);
  });

  test.each<[string, unknown, unknown]>([
    ["arrays in another order", [1, 2], [2, 1]],
    ["a region added", [{ x: 1 }], [{ x: 1 }, { x: 2 }]],
    ["a key added", { x: 1 }, { x: 1, source: "sdk" }],
    ["a value changed deep down", { a: [{ x: 1 }] }, { a: [{ x: 2 }] }],
    ["null and an empty array", null, []],
    ["an empty array and an empty object", [], {}],
    ["a number and its string", 1, "1"],
    ["a key whose value is null, and no key", { x: null }, { y: null }],
  ])("different: %s", (_label, a, b) => {
    expect(jsonEqual(a, b)).toBe(false);
    expect(jsonEqual(b, a)).toBe(false);
  });
});

d("revertAction", () => {
  let h: TestApp;
  let baseUrl: string;
  const seeds: ReviewSeed[] = [];
  const extraUserIds: string[] = [];

  async function seed(spec: ReviewRunSpec): Promise<ReviewSeed> {
    const s = await seedReviewRun(h, spec);
    seeds.push(s);
    return s;
  }

  function deps() {
    return { registry: h.telemetry.metrics, logger };
  }

  /** Decides through the core; returns the action id. */
  async function decide(
    s: ReviewSeed,
    decision: "approved" | "rejected",
    targets: Array<{ runId: string; screenshotId: string }>,
    by: ReviewUser = s.editor,
  ): Promise<string> {
    const actionId = randomUUID();
    await h.db.transaction((tx) =>
      decideCheckpoints(
        tx,
        {
          actor: actorOf(by),
          projectId: s.projectId,
          actionId,
          source: "viewer",
          decision,
          targets,
        },
        deps(),
      ),
    );
    return actionId;
  }

  function revert(
    by: Pick<ReviewUser, "id" | "role">,
    actionId: string,
    projectId?: string,
  ): Promise<RevertResult> {
    return h.db.transaction((tx) =>
      revertAction(
        tx,
        { actor: actorOf(by), actionId, ...(projectId ? { projectId } : {}) },
        deps(),
      ),
    );
  }

  const decisionsOfAction = (actionId: string) =>
    h.db
      .select()
      .from(checkpointDecisions)
      .where(eq(checkpointDecisions.actionId, actionId))
      .orderBy(asc(checkpointDecisions.createdAt), asc(checkpointDecisions.id));

  const baselinesOfRun = (runId: string) =>
    h.db
      .select()
      .from(baselines)
      .where(eq(baselines.testRunId, runId))
      .orderBy(asc(baselines.createdAt), asc(baselines.id));

  const baselineById = async (id: string) =>
    (await h.db.select().from(baselines).where(eq(baselines.id, id)))[0];

  async function baselineTimes(id: string) {
    const [r] = await h.db
      .select({
        createdAt: isoMicros(baselines.createdAt),
        updatedAt: isoMicros(baselines.updatedAt),
      })
      .from(baselines)
      .where(eq(baselines.id, id));
    return r;
  }

  async function runRow(runId: string) {
    const [r] = await h.db
      .select()
      .from(testRuns)
      .where(eq(testRuns.id, runId));
    return r!;
  }

  async function variationRow(id: string) {
    const [v] = await h.db
      .select()
      .from(testVariations)
      .where(eq(testVariations.id, id));
    return v!;
  }

  async function shotRow(id: string) {
    const [s] = await h.db
      .select()
      .from(screenshots)
      .where(eq(screenshots.id, id));
    return s!;
  }

  const currentBaseline = (s: ReviewSeed, variationId: string) =>
    resolveBaseline(h.db, s.projectId, BRANCH, variationId, {
      defaultBranch: "main",
    });

  const revertAudit = (actionId: string) =>
    h.db
      .select({
        actorId: auditLog.actorId,
        targetType: auditLog.targetType,
        targetId: auditLog.targetId,
        metadata: auditLog.metadata,
      })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "run.revert_action"),
          sql`${auditLog.metadata}->>'actionId' = ${actionId}`,
        ),
      );

  async function metric(
    name: string,
    labels: Record<string, string>,
  ): Promise<number> {
    const json = await h.telemetry.metrics.getMetricsAsJSON();
    const m = json.find((x) => x.name === name);
    const value = m?.values.find((v) =>
      Object.entries(labels).every(([k, want]) => v.labels[k] === want),
    );
    return Number(value?.value ?? 0);
  }
  const revertsMetric = (outcome: "reverted" | "skipped") =>
    metric("furan_review_reverts_total", { outcome });
  const refusedMetric = (reason: RevertSkipReason) =>
    metric("furan_review_revert_refused_total", { reason });

  /**
   * A capture of a "home" variation made NOW (after any decision so far): a
   * new build + run on `branch`, and a screenshot of the project's variation
   * with that branch and `viewport` (created when it doesn't exist yet).
   */
  async function captureNow(
    s: ReviewSeed,
    opts: { branch: string; viewport?: string },
  ): Promise<{ runId: string; variationId: string; screenshotId: string }> {
    const viewport = opts.viewport ?? VIEWPORT;
    const [v] = await h.db
      .insert(testVariations)
      .values({
        projectId: s.projectId,
        name: "home",
        branchName: opts.branch,
        browser: BROWSER,
        viewport,
      })
      .onConflictDoUpdate({
        target: [
          testVariations.projectId,
          testVariations.name,
          testVariations.browser,
          testVariations.viewport,
          testVariations.branchName,
          testVariations.os,
          testVariations.device,
        ],
        set: { updatedAt: new Date() },
      })
      .returning({ id: testVariations.id });
    const [b] = await h.db
      .insert(builds)
      .values({ projectId: s.projectId, branchName: opts.branch })
      .returning({ id: builds.id });
    const [r] = await h.db
      .insert(testRuns)
      .values({
        buildId: b!.id,
        projectId: s.projectId,
        name: `later-${s.tag}`,
        status: "unresolved",
        branchName: opts.branch,
      })
      .returning({ id: testRuns.id });
    const [shot] = await h.db
      .insert(screenshots)
      .values({
        runId: r!.id,
        projectId: s.projectId,
        testVariationId: v!.id,
        name: "home",
        viewport,
        browser: BROWSER,
        imageKey: `later-${randomUUID()}.png`,
        verdict: "unresolved",
        // The database's clock, like the decision's `created_at` it is
        // compared with (R24): never the host's, which may drift from it.
        verdictAt: sql`clock_timestamp()`,
      })
      .returning({ id: screenshots.id });
    return { runId: r!.id, variationId: v!.id, screenshotId: shot!.id };
  }

  /** A re-diff of `screenshotId` landing now (after any decision so far). */
  const rediffNow = (screenshotId: string) =>
    h.db
      .update(screenshots)
      .set({ verdict: "passed", verdictAt: sql`clock_timestamp()` })
      .where(eq(screenshots.id, screenshotId));

  /** The dashboard's tRPC client, as `u`. */
  function clientFor(u: ReviewUser) {
    return createTRPCClient<AppRouter>({
      links: [
        httpBatchLink({
          url: `${baseUrl}/trpc`,
          headers: { authorization: `Bearer ${u.jwt}` },
        }),
      ],
    });
  }

  /** True once some backend waits on a lock held by `blockerPid`. */
  async function waitForLockWaiter(
    blockerPid: number,
    capMs = 5_000,
  ): Promise<boolean> {
    const deadline = Date.now() + capMs;
    while (Date.now() < deadline) {
      const rows = await h.db.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE wait_event_type = 'Lock'
          AND ${blockerPid}::int = ANY(pg_blocking_pids(pid))
      `);
      if (rows[0]!.n > 0) return true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return false;
  }

  beforeAll(async () => {
    h = await createTestApp();
    h.app.log.level = "silent";
    await h.app.listen({ host: "127.0.0.1", port: 0 });
    baseUrl = `http://127.0.0.1:${(h.app.server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await cleanupReviewSeeds(h, seeds);
    if (extraUserIds.length > 0) {
      for (const id of extraUserIds) {
        await h.db.delete(auditLog).where(eq(auditLog.actorId, id));
        await h.db.delete(users).where(eq(users.id, id));
      }
    }
    await h.close();
  });

  beforeEach(() => {
    logger.info.mockClear();
    logger.error.mockClear();
  });

  describe("undoing an approve", () => {
    test("restores the run, deletes the inserted baseline and puts the variation back exactly, SDK-tagged regions included", async () => {
      const s = await seed({
        checkpoints: [
          { name: "home", verdict: "unresolved", withBaseline: true },
          { name: "cart", verdict: "passed", withBaseline: true },
        ],
      });
      const home = s.shots.home!;
      const reviewerRegion = { x: 1, y: 2, width: 3, height: 4 };
      const sdkRegion = {
        x: 10,
        y: 20,
        width: 30,
        height: 40,
        source: SDK_REGION_SOURCE,
      };
      await h.db
        .update(testVariations)
        .set({
          ignoreRegions: [reviewerRegion, sdkRegion],
          layoutRegions: [{ x: 5, y: 6, width: 7, height: 8 }],
          floatingRegions: [{ x: 9, y: 9, width: 9, height: 9 }],
          contentRegions: [{ x: 11, y: 11, width: 11, height: 11 }],
          accessibilityRegions: [{ x: 12, y: 12, width: 12, height: 12 }],
          matchLevel: "Layout",
        })
        .where(eq(testVariations.id, home.variationId));
      // The checkpoint captured other SDK regions, so the approve replaces them.
      const captured = { x: 50, y: 60, width: 70, height: 80 };
      await h.db
        .update(screenshots)
        .set({ ignoreRegions: [captured] })
        .where(eq(screenshots.id, home.id));
      const before = await variationRow(home.variationId);
      const currentBefore = await currentBaseline(s, home.variationId);
      expect(currentBefore?.source).toBe("this_branch");

      const actionId = await decide(s, "approved", [target(s.runId, home.id)]);

      // The approve changed everything the undo has to put back.
      const promoted = await variationRow(home.variationId);
      expect(promoted.baselineName).toBe(home.imageKey);
      expect(promoted.matchLevel).toBe("Strict");
      expect(promoted.layoutRegions).toBeNull();
      expect(promoted.ignoreRegions).toEqual([
        reviewerRegion,
        { ...captured, source: SDK_REGION_SOURCE },
      ]);
      expect((await runRow(s.runId)).status).toBe("passed");
      const [inserted] = await baselinesOfRun(s.runId);
      expect(inserted).toBeDefined();
      const revertedBefore = await revertsMetric("reverted");

      const res = await revert(s.editor, actionId);

      expect(res).toEqual({
        actionId,
        reverted: 1,
        skipped: [],
        rediffRunIds: [],
        runs: [{ runId: s.runId, status: "unresolved" }],
      });
      const run = await runRow(s.runId);
      expect(run.status).toBe("unresolved");
      expect(run.merge).toBe(false);
      expect(await baselineById(inserted!.id)).toBeUndefined();
      expect(await baselinesOfRun(s.runId)).toEqual([]);
      expect(stable(await variationRow(home.variationId))).toEqual(
        stable(before),
      );
      expect(await currentBaseline(s, home.variationId)).toEqual(currentBefore);
      // Not re-diffed since the approve: the verdict stands.
      expect((await shotRow(home.id)).verdict).toBe("unresolved");

      const [row] = await decisionsOfAction(actionId);
      expect(row!.revertedAt).toBeInstanceOf(Date);
      expect(row!.revertedBy).toBe(s.editor.id);

      expect(await revertAudit(actionId)).toEqual([
        {
          actorId: s.editor.id,
          targetType: "run",
          targetId: s.runId,
          metadata: { actionId, reverted: 1, skipped: [], runIds: [s.runId] },
        },
      ]);
      expect(await revertsMetric("reverted")).toBe(revertedBefore + 1);
      expect(logger.info).toHaveBeenCalledWith(
        {
          project_id: s.projectId,
          run_id: s.runId,
          actor_id: s.editor.id,
          action_id: actionId,
          reverted: 1,
          skipped: 0,
          rediff: 0,
        },
        "review_reverted",
      );
    });

    test("an updated (variation, run) row gets its previous values back, created_at to the microsecond, and is current again", async () => {
      const s = await seed({
        checkpoints: [{ name: "home", verdict: "new", withBaseline: true }],
      });
      const home = s.shots.home!;
      // An older baseline (the baseline run's) in the SAME millisecond as the
      // run's own row, 56 µs before it. A restore truncated to milliseconds
      // (…05.123Z) would sort the run's row behind it.
      await h.db
        .update(baselines)
        .set({ createdAt: sql`'2026-01-02T03:04:05.123400Z'::timestamptz` })
        .where(
          and(
            eq(baselines.testRunId, s.baselineRunId!),
            eq(baselines.testVariationId, home.variationId),
          ),
        );
      // The run's own row, from an earlier write (an auto-seed, say).
      const [own] = await h.db
        .insert(baselines)
        .values({
          baselineName: "auto-old.png",
          testVariationId: home.variationId,
          testRunId: s.runId,
          branchName: BRANCH,
          userId: s.admin.id,
          createdAt: sql`'2026-01-02T03:04:05.123456Z'::timestamptz`,
          updatedAt: sql`'2026-01-02T03:04:06.654321Z'::timestamptz`,
        })
        .returning();
      expect((await currentBaseline(s, home.variationId))?.baselineId).toBe(
        own!.id,
      );

      const actionId = await decide(s, "approved", [target(s.runId, home.id)]);
      // The approve re-stamped and re-attributed that same row.
      expect(await baselinesOfRun(s.runId)).toHaveLength(1);
      expect(await baselineById(own!.id)).toMatchObject({
        baselineName: home.imageKey,
        userId: s.editor.id,
      });
      expect((await baselineTimes(own!.id))!.createdAt).not.toBe(
        "2026-01-02T03:04:05.123456Z",
      );

      const res = await revert(s.editor, actionId);

      expect(res.reverted).toBe(1);
      expect(res.runs).toEqual([{ runId: s.runId, status: "new" }]);
      expect(await baselineById(own!.id)).toMatchObject({
        baselineName: "auto-old.png",
        userId: s.admin.id,
        branchName: BRANCH,
        testRunId: s.runId,
        testVariationId: home.variationId,
      });
      expect(await baselineTimes(own!.id)).toEqual({
        createdAt: "2026-01-02T03:04:05.123456Z",
        updatedAt: "2026-01-02T03:04:06.654321Z",
      });
      // resolveBaseline picks the run's own (restored) row again.
      expect((await currentBaseline(s, home.variationId))?.baselineId).toBe(
        own!.id,
      );
    });

    test("an action that approved the same variation in two runs is undone in reverse order, back to the pre-action state", async () => {
      const s = await seed({
        checkpoints: [
          { name: "home", verdict: "unresolved", withBaseline: true },
        ],
      });
      const r2 = await addReviewRun(h, s, {
        checkpoints: [{ name: "home", verdict: "unresolved" }],
      });
      const variationId = s.shots.home!.variationId;
      expect(r2.shots.home!.variationId).toBe(variationId);
      await h.db
        .update(testVariations)
        .set({
          ignoreRegions: [{ x: 1, y: 1, width: 2, height: 2 }],
          matchLevel: "Layout",
        })
        .where(eq(testVariations.id, variationId));
      const before = await variationRow(variationId);
      const currentBefore = await currentBaseline(s, variationId);

      const actionId = await decide(s, "approved", [
        target(r2.runId, r2.shots.home!.id),
        target(s.runId, s.shots.home!.id),
      ]);
      // Capture order: the later run was written last and is current.
      expect((await variationRow(variationId)).baselineName).toBe(
        r2.shots.home!.imageKey,
      );

      const res = await revert(s.editor, actionId);

      expect(res.reverted).toBe(2);
      expect(res.skipped).toEqual([]);
      expect(res.runs).toEqual(
        [
          { runId: s.runId, status: "unresolved" },
          { runId: r2.runId, status: "unresolved" },
        ].sort((x, y) => (x.runId < y.runId ? -1 : 1)),
      );
      expect(await baselinesOfRun(s.runId)).toEqual([]);
      expect(await baselinesOfRun(r2.runId)).toEqual([]);
      expect(stable(await variationRow(variationId))).toEqual(stable(before));
      expect(await currentBaseline(s, variationId)).toEqual(currentBefore);

      // A multi-run action is audited against the build.
      const runIds = [s.runId, r2.runId].sort();
      expect(await revertAudit(actionId)).toEqual([
        {
          actorId: s.editor.id,
          targetType: "build",
          targetId: s.buildId,
          metadata: { actionId, reverted: 2, skipped: [], runIds },
        },
      ]);
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ run_ids: runIds, action_id: actionId }),
        "review_reverted",
      );
    });
  });

  test("undoing a reject only marks it reverted and recomputes the run", async () => {
    const s = await seed({
      checkpoints: [
        { name: "home", verdict: "unresolved", withBaseline: true },
        { name: "cart", verdict: "passed", withBaseline: true },
      ],
    });
    const home = s.shots.home!;
    const variationBefore = await variationRow(home.variationId);
    const actionId = await decide(s, "rejected", [target(s.runId, home.id)]);
    expect((await runRow(s.runId)).status).toBe("failed");

    const res = await revert(s.editor, actionId);

    expect(res).toEqual({
      actionId,
      reverted: 1,
      skipped: [],
      rediffRunIds: [],
      runs: [{ runId: s.runId, status: "unresolved" }],
    });
    expect((await decisionsOfAction(actionId))[0]!.revertedAt).not.toBeNull();
    expect(await variationRow(home.variationId)).toEqual(variationBefore);
    expect(await baselinesOfRun(s.runId)).toEqual([]);
  });

  describe("skip reasons", () => {
    test.each([
      ["a later run of the same variation", BRANCH],
      ["a sibling on another branch", "main"],
    ])("a newer capture (%s) supersedes an approve", async (_label, branch) => {
      const s = await seed({
        checkpoints: [
          { name: "home", verdict: "unresolved", withBaseline: true },
        ],
      });
      const home = s.shots.home!;
      const actionId = await decide(s, "approved", [target(s.runId, home.id)]);
      const decisions = await decisionsOfAction(actionId);

      // A newer capture of a NON-sibling (another viewport) does not count.
      await captureNow(s, { branch, viewport: "390x844" });
      expect(await assessRevert(h.db, decisions)).toEqual(
        new Map([[decisions[0]!.id, null]]),
      );

      await captureNow(s, { branch });
      const skippedBefore = await revertsMetric("skipped");
      const refusedBefore = await refusedMetric("superseded_newer_capture");

      const res = await revert(s.editor, actionId);

      expect(res).toEqual({
        actionId,
        reverted: 0,
        skipped: [
          { checkpointId: home.id, reason: "superseded_newer_capture" },
        ],
        rediffRunIds: [],
        runs: [{ runId: s.runId, status: "passed" }],
      });
      expect(await baselinesOfRun(s.runId)).toHaveLength(1);
      expect((await decisionsOfAction(actionId))[0]!.revertedAt).toBeNull();
      expect((await variationRow(home.variationId)).baselineName).toBe(
        home.imageKey,
      );
      expect(await revertsMetric("skipped")).toBe(skippedBefore + 1);
      expect(await refusedMetric("superseded_newer_capture")).toBe(
        refusedBefore + 1,
      );
      expect(await revertAudit(actionId)).toEqual([
        expect.objectContaining({
          metadata: {
            actionId,
            reverted: 0,
            skipped: [
              { checkpointId: home.id, reason: "superseded_newer_capture" },
            ],
            runIds: [s.runId],
          },
        }),
      ]);
    });

    test.each([
      ["an older run of the same variation", "same"],
      ["an older capture of a sibling on another branch", "sibling"],
    ] as const)(
      "another run re-diffed after the approve (%s) supersedes it (R24)",
      async (_label, kind) => {
        const s = await seed({
          checkpoints: [
            { name: "home", verdict: "unresolved", withBaseline: true },
          ],
        });
        // A capture taken BEFORE the approve, in another run.
        let decided: { runId: string; id: string };
        let older: string;
        if (kind === "same") {
          const r = await addReviewRun(h, s, {
            checkpoints: [{ name: "home", verdict: "unresolved" }],
          });
          decided = { runId: r.runId, id: r.shots.home!.id };
          older = s.shots.home!.id;
        } else {
          older = (await captureNow(s, { branch: "main" })).screenshotId;
          decided = { runId: s.runId, id: s.shots.home!.id };
        }
        const actionId = await decide(s, "approved", [
          target(decided.runId, decided.id),
        ]);
        const decisions = await decisionsOfAction(actionId);
        // Captured earlier and not re-diffed since: no reason to refuse.
        expect(await assessRevert(h.db, decisions)).toEqual(
          new Map([[decisions[0]!.id, null]]),
        );

        // Re-diffed while this approve's baseline was current.
        await rediffNow(older);
        const res = await revert(s.editor, actionId);

        expect(res.reverted).toBe(0);
        expect(res.skipped).toEqual([
          { checkpointId: decided.id, reason: "superseded_newer_capture" },
        ]);
        expect(res.rediffRunIds).toEqual([]);
        expect(await baselinesOfRun(decided.runId)).toHaveLength(1);
        expect((await decisionsOfAction(actionId))[0]!.revertedAt).toBeNull();
      },
    );

    test("a later approval of the variation supersedes an approve (superseded_newer_baseline)", async () => {
      const s = await seed({
        checkpoints: [
          { name: "home", verdict: "unresolved", withBaseline: true },
        ],
      });
      const r2 = await addReviewRun(h, s, {
        checkpoints: [{ name: "home", verdict: "unresolved" }],
      });
      const newer = await decide(s, "approved", [
        target(r2.runId, r2.shots.home!.id),
      ]);
      // Approving the OLDER capture afterwards makes its image the baseline
      // (ADR-068): the first approve's row is no longer the newest.
      await decide(s, "approved", [target(s.runId, s.shots.home!.id)]);

      const res = await revert(s.editor, newer);

      expect(res.reverted).toBe(0);
      expect(res.skipped).toEqual([
        {
          checkpointId: r2.shots.home!.id,
          reason: "superseded_newer_baseline",
        },
      ]);
      expect(await baselinesOfRun(r2.runId)).toHaveLength(1);
      expect((await decisionsOfAction(newer))[0]!.revertedAt).toBeNull();
      expect((await variationRow(s.shots.home!.variationId)).baselineName).toBe(
        s.shots.home!.imageKey,
      );
    });

    test("a deleted baseline row is history_expired and nothing is restored", async () => {
      const s = await seed({
        checkpoints: [
          { name: "home", verdict: "unresolved", withBaseline: true },
        ],
      });
      const home = s.shots.home!;
      const actionId = await decide(s, "approved", [target(s.runId, home.id)]);
      await h.db.delete(baselines).where(eq(baselines.testRunId, s.runId));
      const promoted = await variationRow(home.variationId);

      const res = await revert(s.editor, actionId);

      expect(res.reverted).toBe(0);
      expect(res.skipped).toEqual([
        { checkpointId: home.id, reason: "history_expired" },
      ]);
      expect(await variationRow(home.variationId)).toEqual(promoted);
      expect((await decisionsOfAction(actionId))[0]!.revertedAt).toBeNull();
    });

    test("a decision without a snapshot is not_undoable_legacy", async () => {
      const s = await seed({
        lifecycle: "passed",
        checkpoints: [
          { name: "home", verdict: "unresolved", withBaseline: true },
        ],
      });
      const home = s.shots.home!;
      const actionId = randomUUID();
      await h.db.insert(checkpointDecisions).values({
        projectId: s.projectId,
        runId: s.runId,
        screenshotId: home.id,
        actionId,
        decision: "approved",
        actorId: s.editor.id,
        source: "backfill",
        before: null,
      });
      const variationBefore = await variationRow(home.variationId);

      const res = await revert(s.editor, actionId);

      expect(res).toEqual({
        actionId,
        reverted: 0,
        skipped: [{ checkpointId: home.id, reason: "not_undoable_legacy" }],
        rediffRunIds: [],
        runs: [{ runId: s.runId, status: "passed" }],
      });
      // A refusal for any reason but already_undone is audited (R26).
      expect(await revertAudit(actionId)).toEqual([
        expect.objectContaining({
          metadata: {
            actionId,
            reverted: 0,
            skipped: [{ checkpointId: home.id, reason: "not_undoable_legacy" }],
            runIds: [s.runId],
          },
        }),
      ]);
      expect((await decisionsOfAction(actionId))[0]!.revertedAt).toBeNull();
      expect(await variationRow(home.variationId)).toEqual(variationBefore);
    });

    type Snap = {
      baseline: { op: string; id: string } | null;
      variation: Record<string, unknown> | null;
    };
    test.each<[string, (snap: Snap, otherRowId: string) => unknown]>([
      ["is not an object", () => 42],
      [
        "lacks a variation key",
        (b) => {
          const { matchLevel: _m, ...variation } = b.variation!;
          return { ...b, variation };
        },
      ],
      ["approves without a baseline", (b) => ({ ...b, baseline: null })],
      [
        "has an unparseable restore timestamp",
        (b) => ({
          ...b,
          baseline: {
            op: "updated",
            id: b.baseline!.id,
            prev: {
              baselineName: null,
              userId: null,
              branchName: BRANCH,
              createdAt: "yesterday",
              updatedAt: "2026-01-02T03:04:05.123456Z",
            },
          },
        }),
      ],
      [
        "has a non-uuid baseline id",
        (b) => ({ ...b, baseline: { op: "inserted", id: "not-a-uuid" } }),
      ],
      [
        "names the baseline row of another run",
        (b, otherRowId) => ({
          ...b,
          baseline: { op: "inserted", id: otherRowId },
        }),
      ],
    ])(
      "a snapshot that %s is history_corrupt and never half-applied",
      async (_label, corrupt) => {
        const s = await seed({
          checkpoints: [
            { name: "home", verdict: "unresolved", withBaseline: true },
          ],
        });
        const home = s.shots.home!;
        const actionId = await decide(s, "approved", [
          target(s.runId, home.id),
        ]);
        const [decision] = await decisionsOfAction(actionId);
        const [other] = await baselinesOfRun(s.baselineRunId!);
        await h.db
          .update(checkpointDecisions)
          .set({ before: corrupt(decision!.before as Snap, other!.id) })
          .where(eq(checkpointDecisions.id, decision!.id));
        const promoted = await variationRow(home.variationId);
        const ownRows = await baselinesOfRun(s.runId);

        const res = await revert(s.editor, actionId);

        expect(res.reverted).toBe(0);
        expect(res.skipped).toEqual([
          { checkpointId: home.id, reason: "history_corrupt" },
        ]);
        expect(await variationRow(home.variationId)).toEqual(promoted);
        expect(await baselinesOfRun(s.runId)).toEqual(ownRows);
        expect(await baselineById(other!.id)).toEqual(other);
        expect((await decisionsOfAction(actionId))[0]!.revertedAt).toBeNull();
      },
    );

    test("a second revert is already_undone and changes nothing", async () => {
      const s = await seed({
        checkpoints: [
          { name: "home", verdict: "unresolved", withBaseline: true },
        ],
      });
      const home = s.shots.home!;
      const actionId = await decide(s, "approved", [target(s.runId, home.id)]);
      const first = await revert(s.editor, actionId);
      expect(first.reverted).toBe(1);
      const [afterFirst] = await decisionsOfAction(actionId);
      const variationAfterFirst = await variationRow(home.variationId);

      const second = await revert(s.editor, actionId);

      // A pure no-op (every skip already_undone) writes no audit row (R26).
      expect(await revertAudit(actionId)).toHaveLength(1);
      expect(second).toEqual({
        actionId,
        reverted: 0,
        skipped: [{ checkpointId: home.id, reason: "already_undone" }],
        rediffRunIds: [],
        runs: [{ runId: s.runId, status: "unresolved" }],
      });
      expect((await decisionsOfAction(actionId))[0]).toEqual(afterFirst);
      expect(await variationRow(home.variationId)).toEqual(variationAfterFirst);
    });
  });

  describe("a variation edited since the approve (R25)", () => {
    /** The fields an approve writes onto the variation, as a row holds them. */
    const writtenFields = (v: typeof testVariations.$inferSelect) => ({
      baselineName: v.baselineName,
      matchLevel: v.matchLevel,
      ignoreRegions: v.ignoreRegions,
      layoutRegions: v.layoutRegions,
      floatingRegions: v.floatingRegions,
      contentRegions: v.contentRegions,
      accessibilityRegions: v.accessibilityRegions,
    });

    test("a reviewer's region edit since the approve refuses the undo, and the edit stays", async () => {
      const s = await seed({
        checkpoints: [
          { name: "home", verdict: "unresolved", withBaseline: true },
        ],
      });
      const home = s.shots.home!;
      const actionId = await decide(s, "approved", [target(s.runId, home.id)]);
      await clientFor(s.editor).runs.setIgnoreAreas.mutate({
        runId: s.runId,
        scope: "variation",
        checkpointId: home.id,
        ignoreAreas: [
          { x: 3, y: 4, width: 50, height: 60, viewport: VIEWPORT },
        ],
      });
      const edited = await variationRow(home.variationId);
      expect(edited.ignoreRegions).toEqual([
        expect.objectContaining({ x: 3, y: 4, width: 50, height: 60 }),
      ]);
      const refusedBefore = await refusedMetric("superseded_variation_edit");

      const res = await revert(s.editor, actionId);

      expect(res).toEqual({
        actionId,
        reverted: 0,
        skipped: [
          { checkpointId: home.id, reason: "superseded_variation_edit" },
        ],
        rediffRunIds: [],
        runs: [{ runId: s.runId, status: "passed" }],
      });
      expect(await variationRow(home.variationId)).toEqual(edited);
      expect(await baselinesOfRun(s.runId)).toHaveLength(1);
      expect((await decisionsOfAction(actionId))[0]!.revertedAt).toBeNull();
      expect(await refusedMetric("superseded_variation_edit")).toBe(
        refusedBefore + 1,
      );
    });

    test("the approve records the variation as written; untouched since (or re-saved with equal values), the undo goes through", async () => {
      const s = await seed({
        checkpoints: [
          { name: "home", verdict: "unresolved", withBaseline: true },
        ],
      });
      const home = s.shots.home!;
      const sdkRegion = {
        x: 10,
        y: 20,
        width: 30,
        height: 40,
        viewport: VIEWPORT,
      };
      await h.db
        .update(screenshots)
        .set({ ignoreRegions: [sdkRegion], matchLevel: "Layout" })
        .where(eq(screenshots.id, home.id));
      const before = await variationRow(home.variationId);
      const actionId = await decide(s, "approved", [target(s.runId, home.id)]);
      const promoted = await variationRow(home.variationId);
      const [decision] = await decisionsOfAction(actionId);
      expect(
        (decision!.before as { variationAfter?: unknown }).variationAfter,
      ).toEqual(writtenFields(promoted));

      // The same values written again, object keys in another order: equal
      // by value, so not an edit.
      const reordered = (
        promoted.ignoreRegions as Array<Record<string, unknown>>
      ).map((r) => Object.fromEntries(Object.entries(r).reverse()));
      await h.db
        .update(testVariations)
        .set({ ignoreRegions: reordered, updatedAt: new Date() })
        .where(eq(testVariations.id, home.variationId));

      const res = await revert(s.editor, actionId);

      expect(res.reverted).toBe(1);
      expect(res.skipped).toEqual([]);
      expect(stable(await variationRow(home.variationId))).toEqual(
        stable(before),
      );
    });

    test.each([
      [
        "replaces the regions",
        [{ x: 7, y: 8, width: 90, height: 100, viewport: VIEWPORT }],
      ],
      ["clears the regions", null],
    ])(
      "an approve whose reviewer-drawn ignore areas %s records them as written, and the undo restores the variation",
      async (_label, ignoreAreas) => {
        const s = await seed({
          checkpoints: [
            { name: "home", verdict: "unresolved", withBaseline: true },
          ],
        });
        const home = s.shots.home!;
        await h.db
          .update(testVariations)
          .set({
            ignoreRegions: [{ x: 1, y: 2, width: 3, height: 4 }],
            updatedAt: new Date(),
          })
          .where(eq(testVariations.id, home.variationId));
        const before = await variationRow(home.variationId);
        const actionId = randomUUID();
        await h.db.transaction((tx) =>
          decideCheckpoints(
            tx,
            {
              actor: actorOf(s.editor),
              projectId: s.projectId,
              actionId,
              source: "viewer",
              decision: "approved",
              targets: [target(s.runId, home.id)],
              ignoreAreas,
            },
            deps(),
          ),
        );

        const promoted = await variationRow(home.variationId);
        expect(promoted.ignoreRegions).toEqual(ignoreAreas);
        const [decision] = await decisionsOfAction(actionId);
        const snapshot = decision!.before as {
          variation: { ignoreRegions: unknown };
          variationAfter: { ignoreRegions: unknown };
        };
        expect(snapshot.variationAfter).toEqual(writtenFields(promoted));
        expect(snapshot.variationAfter.ignoreRegions).toEqual(ignoreAreas);
        expect(snapshot.variation.ignoreRegions).toEqual(before.ignoreRegions);

        // Untouched since: not an edit, so the undo goes through.
        const res = await revert(s.editor, actionId);

        expect(res.reverted).toBe(1);
        expect(res.skipped).toEqual([]);
        expect(stable(await variationRow(home.variationId))).toEqual(
          stable(before),
        );
      },
    );

    test("a snapshot without variationAfter (written before it existed) keeps the unchecked undo", async () => {
      const s = await seed({
        checkpoints: [
          { name: "home", verdict: "unresolved", withBaseline: true },
        ],
      });
      const home = s.shots.home!;
      const before = await variationRow(home.variationId);
      const actionId = await decide(s, "approved", [target(s.runId, home.id)]);
      await h.db
        .update(checkpointDecisions)
        .set({ before: sql`${checkpointDecisions.before} - 'variationAfter'` })
        .where(eq(checkpointDecisions.actionId, actionId));
      const [decision] = await decisionsOfAction(actionId);
      expect(decision!.before).not.toHaveProperty("variationAfter");
      // An edit the old snapshot cannot see: today's behaviour overwrites it.
      await h.db
        .update(testVariations)
        .set({ matchLevel: "Content" })
        .where(eq(testVariations.id, home.variationId));

      const res = await revert(s.editor, actionId);

      expect(res.reverted).toBe(1);
      expect(stable(await variationRow(home.variationId))).toEqual(
        stable(before),
      );
    });
  });

  describe("a re-diff after the approve", () => {
    test("one microsecond after the decision: the verdict is cleared, the run is running and is returned for re-diff", async () => {
      const s = await seed({
        checkpoints: [
          { name: "home", verdict: "unresolved", withBaseline: true },
          { name: "cart", verdict: "passed", withBaseline: true },
        ],
      });
      const home = s.shots.home!;
      const actionId = await decide(s, "approved", [target(s.runId, home.id)]);
      const [decision] = await decisionsOfAction(actionId);
      // The re-diff paired the checkpoint with its own promoted baseline. One
      // µs later is the same JS millisecond: only a SQL comparison sees it.
      await h.db
        .update(screenshots)
        .set({
          verdict: "passed",
          verdictAt: sql`(SELECT created_at + interval '1 microsecond' FROM checkpoint_decisions WHERE id = ${decision!.id})`,
        })
        .where(eq(screenshots.id, home.id));

      const res = await revert(s.editor, actionId);

      expect(res).toEqual({
        actionId,
        reverted: 1,
        skipped: [],
        rediffRunIds: [s.runId],
        runs: [{ runId: s.runId, status: "running" }],
      });
      const shot = await shotRow(home.id);
      expect(shot.verdict).toBeNull();
      expect(shot.verdictAt).toBeNull();
      expect((await shotRow(s.shots.cart!.id)).verdict).toBe("passed");
      expect((await runRow(s.runId)).status).toBe("running");
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ rediff: 1 }),
        "review_reverted",
      );
    });

    test("one microsecond before the decision: the verdict stands", async () => {
      const s = await seed({
        checkpoints: [
          { name: "home", verdict: "unresolved", withBaseline: true },
        ],
      });
      const home = s.shots.home!;
      const actionId = await decide(s, "approved", [target(s.runId, home.id)]);
      const [decision] = await decisionsOfAction(actionId);
      await h.db
        .update(screenshots)
        .set({
          verdictAt: sql`(SELECT created_at - interval '1 microsecond' FROM checkpoint_decisions WHERE id = ${decision!.id})`,
        })
        .where(eq(screenshots.id, home.id));

      const res = await revert(s.editor, actionId);

      expect(res.rediffRunIds).toEqual([]);
      expect(res.runs).toEqual([{ runId: s.runId, status: "unresolved" }]);
      expect((await shotRow(home.id)).verdict).toBe("unresolved");
    });
  });

  test("retention: a run deleted since the action is simply absent, and the rest is undone", async () => {
    const s = await seed({
      checkpoints: [
        { name: "home", verdict: "unresolved", withBaseline: true },
      ],
    });
    const r2 = await addReviewRun(h, s, {
      checkpoints: [{ name: "cart", verdict: "new" }],
    });
    const home = s.shots.home!;
    const actionId = await decide(s, "approved", [
      target(s.runId, home.id),
      target(r2.runId, r2.shots.cart!.id),
    ]);
    // Retention removes one of the action's runs; its decision cascades away.
    await h.db.delete(testRuns).where(eq(testRuns.id, r2.runId));
    expect(await decisionsOfAction(actionId)).toHaveLength(1);

    const res = await revert(s.editor, actionId);

    expect(res).toEqual({
      actionId,
      reverted: 1,
      skipped: [],
      rediffRunIds: [],
      runs: [{ runId: s.runId, status: "unresolved" }],
    });
    expect(await baselinesOfRun(s.runId)).toEqual([]);
    expect(await revertAudit(actionId)).toEqual([
      expect.objectContaining({ targetType: "run", targetId: s.runId }),
    ]);
  });

  describe("authorisation", () => {
    async function seedOwner(s: ReviewSeed) {
      const [row] = await h.db
        .insert(users)
        .values({
          email: `owner-${s.tag}@review.example`,
          hashedPassword: "!review-fixture-no-login",
          firstName: "Owner",
          lastName: `Rv${s.tag.slice(0, 6)}`,
          role: "owner",
          isActive: true,
        })
        .returning({ id: users.id });
      extraUserIds.push(row!.id);
      return { id: row!.id, role: "owner" as const };
    }

    test.each(["decider", "admin", "owner"] as const)(
      "the %s may undo",
      async (who) => {
        const s = await seed({
          checkpoints: [
            { name: "home", verdict: "unresolved", withBaseline: true },
          ],
        });
        const actionId = await decide(s, "approved", [
          target(s.runId, s.shots.home!.id),
        ]);
        const by =
          who === "decider"
            ? s.editor
            : who === "admin"
              ? s.admin
              : await seedOwner(s);

        const res = await revert(by, actionId);

        expect(res.reverted).toBe(1);
        expect((await decisionsOfAction(actionId))[0]!.revertedBy).toBe(by.id);
        expect((await revertAudit(actionId))[0]!.actorId).toBe(by.id);
      },
    );

    test("another editor is FORBIDDEN not_decider, before any lock is taken", async () => {
      const s = await seed({
        checkpoints: [
          { name: "home", verdict: "unresolved", withBaseline: true },
        ],
      });
      const home = s.shots.home!;
      const actionId = await decide(s, "approved", [target(s.runId, home.id)]);
      const promoted = await variationRow(home.variationId);

      // Another session holds the run's row lock. A refusal decided before
      // locking returns at once; one that tried to lock would hit the
      // lock_timeout (55P03) instead.
      const other = createDb();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let locked!: () => void;
      const isLocked = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const holder = other.db.transaction(async (tx) => {
        await tx
          .select({ id: testRuns.id })
          .from(testRuns)
          .where(eq(testRuns.id, s.runId))
          .for("no key update");
        locked();
        await gate;
      });
      try {
        await isLocked;
        const err = await rejection(
          h.db.transaction(async (tx) => {
            await tx.execute(sql`SET LOCAL lock_timeout = '500ms'`);
            return revertAction(
              tx,
              { actor: actorOf(s.outsider), actionId },
              deps(),
            );
          }),
        );
        expect(pgCode(err)).toBeUndefined();
        expect(refusal(err)).toEqual({
          code: "FORBIDDEN",
          message: "not_decider",
        });
      } finally {
        release();
        await holder;
        await other.close();
      }
      expect((await decisionsOfAction(actionId))[0]!.revertedAt).toBeNull();
      expect(await variationRow(home.variationId)).toEqual(promoted);
      expect(await revertAudit(actionId)).toEqual([]);
    });

    test("a legacy decision with no actor: FORBIDDEN for an editor, not_undoable_legacy for an admin", async () => {
      const s = await seed({
        lifecycle: "passed",
        checkpoints: [
          { name: "home", verdict: "unresolved", withBaseline: true },
        ],
      });
      const actionId = randomUUID();
      await h.db.insert(checkpointDecisions).values({
        projectId: s.projectId,
        runId: s.runId,
        screenshotId: s.shots.home!.id,
        actionId,
        decision: "approved",
        actorId: null,
        source: "backfill",
        before: null,
      });

      expect(refusal(await rejection(revert(s.editor, actionId)))).toEqual({
        code: "FORBIDDEN",
        message: "not_decider",
      });
      const res = await revert(s.admin, actionId);
      expect(res.reverted).toBe(0);
      expect(res.skipped).toEqual([
        { checkpointId: s.shots.home!.id, reason: "not_undoable_legacy" },
      ]);
    });

    test("an unknown action, or one outside the given project, is NOT_FOUND", async () => {
      const s = await seed({
        checkpoints: [
          { name: "home", verdict: "unresolved", withBaseline: true },
        ],
      });
      const actionId = await decide(s, "approved", [
        target(s.runId, s.shots.home!.id),
      ]);
      const elsewhere = await seed({
        checkpoints: [{ name: "home", verdict: "unresolved" }],
      });

      expect(refusal(await rejection(revert(s.admin, randomUUID())))).toEqual({
        code: "NOT_FOUND",
        message: "action_not_found",
      });
      expect(
        refusal(
          await rejection(revert(s.admin, actionId, elsewhere.projectId)),
        ),
      ).toEqual({ code: "NOT_FOUND", message: "action_not_found" });
      expect((await decisionsOfAction(actionId))[0]!.revertedAt).toBeNull();

      // The action's own project is fine.
      expect((await revert(s.editor, actionId, s.projectId)).reverted).toBe(1);
    });
  });

  test("two concurrent undos of one action: the second waits for the first's run lock, then finds it already_undone", async () => {
    const s = await seed({
      checkpoints: [
        { name: "home", verdict: "unresolved", withBaseline: true },
      ],
    });
    const home = s.shots.home!;
    const actionId = await decide(s, "approved", [target(s.runId, home.id)]);

    const a = createDb();
    const b = createDb();
    await b.db.execute(sql`select 1`);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let aReverted!: () => void;
    const aReady = new Promise<void>((resolve) => {
      aReverted = resolve;
    });
    let aPid = 0;
    const aDone = a.db.transaction(async (tx) => {
      const pid = await tx.execute<{ pid: number }>(
        sql`select pg_backend_pid() as pid`,
      );
      aPid = pid[0]!.pid;
      const res = await revertAction(
        tx,
        { actor: actorOf(s.editor), actionId },
        deps(),
      );
      aReverted();
      await gate;
      return res;
    });
    aDone.catch(() => aReverted());

    let bDone: Promise<RevertResult> = Promise.reject(new Error("unstarted"));
    bDone.catch(() => undefined);
    try {
      await aReady;
      bDone = b.db.transaction((tx) =>
        revertAction(tx, { actor: actorOf(s.editor), actionId }, deps()),
      );
      bDone.catch(() => undefined);
      expect(await waitForLockWaiter(aPid)).toBe(true);
    } finally {
      release();
    }
    const [ra, rb] = await Promise.all([aDone, bDone]);
    await a.close();
    await b.close();

    expect(ra.reverted).toBe(1);
    expect(await revertAudit(actionId)).toHaveLength(1);
    expect(rb).toEqual({
      actionId,
      reverted: 0,
      skipped: [{ checkpointId: home.id, reason: "already_undone" }],
      rediffRunIds: [],
      runs: [{ runId: s.runId, status: "unresolved" }],
    });
    expect(await baselinesOfRun(s.runId)).toEqual([]);
  }, 20_000);

  describe("atomicity against an application-level throw (R16)", () => {
    test("a JS throw after the restores leaves nothing behind even when the outer transaction commits", async () => {
      const s = await seed({
        checkpoints: [
          { name: "home", verdict: "unresolved", withBaseline: true },
          { name: "cart", verdict: "new" },
        ],
      });
      const home = s.shots.home!;
      const cart = s.shots.cart!;
      const actionId = await decide(s, "approved", [
        target(s.runId, home.id),
        target(s.runId, cart.id),
      ]);
      const homeVariation = await variationRow(home.variationId);
      const cartVariation = await variationRow(cart.variationId);
      const ownRows = await baselinesOfRun(s.runId);
      expect(ownRows).toHaveLength(2);
      const decisionsBefore = await decisionsOfAction(actionId);
      const runBefore = await runRow(s.runId);
      // Fires on the revert's first recompute: both restores and the
      // reverted_at stamps have already succeeded. No statement fails, so only
      // the revert's savepoint can undo them.
      vi.mocked(recomputeRunStatus).mockImplementationOnce(() =>
        Promise.reject(new Error("injected_after_restores")),
      );

      let caught: unknown;
      await h.db.transaction(async (tx) => {
        try {
          await revertAction(
            tx,
            { actor: actorOf(s.editor), actionId },
            deps(),
          );
        } catch (e) {
          caught = e;
        }
        // The outer transaction is still usable, and commits.
        await tx.execute(sql`select 1`);
      });

      expect((caught as Error).message).toBe("injected_after_restores");
      expect(await baselinesOfRun(s.runId)).toEqual(ownRows);
      expect(await variationRow(home.variationId)).toEqual(homeVariation);
      expect(await variationRow(cart.variationId)).toEqual(cartVariation);
      expect(await decisionsOfAction(actionId)).toEqual(decisionsBefore);
      expect(await runRow(s.runId)).toEqual(runBefore);
      expect(await revertAudit(actionId)).toEqual([]);
    });
  });

  test("isoToMicros agrees with Postgres on every restorable timestamp", async () => {
    for (const s of RESTORABLE_TIMESTAMPS) {
      const [row] = await h.db.execute<{ micros: string }>(
        sql`SELECT ((extract(epoch FROM ${s}::timestamptz) * 1000000)::bigint)::text AS micros`,
      );
      expect(isoToMicros(s), s).toBe(BigInt(row!.micros));
    }
  });

  describe("assessRevert", () => {
    test("judges a decision as part of its whole action, keyed by decision id, and writes nothing", async () => {
      const s = await seed({
        checkpoints: [
          { name: "home", verdict: "unresolved", withBaseline: true },
        ],
      });
      const r2 = await addReviewRun(h, s, {
        checkpoints: [{ name: "home", verdict: "unresolved" }],
      });
      const actionId = await decide(s, "approved", [
        target(s.runId, s.shots.home!.id),
        target(r2.runId, r2.shots.home!.id),
      ]);
      const decisions: CheckpointDecisionRow[] =
        await decisionsOfAction(actionId);
      const [first, second] = decisions;
      expect(first!.runId).toBe(s.runId);
      const variationBefore = await variationRow(s.shots.home!.variationId);

      // Alone, the first approve's row is not the newest: the action's second
      // approve wrote after it. Undoing the action reverts that one first, so
      // the first is undoable as part of it.
      expect(await assessRevert(h.db, [first!])).toEqual(
        new Map([[first!.id, null]]),
      );
      expect(await assessRevert(h.db, decisions)).toEqual(
        new Map([
          [first!.id, null],
          [second!.id, null],
        ]),
      );
      expect(await assessRevert(h.db, [])).toEqual(new Map());

      // When the later approve can't be undone, neither can the earlier one.
      await h.db
        .update(checkpointDecisions)
        .set({ before: null })
        .where(eq(checkpointDecisions.id, second!.id));
      expect(await assessRevert(h.db, [first!])).toEqual(
        new Map([[first!.id, "superseded_newer_baseline"]]),
      );

      expect(await decisionsOfAction(actionId)).toEqual(
        decisions.map((x) =>
          x.id === second!.id ? { ...x, before: null } : x,
        ),
      );
      expect(await variationRow(s.shots.home!.variationId)).toEqual(
        variationBefore,
      );
    });
  });
});
