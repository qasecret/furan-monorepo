import { randomUUID } from "node:crypto";

import { rollupRunStatus } from "@furan/shared-types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  builds,
  checkpointDecisions,
  computeRunCounters,
  COUNTERS_BACKFILL_SQL,
  createDb,
  eq,
  inArray,
  loadRollupInputs,
  projects,
  screenshots,
  sql,
  testRuns,
  testVariations,
  type DB,
  type RunCountersInput,
  type RunStatus,
} from "./index.js";

/**
 * A run's stored pending counters (spec 2026-10-27 speed-at-scale server
 * reads §3.1): `computeRunCounters` is the definition `recomputeRunStatus`
 * writes, and migration 0043's backfill (`COUNTERS_BACKFILL_SQL`) must agree
 * with it on every run.
 *
 * The database test is skipped when `DATABASE_URL` is unset, like the other
 * integration tests here.
 */
const RUN_INTEGRATION = !!process.env.DATABASE_URL;

type Checkpoint = RunCountersInput["checkpoints"][number];

/** A checkpoint; undecided and not failed unless said otherwise. */
const cp = (
  verdict: Checkpoint["verdict"],
  over: Partial<Omit<Checkpoint, "verdict">> = {},
): Checkpoint => ({ verdict, decision: null, diffFailed: false, ...over });

/** A run's input; `lifecycle` mirrors `after` unless the case sets it. */
const input = (
  checkpoints: Checkpoint[],
  over: Partial<Omit<RunCountersInput, "checkpoints">> = {},
): RunCountersInput => ({
  lifecycle: "unresolved",
  override: null,
  checkpoints,
  ...over,
});

/** Every kind of step, on a run that is otherwise reviewable. */
const MIXED: Checkpoint[] = [
  cp("new"), // pending
  cp("unresolved"), // pending
  cp("passed"),
  cp("unresolved", { decision: "approved" }),
  cp("new", { decision: "rejected" }),
  cp("unresolved", { diffFailed: true }), // pending, failed
  cp("unresolved", { diffFailed: true, decision: "rejected" }),
  // A passed verdict is never pending, whatever its failure flag says.
  cp("passed", { diffFailed: true }),
];

