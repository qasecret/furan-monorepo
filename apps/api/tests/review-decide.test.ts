import { randomUUID } from "node:crypto";

import {
  asc,
  auditLog,
  baselines,
  checkpointDecisions,
  createDb,
  eq,
  inArray,
  sql,
  testRuns,
  testVariations,
} from "@furan/db";
import {
  decisionSnapshotSchema,
  type CheckpointDecisionKind,
  type DecisionSource,
  type ReviewErrorDetails,
  type ReviewRefusalReason,
} from "@furan/shared-types";
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

import {
  decideCheckpoints,
  selectPendingTargets,
  type DecideInput,
  type DecideResult,
} from "../src/lib/review/decide.js";
import { ReviewRefusal } from "../src/lib/review/errors.js";
import {
  assessDecision,
  type TargetFacts,
} from "../src/lib/review/legality.js";

import { createTestApp, type TestApp } from "./helpers.js";
import {
  addReviewRun,
  cleanupReviewSeeds,
  seedReviewRun,
  type ReviewRunSpec,
  type ReviewSeed,
  type ReviewUser,
} from "./review-fixtures.js";

// ---------------------------------------------------------------------------
// Legality (pure): every row of the spec §5.4 table.
// ---------------------------------------------------------------------------

const REVIEWABLE: TargetFacts = {
  lifecycle: "unresolved",
  override: null,
  allVerdictsSet: true,
  verdict: "unresolved",
  active: null,
};
const facts = (over: Partial<TargetFacts>): TargetFacts => ({
  ...REVIEWABLE,
  ...over,
});
const BOTH: CheckpointDecisionKind[] = ["approved", "rejected"];

describe("assessDecision (spec §5.4)", () => {
  test.each<
    [string, Partial<TargetFacts>, CheckpointDecisionKind, string | null]
  >([
    // Approve: reviewable, verdict ∈ {new, unresolved}, no active decision.
    ["approve a new checkpoint", { verdict: "new" }, "approved", null],
    ["approve an unresolved one", { verdict: "unresolved" }, "approved", null],
    [
      "approve a passed one",
      { verdict: "passed" },
      "approved",
      "nothing_to_approve",
    ],
    [
      "approve an approved one",
      { active: "approved" },
      "approved",
      "already_decided",
    ],
    // Reject: reviewable, verdict ∈ {new, unresolved, passed}, no active decision.
    ["reject a new checkpoint", { verdict: "new" }, "rejected", null],
    ["reject an unresolved one", { verdict: "unresolved" }, "rejected", null],
    ["reject a passed one", { verdict: "passed" }, "rejected", null],
    [
      "reject a rejected one",
      { active: "rejected" },
      "rejected",
      "already_decided",
    ],
    // Change a decision: never directly.
    [
      "approve a rejected one",
      { active: "rejected" },
      "approved",
      "already_decided",
    ],
    [
      "reject an approved one",
      { active: "approved" },
      "rejected",
      "already_decided",
    ],
    [
      "approve a passed one that was rejected",
      { verdict: "passed", active: "rejected" },
      "approved",
      "already_decided",
    ],
  ])("%s", (_label, over, decision, expected) => {
    expect(assessDecision(facts(over), decision)).toBe(expected);
  });

  test("every finished, un-overridden lifecycle is reviewable", () => {
    for (const lifecycle of [
      "new",
      "unresolved",
      "passed",
      "failed",
    ] as const) {
      for (const decision of BOTH) {
        expect(assessDecision(facts({ lifecycle }), decision)).toBeNull();
      }
    }
  });

  test("running, aborted and empty runs are not reviewable", () => {
    for (const lifecycle of ["running", "aborted", "empty"] as const) {
      for (const decision of BOTH) {
        expect(assessDecision(facts({ lifecycle }), decision)).toBe(
          "not_reviewable",
        );
        // Ahead of the per-checkpoint checks.
        expect(
          assessDecision(facts({ lifecycle, active: "approved" }), decision),
        ).toBe("not_reviewable");
        expect(
          assessDecision(facts({ lifecycle, verdict: "passed" }), decision),
        ).toBe("not_reviewable");
      }
    }
  });

  test("a run with an undiffed checkpoint is not reviewable", () => {
    for (const decision of BOTH) {
      expect(assessDecision(facts({ allVerdictsSet: false }), decision)).toBe(
        "not_reviewable",
      );
      expect(
        assessDecision(
          facts({ allVerdictsSet: false, verdict: null }),
          decision,
        ),
      ).toBe("not_reviewable");
      // Inconsistent facts still never decide an undiffed checkpoint.
      expect(assessDecision(facts({ verdict: null }), decision)).toBe(
        "not_reviewable",
      );
    }
  });

  test("an overridden run is refused as run_overridden", () => {
    for (const override of ["passed", "failed"] as const) {
      for (const decision of BOTH) {
        expect(assessDecision(facts({ override }), decision)).toBe(
          "run_overridden",
        );
        expect(
          assessDecision(facts({ override, active: "rejected" }), decision),
        ).toBe("run_overridden");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The core, against a real database.
// ---------------------------------------------------------------------------

const skip = !process.env.DATABASE_URL;
const d = skip ? describe.skip : describe;

const logger = { info: vi.fn(), error: vi.fn() };

function actorOf(u: ReviewUser): DecideInput["actor"] {
  return { id: u.id, role: u.role, via: "jwt" };
}

const target = (runId: string, screenshotId: string) => ({
  runId,
  screenshotId,
});

/** The structured refusal a review error carries. */
function refusal(err: unknown): {
  code: string;
  message: string;
  details: ReviewErrorDetails | undefined;
} {
  expect(err).toBeInstanceOf(TRPCError);
  const e = err as TRPCError;
  expect(e.cause).toBeInstanceOf(ReviewRefusal);
  return {
    code: e.code,
    message: e.message,
    details: (e.cause as ReviewRefusal).details,
  };
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

d("decideCheckpoints", () => {
  let h: TestApp;
  const seeds: ReviewSeed[] = [];

  async function seed(spec: ReviewRunSpec): Promise<ReviewSeed> {
    const s = await seedReviewRun(h, spec);
    seeds.push(s);
    return s;
  }

  function deps() {
    return { registry: h.telemetry.metrics, logger };
  }

  function decide(
    s: ReviewSeed,
    input: Pick<DecideInput, "decision" | "targets"> &
      Partial<Omit<DecideInput, "decision" | "targets">>,
  ): Promise<DecideResult> {
    return h.db.transaction((tx) =>
      decideCheckpoints(
        tx,
        {
          actor: actorOf(s.editor),
          projectId: s.projectId,
          actionId: randomUUID(),
          source: "viewer",
          ...input,
        },
        deps(),
      ),
    );
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

  const decisionsFor = (shotIds: string[]) =>
    h.db
      .select()
      .from(checkpointDecisions)
      .where(inArray(checkpointDecisions.screenshotId, shotIds))
      .orderBy(asc(checkpointDecisions.createdAt), asc(checkpointDecisions.id));

  const decisionsOfAction = (actionId: string) =>
    h.db
      .select()
      .from(checkpointDecisions)
      .where(eq(checkpointDecisions.actionId, actionId));

  const baselinesOfRun = (runId: string) =>
    h.db
      .select()
      .from(baselines)
      .where(eq(baselines.testRunId, runId))
      .orderBy(asc(baselines.createdAt), asc(baselines.id));

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

  const auditOfRun = (runId: string) =>
    h.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.targetId, runId))
      .orderBy(asc(auditLog.createdAt));

  async function decisionsMetric(
    decision: CheckpointDecisionKind,
    source: DecisionSource,
  ): Promise<number> {
    const json = await h.telemetry.metrics.getMetricsAsJSON();
    const metric = json.find((m) => m.name === "furan_review_decisions_total");
    const value = metric?.values.find(
      (v) => v.labels.decision === decision && v.labels.source === source,
    );
    return Number(value?.value ?? 0);
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
  });

  afterAll(async () => {
    await cleanupReviewSeeds(h, seeds);
    await h.close();
  });

  beforeEach(() => {
    logger.info.mockClear();
    logger.error.mockClear();
  });

  describe("approve", () => {
    test("approving 1 of 3 leaves the run unresolved and promotes only that checkpoint", async () => {
      const s = await seed({
        checkpoints: [
          { name: "home", verdict: "unresolved", withBaseline: true },
          { name: "cart", verdict: "unresolved", withBaseline: true },
          { name: "checkout", verdict: "unresolved", withBaseline: true },
        ],
      });
      const cart = s.shots.cart!;

      const res = await decide(s, {
        decision: "approved",
        targets: [target(s.runId, cart.id)],
      });

      expect(res.replayed).toBe(false);
      expect(res.decided).toEqual([
        { checkpointId: cart.id, runId: s.runId, state: "approved" },
      ]);
      expect(res.runs).toEqual([{ runId: s.runId, status: "unresolved" }]);

      const run = await runRow(s.runId);
      expect(run.status).toBe("unresolved");
      expect(run.merge).toBe(true);

      // Only the approved checkpoint's variation got a baseline row on this run.
      const rows = await baselinesOfRun(s.runId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        testVariationId: cart.variationId,
        baselineName: cart.imageKey,
        userId: s.editor.id,
        branchName: "feature/review",
      });
      expect((await variationRow(cart.variationId)).baselineName).toBe(
        cart.imageKey,
      );
      for (const name of ["home", "checkout"]) {
        expect(
          (await variationRow(s.shots[name]!.variationId)).baselineName,
        ).toBe(`baseline-${name}-${s.tag}.png`);
      }

      const [decision] = await decisionsFor([cart.id]);
      expect(decision).toMatchObject({
        projectId: s.projectId,
        runId: s.runId,
        screenshotId: cart.id,
        actionId: res.actionId,
        decision: "approved",
        actorId: s.editor.id,
        source: "viewer",
        revertedAt: null,
      });
    });

    test("approving the remaining checkpoints passes the run", async () => {
      const s = await seed({
        checkpoints: [
          { name: "home", verdict: "unresolved" },
          { name: "cart", verdict: "new" },
          { name: "about", verdict: "passed" },
        ],
      });
      await decide(s, {
        decision: "approved",
        targets: [target(s.runId, s.shots.home!.id)],
      });
      const res = await decide(s, {
        decision: "approved",
        targets: [target(s.runId, s.shots.cart!.id)],
      });
      expect(res.runs).toEqual([{ runId: s.runId, status: "passed" }]);
      expect((await runRow(s.runId)).status).toBe("passed");
    });

    test("snapshots an inserted baseline and the variation as it was before the write", async () => {
      const s = await seed({
        checkpoints: [
          { name: "home", verdict: "unresolved", withBaseline: true },
        ],
      });
      const home = s.shots.home!;
      const reviewerRegion = { x: 1, y: 2, width: 3, height: 4 };
      const layout = [{ x: 5, y: 6, width: 7, height: 8 }];
      await h.db
        .update(testVariations)
        .set({
          ignoreRegions: [reviewerRegion],
          layoutRegions: layout,
          matchLevel: "Layout",
        })
        .where(eq(testVariations.id, home.variationId));
      const before = await variationRow(home.variationId);

      await decide(s, {
        decision: "approved",
        targets: [target(s.runId, home.id)],
      });

      const [row] = await decisionsFor([home.id]);
      // Every variation key is present in the stored JSON, null included.
      expect(
        Object.keys((row!.before as { variation: object }).variation).sort(),
      ).toEqual([
        "accessibilityRegions",
        "baselineName",
        "contentRegions",
        "floatingRegions",
        "id",
        "ignoreRegions",
        "layoutRegions",
        "matchLevel",
      ]);
      const snap = decisionSnapshotSchema.parse(row!.before);
      const [inserted] = await baselinesOfRun(s.runId);
      expect(snap.baseline).toEqual({ op: "inserted", id: inserted!.id });
      expect(snap.variation).toEqual({
        id: home.variationId,
        baselineName: before.baselineName,
        matchLevel: "Layout",
        ignoreRegions: [reviewerRegion],
        layoutRegions: layout,
        floatingRegions: null,
        contentRegions: null,
        accessibilityRegions: null,
      });

      // The write itself: the checkpoint's fields, the reviewer's region kept.
      const after = await variationRow(home.variationId);
      expect(after.baselineName).toBe(home.imageKey);
      expect(after.matchLevel).toBe("Strict");
      expect(after.layoutRegions).toBeNull();
      expect(after.ignoreRegions).toEqual([reviewerRegion]);
    });

    test("snapshots an updated (variation, run) baseline row with its previous values", async () => {
      const s = await seed({
        checkpoints: [{ name: "home", verdict: "new" }],
      });
      const home = s.shots.home!;
      // A row an earlier write left for this (variation, run).
      const oldCreatedAt = "2026-01-02T03:04:05.123456Z";
      const [old] = await h.db
        .insert(baselines)
        .values({
          baselineName: "auto-old.png",
          testVariationId: home.variationId,
          testRunId: s.runId,
          branchName: "feature/review",
          createdAt: sql`${oldCreatedAt}::timestamptz`,
          updatedAt: sql`'2026-01-02T03:04:06.5Z'::timestamptz`,
        })
        .returning();

      await decide(s, {
        decision: "approved",
        targets: [target(s.runId, home.id)],
      });

      const [row] = await decisionsFor([home.id]);
      const snap = decisionSnapshotSchema.parse(row!.before);
      expect(snap.baseline).toMatchObject({
        op: "updated",
        id: old!.id,
        prev: {
          baselineName: "auto-old.png",
          userId: null,
          branchName: "feature/review",
          // Microsecond-exact: created_at orders baselines (ADR-068).
          createdAt: oldCreatedAt,
        },
      });
      const prev = (snap.baseline as { prev: { updatedAt: string } }).prev;
      expect(new Date(prev.updatedAt).toISOString()).toBe(
        "2026-01-02T03:04:06.500Z",
      );

      // Still one row for (variation, run), re-stamped and re-attributed.
      const rows = await baselinesOfRun(s.runId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).toBe(old!.id);
      expect(rows[0]!.userId).toBe(s.editor.id);
      expect(rows[0]!.baselineName).toBe(home.imageKey);
      expect(rows[0]!.createdAt.getTime()).toBeGreaterThan(
        old!.createdAt.getTime(),
      );
    });

    test("ignoreAreas replace the variation's ignore regions, for a single target only", async () => {
      const s = await seed({
        checkpoints: [
          { name: "home", verdict: "unresolved" },
          { name: "cart", verdict: "unresolved" },
        ],
      });
      const home = s.shots.home!;
      await h.db
        .update(testVariations)
        .set({ ignoreRegions: [{ x: 0, y: 0, width: 1, height: 1 }] })
        .where(eq(testVariations.id, home.variationId));
      const drawn = [{ x: 9, y: 9, width: 10, height: 10 }];

      const err = await rejection(
        decide(s, {
          decision: "approved",
          targets: [
            target(s.runId, home.id),
            target(s.runId, s.shots.cart!.id),
          ],
          ignoreAreas: drawn,
        }),
      );
      expect(refusal(err).code).toBe("BAD_REQUEST");
      expect(await decisionsFor([home.id])).toEqual([]);

      await decide(s, {
        decision: "approved",
        targets: [target(s.runId, home.id)],
        ignoreAreas: drawn,
      });
      expect((await variationRow(home.variationId)).ignoreRegions).toEqual(
        drawn,
      );
    });

    test("writes in capture order whatever the target order, across runs", async () => {
      const s = await seed({
        checkpoints: [
          { name: "a", verdict: "unresolved" },
          { name: "b", verdict: "new" },
        ],
      });
      const r2 = await addReviewRun(h, s, {
        checkpoints: [{ name: "c", verdict: "unresolved" }],
      });
      const a = s.shots.a!;
      const b = s.shots.b!;
      const c = r2.shots.c!;

      const res = await decide(s, {
        decision: "approved",
        targets: [
          target(r2.runId, c.id),
          target(s.runId, b.id),
          target(s.runId, a.id),
        ],
      });

      expect(res.decided.map((x) => x.checkpointId)).toEqual([
        a.id,
        b.id,
        c.id,
      ]);
      expect(res.decided.map((x) => x.runId)).toEqual([
        s.runId,
        s.runId,
        r2.runId,
      ]);
      expect(res.runs).toEqual(
        [
          { runId: s.runId, status: "passed" },
          { runId: r2.runId, status: "passed" },
        ].sort((x, y) => (x.runId < y.runId ? -1 : 1)),
      );
      // Decision rows and baseline rows were written in capture order.
      expect(
        (await decisionsFor([a.id, b.id, c.id])).map((x) => x.screenshotId),
      ).toEqual([a.id, b.id, c.id]);
      const written = [
        ...(await baselinesOfRun(s.runId)),
        ...(await baselinesOfRun(r2.runId)),
      ].sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime());
      expect(written.map((x) => x.testVariationId)).toEqual([
        a.variationId,
        b.variationId,
        c.variationId,
      ]);
      // One audit row per run.
      expect((await auditOfRun(s.runId)).map((x) => x.metadata)).toEqual([
        {
          actionId: res.actionId,
          source: "viewer",
          checkpointIds: [a.id, b.id],
          count: 2,
        },
      ]);
      expect((await auditOfRun(r2.runId)).map((x) => x.metadata)).toEqual([
        {
          actionId: res.actionId,
          source: "viewer",
          checkpointIds: [c.id],
          count: 1,
        },
      ]);
    });

    test("no targets decides nothing", async () => {
      const s = await seed({
        checkpoints: [{ name: "home", verdict: "unresolved" }],
      });
      const actionId = randomUUID();
      const res = await decide(s, {
        decision: "approved",
        targets: [],
        actionId,
      });
      expect(res).toEqual({
        actionId,
        decided: [],
        runs: [],
        replayed: false,
      });
      expect(await auditOfRun(s.runId)).toEqual([]);
    });
  });

  describe("reject", () => {
    test("records a decision with an empty snapshot and fails the run", async () => {
      const s = await seed({
        checkpoints: [
          { name: "home", verdict: "unresolved", withBaseline: true },
          { name: "about", verdict: "passed", withBaseline: true },
        ],
      });
      const home = s.shots.home!;
      const about = s.shots.about!;
      const homeBefore = await variationRow(home.variationId);

      const res = await decide(s, {
        decision: "rejected",
        targets: [target(s.runId, home.id), target(s.runId, about.id)],
        reason: "Logo is clipped",
      });

      expect(res.decided).toEqual([
        { checkpointId: home.id, runId: s.runId, state: "rejected" },
        { checkpointId: about.id, runId: s.runId, state: "rejected" },
      ]);
      expect(res.runs).toEqual([{ runId: s.runId, status: "failed" }]);
      const rows = await decisionsFor([home.id, about.id]);
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.before).toEqual({ baseline: null, variation: null });
        expect(row).toMatchObject({
          decision: "rejected",
          actorId: s.editor.id,
          runId: s.runId,
          projectId: s.projectId,
        });
      }
      const run = await runRow(s.runId);
      expect(run.status).toBe("failed");
      expect(run.merge).toBe(false);
      expect(await baselinesOfRun(s.runId)).toEqual([]);
      expect(await variationRow(home.variationId)).toEqual(homeBefore);

      const [audit] = await auditOfRun(s.runId);
      expect(audit).toMatchObject({
        actorId: s.editor.id,
        action: "run.reject_checkpoints",
        targetType: "run",
        targetId: s.runId,
        metadata: {
          actionId: res.actionId,
          source: "viewer",
          checkpointIds: [home.id, about.id],
          count: 2,
          reason: "Logo is clipped",
        },
      });
    });
  });

  describe("refusals", () => {
    test("refuses while a checkpoint is undiffed (not_reviewable) and writes nothing", async () => {
      // The run reads `unresolved`, but one diff is still out.
      const s = await seed({
        lifecycle: "unresolved",
        checkpoints: [
          { name: "home", verdict: "unresolved", withBaseline: true },
          { name: "cart", verdict: null },
        ],
      });
      const home = s.shots.home!;

      const err = await rejection(
        decide(s, {
          decision: "approved",
          targets: [target(s.runId, home.id)],
        }),
      );
      const r = refusal(err);
      expect(r.code).toBe("PRECONDITION_FAILED");
      expect(r.message).toBe("not_reviewable");
      expect(r.details?.reasons).toEqual([
        { checkpointId: home.id, reason: "not_reviewable" },
      ]);
      expect(await decisionsFor([home.id])).toEqual([]);
      expect(await baselinesOfRun(s.runId)).toEqual([]);
      expect((await runRow(s.runId)).status).toBe("unresolved");
    });

    test("one illegal target refuses the whole call", async () => {
      const s = await seed({
        checkpoints: [
          { name: "home", verdict: "unresolved" },
          { name: "about", verdict: "passed" },
        ],
      });
      const home = s.shots.home!;
      const about = s.shots.about!;
      const before = await decisionsMetric("approved", "viewer");

      const r = refusal(
        await rejection(
          decide(s, {
            decision: "approved",
            targets: [target(s.runId, home.id), target(s.runId, about.id)],
          }),
        ),
      );
      expect(r.code).toBe("PRECONDITION_FAILED");
      expect(r.message).toBe("nothing_to_approve");
      expect(r.details?.reasons).toEqual([
        { checkpointId: about.id, reason: "nothing_to_approve" },
      ]);
      expect(await decisionsFor([home.id, about.id])).toEqual([]);
      expect(await baselinesOfRun(s.runId)).toEqual([]);
      expect(await auditOfRun(s.runId)).toEqual([]);
      expect(await decisionsMetric("approved", "viewer")).toBe(before);
    });

    test("an overridden run is refused as run_overridden", async () => {
      const s = await seed({
        override: "failed",
        checkpoints: [{ name: "home", verdict: "unresolved" }],
      });
      const r = refusal(
        await rejection(
          decide(s, {
            decision: "rejected",
            targets: [target(s.runId, s.shots.home!.id)],
          }),
        ),
      );
      expect(r.code).toBe("PRECONDITION_FAILED");
      expect(r.message).toBe("run_overridden");
    });

    test("an aborted run is not reviewable", async () => {
      const s = await seed({
        lifecycle: "aborted",
        checkpoints: [{ name: "home", verdict: "unresolved" }],
      });
      const r = refusal(
        await rejection(
          decide(s, {
            decision: "approved",
            targets: [target(s.runId, s.shots.home!.id)],
          }),
        ),
      );
      expect(r.code).toBe("PRECONDITION_FAILED");
      expect(r.details?.reasons).toEqual([
        { checkpointId: s.shots.home!.id, reason: "not_reviewable" },
      ]);
    });

    test("a checkpoint of another run is refused as not_in_run", async () => {
      const s = await seed({
        checkpoints: [{ name: "home", verdict: "unresolved" }],
      });
      const r2 = await addReviewRun(h, s, {
        checkpoints: [{ name: "other", verdict: "unresolved" }],
      });
      const r = refusal(
        await rejection(
          decide(s, {
            decision: "approved",
            targets: [target(s.runId, r2.shots.other!.id)],
          }),
        ),
      );
      expect(r.code).toBe("PRECONDITION_FAILED");
      expect(r.message).toBe("not_in_run");
      expect(r.details?.reasons).toEqual([
        { checkpointId: r2.shots.other!.id, reason: "not_in_run" },
      ]);
    });

    test("a run of another project is NOT_FOUND", async () => {
      const s = await seed({
        checkpoints: [{ name: "home", verdict: "unresolved" }],
      });
      const other = await seed({
        checkpoints: [{ name: "home", verdict: "unresolved" }],
      });
      const r = refusal(
        await rejection(
          decide(s, {
            decision: "approved",
            targets: [target(other.runId, other.shots.home!.id)],
          }),
        ),
      );
      expect(r.code).toBe("NOT_FOUND");
      expect(await decisionsFor([other.shots.home!.id])).toEqual([]);
    });

    test("an already decided checkpoint is a CONFLICT naming the winner", async () => {
      const s = await seed({
        checkpoints: [
          { name: "home", verdict: "unresolved" },
          { name: "about", verdict: "passed" },
        ],
      });
      const home = s.shots.home!;
      const about = s.shots.about!;
      await decide(s, {
        decision: "approved",
        targets: [target(s.runId, home.id)],
      });

      // Changing a decision is never direct, and already_decided outranks the
      // other refusals in the same call.
      const r = refusal(
        await rejection(
          decide(s, {
            actor: actorOf(s.admin),
            decision: "approved",
            targets: [target(s.runId, about.id), target(s.runId, home.id)],
          }),
        ),
      );
      expect(r.code).toBe("CONFLICT");
      expect(r.message).toBe("already_decided");
      expect(r.details?.winner).toEqual({
        checkpointId: home.id,
        kind: "approved",
        actorName: s.editor.name,
      });
      expect(r.details?.reasons).toEqual<
        Array<{ checkpointId: string; reason: ReviewRefusalReason }>
      >([
        { checkpointId: about.id, reason: "nothing_to_approve" },
        { checkpointId: home.id, reason: "already_decided" },
      ]);
    });
  });

  describe("idempotency", () => {
    test("the same actionId twice replays the stored result", async () => {
      const s = await seed({
        checkpoints: [
          { name: "home", verdict: "unresolved" },
          { name: "cart", verdict: "unresolved" },
        ],
      });
      const targets = [
        target(s.runId, s.shots.home!.id),
        target(s.runId, s.shots.cart!.id),
      ];
      const actionId = randomUUID();

      const first = await decide(s, {
        decision: "approved",
        actionId,
        targets,
      });
      const auditCount = (await auditOfRun(s.runId)).length;
      const metric = await decisionsMetric("approved", "viewer");

      const second = await decide(s, {
        decision: "approved",
        actionId,
        targets,
      });

      expect(first.replayed).toBe(false);
      expect(second).toEqual({ ...first, replayed: true });
      expect(await decisionsOfAction(actionId)).toHaveLength(2);
      expect((await auditOfRun(s.runId)).length).toBe(auditCount);
      expect(await decisionsMetric("approved", "viewer")).toBe(metric);
    });

    test("a retry that finds nothing left to decide still replays the stored result", async () => {
      // An implicit selection ("approve all pending", the build drain, the
      // SDK's saveNewTests) re-run after its original committed selects no
      // targets: the retry must still report what the action did.
      const s = await seed({
        checkpoints: [
          { name: "home", verdict: "unresolved" },
          { name: "cart", verdict: "new" },
        ],
      });
      const actionId = randomUUID();
      const first = await decide(s, {
        decision: "approved",
        actionId,
        targets: [
          target(s.runId, s.shots.home!.id),
          target(s.runId, s.shots.cart!.id),
        ],
      });
      const auditCount = (await auditOfRun(s.runId)).length;
      const metric = await decisionsMetric("approved", "viewer");

      const retry = await decide(s, {
        decision: "approved",
        actionId,
        targets: [],
      });

      expect(first.decided).toHaveLength(2);
      expect(retry).toEqual({ ...first, replayed: true });
      expect(await decisionsOfAction(actionId)).toHaveLength(2);
      expect((await auditOfRun(s.runId)).length).toBe(auditCount);
      expect(await decisionsMetric("approved", "viewer")).toBe(metric);
    });
  });

  describe("audit, metrics and logs", () => {
    test("one audit row per run, one metric count per checkpoint, one log line", async () => {
      const s = await seed({
        checkpoints: [
          { name: "home", verdict: "unresolved" },
          { name: "cart", verdict: "new" },
        ],
      });
      const home = s.shots.home!;
      const cart = s.shots.cart!;
      const approvedBefore = await decisionsMetric("approved", "viewer");

      const res = await decide(s, {
        decision: "approved",
        targets: [target(s.runId, home.id), target(s.runId, cart.id)],
      });

      expect(await decisionsMetric("approved", "viewer")).toBe(
        approvedBefore + 2,
      );
      const audit = await auditOfRun(s.runId);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        actorId: s.editor.id,
        action: "run.approve_checkpoints",
        targetType: "run",
        targetId: s.runId,
        metadata: {
          actionId: res.actionId,
          source: "viewer",
          checkpointIds: [home.id, cart.id],
          count: 2,
        },
      });
      expect(logger.info).toHaveBeenCalledWith(
        {
          project_id: s.projectId,
          run_ids: [s.runId],
          actor_id: s.editor.id,
          action_id: res.actionId,
          decision: "approved",
          source: "viewer",
          count: 2,
        },
        "review_decided",
      );
    });

    test("counts by source, and caps the audited checkpoint ids at 50", async () => {
      const checkpoints = Array.from({ length: 51 }, (_, i) => ({
        name: `step-${String(i).padStart(2, "0")}`,
        verdict: "unresolved" as const,
      }));
      const s = await seed({ checkpoints });
      const ordered = checkpoints.map((c) => s.shots[c.name]!.id);
      const before = await decisionsMetric("rejected", "batch");

      await decide(s, {
        decision: "rejected",
        source: "batch",
        targets: ordered.map((id) => target(s.runId, id)),
      });

      expect(await decisionsMetric("rejected", "batch")).toBe(before + 51);
      const [audit] = await auditOfRun(s.runId);
      const metadata = audit!.metadata as {
        checkpointIds: string[];
        count: number;
      };
      expect(metadata.count).toBe(51);
      expect(metadata.checkpointIds).toEqual(ordered.slice(0, 50));
    });
  });

  describe("concurrency and atomicity", () => {
    test("two concurrent actions on one checkpoint: one result, one CONFLICT already_decided", async () => {
      const s = await seed({
        checkpoints: [
          { name: "home", verdict: "unresolved", withBaseline: true },
        ],
      });
      const home = s.shots.home!;
      const input = (actor: ReviewUser): DecideInput => ({
        actor: actorOf(actor),
        projectId: s.projectId,
        actionId: randomUUID(),
        source: "viewer",
        decision: "approved",
        targets: [target(s.runId, home.id)],
      });

      const a = createDb();
      const b = createDb();
      await b.db.execute(sql`select 1`);

      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let aDecided!: () => void;
      const aReady = new Promise<void>((resolve) => {
        aDecided = resolve;
      });

      let aPid = 0;
      // A decides, then holds its transaction (and its locks) open.
      const aDone = a.db.transaction(async (tx) => {
        const pid = await tx.execute<{ pid: number }>(
          sql`select pg_backend_pid() as pid`,
        );
        aPid = pid[0]!.pid;
        const res = await decideCheckpoints(tx, input(s.editor), deps());
        aDecided();
        await gate;
        return res;
      });
      aDone.catch(() => aDecided());

      let bDone: Promise<unknown> = Promise.resolve();
      try {
        await aReady;
        bDone = b.db.transaction((tx) =>
          decideCheckpoints(tx, input(s.admin), deps()),
        );
        // Do not let B's eventual rejection go unhandled while we wait.
        bDone.catch(() => undefined);
        expect(await waitForLockWaiter(aPid)).toBe(true);

        release();
        const [ra, rb] = await Promise.allSettled([aDone, bDone]);
        expect(ra.status).toBe("fulfilled");
        expect(rb.status).toBe("rejected");
        const r = refusal((rb as PromiseRejectedResult).reason);
        expect(r.code).toBe("CONFLICT");
        expect(r.message).toBe("already_decided");
        expect(r.details?.winner).toEqual({
          checkpointId: home.id,
          kind: "approved",
          actorName: s.editor.name,
        });
      } finally {
        release();
        await Promise.allSettled([aDone, bDone]);
        await a.close();
        await b.close();
      }

      const rows = await decisionsFor([home.id]);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.actorId).toBe(s.editor.id);
    }, 20_000);

    test("a concurrent retry of the same action replays it (idempotency is checked under the locks)", async () => {
      const s = await seed({
        checkpoints: [{ name: "home", verdict: "unresolved" }],
      });
      const home = s.shots.home!;
      const input: DecideInput = {
        actor: actorOf(s.editor),
        projectId: s.projectId,
        actionId: randomUUID(),
        source: "viewer",
        decision: "approved",
        targets: [target(s.runId, home.id)],
      };

      const a = createDb();
      const b = createDb();
      await b.db.execute(sql`select 1`);

      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let aDecided!: () => void;
      const aReady = new Promise<void>((resolve) => {
        aDecided = resolve;
      });

      let aPid = 0;
      const aDone = a.db.transaction(async (tx) => {
        const pid = await tx.execute<{ pid: number }>(
          sql`select pg_backend_pid() as pid`,
        );
        aPid = pid[0]!.pid;
        const res = await decideCheckpoints(tx, input, deps());
        aDecided();
        await gate;
        return res;
      });
      aDone.catch(() => aDecided());

      let bDone: Promise<DecideResult | undefined> = Promise.resolve(undefined);
      try {
        await aReady;
        // The retry arrives while the original is still uncommitted.
        bDone = b.db.transaction((tx) => decideCheckpoints(tx, input, deps()));
        bDone.catch(() => undefined);
        expect(await waitForLockWaiter(aPid)).toBe(true);

        release();
        const original = await aDone;
        const retry = await bDone;
        expect(original.replayed).toBe(false);
        expect(retry).toEqual({ ...original, replayed: true });
      } finally {
        release();
        await Promise.allSettled([aDone, bDone]);
        await a.close();
        await b.close();
      }
      expect(await decisionsOfAction(input.actionId)).toHaveLength(1);
    }, 20_000);

    test("a unique violation from a concurrent writer maps to CONFLICT already_decided and rolls back the promotion", async () => {
      const s = await seed({
        checkpoints: [
          { name: "home", verdict: "unresolved", withBaseline: true },
        ],
      });
      const home = s.shots.home!;
      const variationBefore = await variationRow(home.variationId);

      const a = createDb();
      const b = createDb();
      await b.db.execute(sql`select 1`);

      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let aInserted!: () => void;
      const aReady = new Promise<void>((resolve) => {
        aInserted = resolve;
      });

      let aPid = 0;
      // A writer that skips the run lock, holding an uncommitted decision.
      const aDone = a.db.transaction(async (tx) => {
        const pid = await tx.execute<{ pid: number }>(
          sql`select pg_backend_pid() as pid`,
        );
        aPid = pid[0]!.pid;
        await tx.insert(checkpointDecisions).values({
          projectId: s.projectId,
          runId: s.runId,
          screenshotId: home.id,
          actionId: randomUUID(),
          decision: "approved",
          actorId: s.admin.id,
          source: "inbox",
        });
        aInserted();
        await gate;
      });
      aDone.catch(() => aInserted());

      let caught: unknown;
      let bDone: Promise<unknown> = Promise.resolve();
      try {
        await aReady;
        // B's outer transaction COMMITS whatever the core leaves behind.
        bDone = b.db.transaction(async (tx) => {
          try {
            await decideCheckpoints(
              tx,
              {
                actor: actorOf(s.editor),
                projectId: s.projectId,
                actionId: randomUUID(),
                source: "viewer",
                decision: "approved",
                targets: [target(s.runId, home.id)],
              },
              deps(),
            );
          } catch (e) {
            caught = e;
          }
        });
        bDone.catch(() => undefined);
        // B promoted, then waits on A's unique-index entry.
        expect(await waitForLockWaiter(aPid)).toBe(true);

        release();
        await aDone;
        await bDone;
      } finally {
        release();
        await Promise.allSettled([aDone, bDone]);
        await a.close();
        await b.close();
      }

      const r = refusal(caught);
      expect(r.code).toBe("CONFLICT");
      expect(r.message).toBe("already_decided");
      expect(r.details?.winner).toEqual({
        checkpointId: home.id,
        kind: "approved",
        actorName: s.admin.name,
      });
      // B's promotion did not survive its commit.
      expect(await baselinesOfRun(s.runId)).toEqual([]);
      expect(await variationRow(home.variationId)).toEqual(variationBefore);
      const rows = await decisionsFor([home.id]);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.actorId).toBe(s.admin.id);
    }, 20_000);

    test("the write phase is atomic: a failure after promotion leaves nothing even when the outer transaction commits (R16)", async () => {
      const s = await seed({
        checkpoints: [
          { name: "home", verdict: "unresolved", withBaseline: true },
          { name: "cart", verdict: "new" },
        ],
      });
      const home = s.shots.home!;
      const cart = s.shots.cart!;
      const homeBefore = await variationRow(home.variationId);
      const cartBefore = await variationRow(cart.variationId);
      const runBefore = await runRow(s.runId);

      let caught: unknown;
      await h.db.transaction(async (tx) => {
        try {
          // The decision insert fails the source CHECK, after both promotions.
          await decideCheckpoints(
            tx,
            {
              actor: actorOf(s.editor),
              projectId: s.projectId,
              actionId: randomUUID(),
              source: "not-a-source" as DecisionSource,
              decision: "approved",
              targets: [target(s.runId, home.id), target(s.runId, cart.id)],
            },
            deps(),
          );
        } catch (e) {
          caught = e;
        }
        // The outer transaction is still usable, and commits.
        await tx.execute(sql`select 1`);
      });

      expect(pgCode(caught)).toBe("23514");
      expect(await baselinesOfRun(s.runId)).toEqual([]);
      expect(await variationRow(home.variationId)).toEqual(homeBefore);
      expect(await variationRow(cart.variationId)).toEqual(cartBefore);
      expect(await decisionsFor([home.id, cart.id])).toEqual([]);
      expect(await runRow(s.runId)).toEqual(runBefore);
      expect(await auditOfRun(s.runId)).toEqual([]);
    });
  });

  describe("selectPendingTargets", () => {
    const select = (
      scope: { runId: string } | { buildId: string },
      cap: number,
    ) => h.db.transaction((tx) => selectPendingTargets(tx, scope, cap));

    test("skips rejected and machine-passed checkpoints, in capture order", async () => {
      const s = await seed({
        checkpoints: [
          { name: "a", verdict: "new" },
          { name: "b", verdict: "unresolved" },
          { name: "c", verdict: "passed" },
          { name: "d", verdict: "unresolved" },
        ],
      });
      await decide(s, {
        decision: "rejected",
        targets: [target(s.runId, s.shots.b!.id)],
      });

      const res = await select({ runId: s.runId }, 10);
      expect(res.targets).toEqual([
        target(s.runId, s.shots.a!.id),
        target(s.runId, s.shots.d!.id),
      ]);
      expect(res.preview).toEqual({
        pendingCheckpoints: 2,
        tests: 1,
        rejectedLeftAsIs: 1,
        notReviewableTests: 0,
        capped: false,
        cap: 10,
      });

      const capped = await select({ runId: s.runId }, 1);
      expect(capped.targets).toEqual([target(s.runId, s.shots.a!.id)]);
      expect(capped.preview).toMatchObject({
        pendingCheckpoints: 2,
        capped: true,
        cap: 1,
      });
    });

    test("a build spans its runs in capture order and skips the ones that are not reviewable", async () => {
      const s = await seed({
        checkpoints: [
          { name: "a", verdict: "unresolved" },
          { name: "b", verdict: "new" },
        ],
      });
      const r2 = await addReviewRun(h, s, {
        checkpoints: [{ name: "c", verdict: "unresolved" }],
      });
      // Still diffing.
      await addReviewRun(h, s, {
        checkpoints: [{ name: "d", verdict: null }],
      });
      // Force-failed.
      await addReviewRun(h, s, {
        override: "failed",
        checkpoints: [{ name: "e", verdict: "unresolved" }],
      });
      // Already approved.
      const r5 = await addReviewRun(h, s, {
        checkpoints: [{ name: "f", verdict: "unresolved" }],
      });
      await decide(s, {
        decision: "approved",
        targets: [target(r5.runId, r5.shots.f!.id)],
      });

      const all = await select({ buildId: s.buildId }, 10);
      expect(all.targets).toEqual([
        target(s.runId, s.shots.a!.id),
        target(s.runId, s.shots.b!.id),
        target(r2.runId, r2.shots.c!.id),
      ]);
      expect(all.preview).toEqual({
        pendingCheckpoints: 3,
        tests: 2,
        rejectedLeftAsIs: 0,
        notReviewableTests: 2,
        capped: false,
        cap: 10,
      });

      const firstTwo = await select({ buildId: s.buildId }, 2);
      expect(firstTwo.targets).toEqual([
        target(s.runId, s.shots.a!.id),
        target(s.runId, s.shots.b!.id),
      ]);
      expect(firstTwo.preview).toMatchObject({
        pendingCheckpoints: 3,
        tests: 2,
        capped: true,
        cap: 2,
      });
    });

    test("every selected target is accepted by decideCheckpoints", async () => {
      const s = await seed({
        checkpoints: [
          { name: "a", verdict: "unresolved" },
          { name: "b", verdict: "passed" },
          { name: "c", verdict: "new" },
        ],
      });
      const { targets } = await select({ buildId: s.buildId }, 10);
      const res = await decide(s, { decision: "approved", targets });
      expect(res.runs).toEqual([{ runId: s.runId, status: "passed" }]);
      expect((await select({ buildId: s.buildId }, 10)).targets).toEqual([]);
    });
  });
});