describe("computeRunCounters", () => {
  const cases: Array<{
    name: string;
    input: RunCountersInput;
    after: RunStatus;
    expected: { pendingSteps: number; failedSteps: number };
  }> = [
    {
      name: "reviewable: new and unresolved undecided steps, failed ones included",
      input: input(MIXED),
      after: "unresolved",
      expected: { pendingSteps: 3, failedSteps: 1 },
    },
    {
      name: "reviewable whatever the rollup: new",
      input: input([cp("new"), cp("new")], { lifecycle: "new" }),
      after: "new",
      expected: { pendingSteps: 2, failedSteps: 0 },
    },
    {
      name: "reviewable whatever the rollup: failed (a rejection beside an open step)",
      input: input([cp("unresolved", { decision: "rejected" }), cp("new")], {
        lifecycle: "failed",
      }),
      after: "failed",
      expected: { pendingSteps: 1, failedSteps: 0 },
    },
    {
      name: "reviewable whatever the rollup: passed (every step decided or passed)",
      input: input([cp("passed"), cp("unresolved", { decision: "approved" })], {
        lifecycle: "passed",
      }),
      after: "passed",
      expected: { pendingSteps: 0, failedSteps: 0 },
    },
    {
      name: "only a failed step",
      input: input([cp("unresolved", { diffFailed: true })]),
      after: "unresolved",
      expected: { pendingSteps: 1, failedSteps: 1 },
    },
    {
      name: "no steps",
      input: input([], { lifecycle: "passed" }),
      after: "passed",
      expected: { pendingSteps: 0, failedSteps: 0 },
    },
    {
      name: "not reviewable: running",
      input: input(MIXED, { lifecycle: "running" }),
      after: "running",
      expected: { pendingSteps: 0, failedSteps: 0 },
    },
    {
      name: "not reviewable: aborted",
      input: input(MIXED, { lifecycle: "aborted" }),
      after: "aborted",
      expected: { pendingSteps: 0, failedSteps: 0 },
    },
    {
      name: "not reviewable: empty",
      input: input(MIXED, { lifecycle: "empty" }),
      after: "empty",
      expected: { pendingSteps: 0, failedSteps: 0 },
    },
    {
      name: "not reviewable: an override",
      input: input(MIXED, { override: "passed" }),
      after: "passed",
      expected: { pendingSteps: 0, failedSteps: 0 },
    },
    {
      name: "not reviewable: an undiffed step (NULL verdict)",
      input: input([...MIXED, cp(null)]),
      after: "unresolved",
      expected: { pendingSteps: 0, failedSteps: 0 },
    },
  ];

  it.each(cases)("$name", ({ input: i, after, expected }) => {
    expect(computeRunCounters(i, after)).toEqual(expected);
  });

  it("judges the run by `after`, the status being written, not the stored lifecycle", () => {
    // Stored `running` with every step diffed: the rollup writes `unresolved`,
    // so the counters written with it are the reviewable ones.
    const stale = input([cp("unresolved")], { lifecycle: "running" });
    expect(computeRunCounters(stale, "unresolved")).toEqual({
      pendingSteps: 1,
      failedSteps: 0,
    });
    // And the other way: a stored reviewable status about to become running.
    const reopened = input([cp("unresolved")], { lifecycle: "unresolved" });
    expect(computeRunCounters(reopened, "running")).toEqual({
      pendingSteps: 0,
      failedSteps: 0,
    });
  });

  it("counters are 0 while the run is overridden or has an undiffed step", () => {
    const open = [cp("new"), cp("unresolved", { diffFailed: true })];
    expect(computeRunCounters(input(open), "unresolved")).toEqual({
      pendingSteps: 2,
      failedSteps: 1,
    });
    for (const override of ["passed", "failed"] as const) {
      expect(computeRunCounters(input(open, { override }), override)).toEqual({
        pendingSteps: 0,
        failedSteps: 0,
      });
    }
    expect(
      computeRunCounters(input([...open, cp(null)]), "unresolved"),
    ).toEqual({ pendingSteps: 0, failedSteps: 0 });
    // Whatever status the caller passes, rollup or not.
    for (const after of ["new", "unresolved", "failed", "passed"] as const) {
      expect(computeRunCounters(input([...open, cp(null)]), after)).toEqual({
        pendingSteps: 0,
        failedSteps: 0,
      });
    }
  });

  it("agrees with the rollup on what keeps a run from review", () => {
    // `rollupRunStatus` returns running for an undiffed step and the override
    // for an overridden run: either way the counters are 0.
    const undiffed = input([cp("unresolved"), cp(null)]);
    expect(computeRunCounters(undiffed, rollupRunStatus(undiffed))).toEqual({
      pendingSteps: 0,
      failedSteps: 0,
    });
    const overridden = input([cp("unresolved")], { override: "failed" });
    expect(computeRunCounters(overridden, rollupRunStatus(overridden))).toEqual(
      { pendingSteps: 0, failedSteps: 0 },
    );
  });
});

describe.runIf(RUN_INTEGRATION)("COUNTERS_BACKFILL_SQL", () => {
  let db: DB;
  let close: () => Promise<void>;

  const tag = randomUUID().slice(0, 8);
  let projectId: string;
  let buildId: string;

  beforeAll(async () => {
    const created = createDb();
    db = created.db;
    close = created.close;
    const [p] = await db
      .insert(projects)
      .values({ name: `run-counters-${tag}` })
      .returning({ id: projects.id });
    projectId = p!.id;
    const [b] = await db
      .insert(builds)
      .values({ projectId, branchName: "main" })
      .returning({ id: builds.id });
    buildId = b!.id;
  });

  afterAll(async () => {
    // projects cascade to builds / runs / screenshots / variations / decisions.
    if (projectId) await db.delete(projects).where(eq(projects.id, projectId));
    await close();
  });

  interface StepSpec {
    verdict: Checkpoint["verdict"];
    diffFailed?: boolean;
    decision?: "approved" | "rejected";
    /** A decision that was undone: the step is undecided again. */
    reverted?: boolean;
  }

  /** A run with one step per spec, with its decisions; counters at 0. */
  async function seedRun(
    status: RunStatus,
    steps: StepSpec[],
    override: "passed" | "failed" | null = null,
  ): Promise<string> {
    const [r] = await db
      .insert(testRuns)
      .values({
        buildId,
        projectId,
        name: `run-${randomUUID().slice(0, 8)}`,
        status,
        statusOverride: override,
        branchName: "main",
      })
      .returning({ id: testRuns.id });
    const runId = r!.id;
    for (const [i, s] of steps.entries()) {
      const [v] = await db
        .insert(testVariations)
        .values({
          projectId,
          name: `step-${i}-${randomUUID().slice(0, 8)}`,
          branchName: "main",
        })
        .returning({ id: testVariations.id });
      const [shot] = await db
        .insert(screenshots)
        .values({
          runId,
          projectId,
          testVariationId: v!.id,
          name: `step-${i}`,
          viewport: "1280x720",
          browser: "chromium",
          imageKey: `img-${randomUUID()}`,
          verdict: s.verdict,
          verdictAt: s.verdict === null ? null : new Date(),
          diffFailedAt: s.diffFailed ? new Date() : null,
          diffError: s.diffFailed ? "engine_error" : null,
        })
        .returning({ id: screenshots.id });
      if (s.decision || s.reverted) {
        await db.insert(checkpointDecisions).values({
          projectId,
          runId,
          screenshotId: shot!.id,
          actionId: randomUUID(),
          decision: s.decision ?? "approved",
          source: "viewer",
          revertedAt: s.reverted ? new Date() : null,
        });
      }
    }
    return runId;
  }

  async function storedCounters(
    runIds: string[],
  ): Promise<Map<string, { pendingSteps: number; failedSteps: number }>> {
    const rows = await db
      .select({
        id: testRuns.id,
        pendingSteps: testRuns.pendingSteps,
        failedSteps: testRuns.failedSteps,
      })
      .from(testRuns)
      .where(inArray(testRuns.id, runIds));
    return new Map(
      rows.map((r) => [
        r.id,
        { pendingSteps: r.pendingSteps, failedSteps: r.failedSteps },
      ]),
    );
  }

  it("the backfill SQL equals computeRunCounters on a seeded mix", async () => {
    const mix: StepSpec[] = [
      { verdict: "new" },
      { verdict: "unresolved" },
      { verdict: "passed" },
      { verdict: "unresolved", decision: "approved" },
      { verdict: "new", decision: "rejected" },
      { verdict: "unresolved", reverted: true },
      { verdict: "unresolved", diffFailed: true },
      { verdict: "unresolved", diffFailed: true, decision: "rejected" },
      { verdict: "unresolved", diffFailed: true, reverted: true },
    ];
    const runIds = [
      // Reviewable, under every status the rollup can leave.
      await seedRun("unresolved", mix),
      await seedRun("new", [{ verdict: "new" }, { verdict: "new" }]),
      await seedRun("failed", [
        { verdict: "unresolved", decision: "rejected" },
        { verdict: "new" },
      ]),
      await seedRun("passed", [
        { verdict: "passed" },
        { verdict: "unresolved", decision: "approved" },
      ]),
      await seedRun("unresolved", [
        { verdict: "unresolved", diffFailed: true },
      ]),
      await seedRun("passed", []),
      // Not reviewable.
      await seedRun("running", mix),
      await seedRun("aborted", mix),
      await seedRun("empty", mix),
      await seedRun("unresolved", mix, "passed"),
      await seedRun("failed", mix, "failed"),
      await seedRun("unresolved", [...mix, { verdict: null }]),
      await seedRun("running", []),
    ];

    await db.transaction(async (tx) => {
      // Keep any statement notice off the test output.
      await tx.execute(sql`SET LOCAL client_min_messages = warning`);
      await tx.execute(sql.raw(COUNTERS_BACKFILL_SQL));
    });

    // The backfill judges a run by its stored status, so the definition is
    // evaluated with the stored status as `after`.
    const inputs = await loadRollupInputs(db, runIds);
    const stored = await storedCounters(runIds);
    const computed = new Map(
      runIds.map((id) => {
        const i = inputs.get(id)!;
        return [id, computeRunCounters(i, i.lifecycle)];
      }),
    );
    expect(stored).toEqual(computed);
    // The mix covers both kinds of run, and failed steps too.
    expect(computed.get(runIds[0]!)).toEqual({
      pendingSteps: 5,
      failedSteps: 2,
    });
    expect(
      [...computed.values()].filter((c) => c.pendingSteps === 0),
    ).toHaveLength(9);
  });
});
