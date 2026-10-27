import {
  rollupRunStatus,
  type CheckpointDecisionKind,
  type CheckpointVerdict,
  type RunStatusOverride,
} from "@furan/shared-types";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import type { DB } from "./client.js";
import { computeRunCounters, type RunCountersInput } from "./run-counters.js";
import type { RunStatus } from "./schema/enums.js";
import {
  baselines,
  checkpointDecisions,
  screenshots,
  testRuns,
} from "./schema/index.js";

/** A Drizzle transaction handle, as passed to `db.transaction(async (tx) => …)`. */
export type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];

/**
 * Loads everything `rollupRunStatus` and `computeRunCounters` need for each
 * run in `runIds`, in three queries however many runs there are: the runs
 * (lifecycle + override), their checkpoints (`screenshots.verdict` and whether
 * the step's diff failed for good, `diff_failed_at IS NOT NULL`) and their
 * **active** decisions (`reverted_at IS NULL`). Runs that don't exist are
 * absent from the map. Each value is a `RollupInput` too.
 *
 * This only reads. Callers that go on to write the result must hold the run's
 * row lock first (`recomputeRunStatus` does).
 */
export async function loadRollupInputs(
  db: DB | Tx,
  runIds: string[],
): Promise<Map<string, RunCountersInput>> {
  const inputs = new Map<string, RunCountersInput>();
  if (runIds.length === 0) return inputs;

  const runs = await db
    .select({
      id: testRuns.id,
      lifecycle: testRuns.status,
      override: testRuns.statusOverride,
    })
    .from(testRuns)
    .where(inArray(testRuns.id, runIds));
  if (runs.length === 0) return inputs;
  const foundIds = runs.map((r) => r.id);

  const shots = await db
    .select({
      id: screenshots.id,
      runId: screenshots.runId,
      verdict: screenshots.verdict,
      diffFailedAt: screenshots.diffFailedAt,
    })
    .from(screenshots)
    .where(inArray(screenshots.runId, foundIds));

  // The partial unique index guarantees at most one active decision per
  // screenshot, so this maps one-to-one.
  const active = await db
    .select({
      screenshotId: checkpointDecisions.screenshotId,
      decision: checkpointDecisions.decision,
    })
    .from(checkpointDecisions)
    .where(
      and(
        inArray(checkpointDecisions.runId, foundIds),
        isNull(checkpointDecisions.revertedAt),
      ),
    );
  const decisionByShot = new Map<string, CheckpointDecisionKind>(
    active.map((d) => [d.screenshotId, d.decision]),
  );

  const checkpointsByRun = new Map<
    string,
    Array<RunCountersInput["checkpoints"][number]>
  >(foundIds.map((id) => [id, []]));
  for (const s of shots) {
    checkpointsByRun.get(s.runId)!.push({
      verdict: s.verdict,
      decision: decisionByShot.get(s.id) ?? null,
      diffFailed: s.diffFailedAt !== null,
    });
  }

  for (const r of runs) {
    inputs.set(r.id, {
      lifecycle: r.lifecycle,
      override: r.override,
      checkpoints: checkpointsByRun.get(r.id)!,
    });
  }
  return inputs;
}

/**
 * The only writer of `test_runs.status` after a diff (spec §4.3). Recomputes
 * the run's status from its checkpoints' verdicts, their active decisions and
 * the run override via `rollupRunStatus`, and persists it together with
 * `merge` (true iff a `baselines` row exists for the run).
 *
 * It is also the one writer of the run's pending counters, `pending_steps` and
 * `failed_steps` (spec 2026-10-27 server reads §3.2): `computeRunCounters`
 * over the same inputs, judged by the status being written (`after`), since
 * that is the status `reviewableRunCondition` reads once this commits. They
 * cost no extra statement and are written in the same UPDATE as the status.
 * Every write path that changes one of their inputs (a step's verdict or
 * `diff_failed_at`, an active decision, the lifecycle status, the override,
 * or the run's steps) calls this in its transaction.
 *
 * Concurrent writers serialize on the run row: it is locked before anything is
 * read, and the lock is held until the surrounding transaction commits. A lock
 * only lives as long as its transaction, so the whole read-compute-write always
 * runs inside one. Called with a `Tx` (the normal case: the caller has just
 * written a verdict or a decision), Drizzle opens a savepoint and the
 * **caller's** transaction keeps the lock until it commits, so a decision and
 * the status that follows from it become visible together. Called with the
 * bare `DB` it is its own transaction.
 *
 * The lock is `FOR NO KEY UPDATE`, not `FOR UPDATE`. Every INSERT
 * into a table with a foreign key to `test_runs` (screenshots, diff_regions,
 * baselines, checkpoint_decisions, auto_rule_applications,
 * run_reviewer_decisions) takes `FOR KEY SHARE` on the parent run row, and
 * `FOR UPDATE` conflicts with that: two transactions that each insert a child
 * row for the same run and then recompute would wait on each other (40P01).
 * `FOR NO KEY UPDATE` is compatible with `KEY SHARE` and still conflicts with
 * itself, so recomputes serialize. This is safe because the one UPDATE below
 * touches only non-key columns.
 *
 * Caller contract:
 * - A caller that recomputes several runs in one transaction must do so in
 *   ascending `id` order (or lock the runs in that order first), or two such
 *   callers can deadlock on each other.
 * - This assumes READ COMMITTED (the Postgres default): the reads after the
 *   lock must see a writer that committed while we waited. A REPEATABLE READ
 *   or SERIALIZABLE caller gets a serialization failure (40001) instead of
 *   seeing the other writer's committed decision.
 * - `changed` is also true when only `merge` or a counter moved
 *   (`before === after`). Callers that emit a status-change event must
 *   compare `before !== after`.
 *
 * `opts.lockHeld` is for a caller that has ALREADY locked this run's row
 * `FOR NO KEY UPDATE` in the same transaction (the decision core locks its
 * runs before it decides anything): the lock is not taken again, and the
 * inputs are read in one statement ({@link loadHeldRollupState}) instead of
 * the lock, three input reads and the baseline probe. The computation and
 * the write are the same, so the status and counters written are too. It
 * runs on the caller's handle as is, with no savepoint of its own: a failure
 * aborts what the caller's transaction (or savepoint) covers. Never pass it
 * without holding the lock: the read-compute-write would then race other
 * writers.
 *
 * Nothing is written when neither `status`, `merge` nor a counter changed.
 * `updated_at` moves only with `status` or `merge`, as before the counters: a
 * decision that leaves the status as it was (one of two pending steps
 * approved) writes the counters alone. `aborted` and `empty` are lifecycle
 * states the rollup returns unchanged; this function does not "fix" them.
 *
 * @throws `run_not_found:<runId>` when the run does not exist.
 */
export async function recomputeRunStatus(
  db: DB | Tx,
  runId: string,
  opts: RecomputeOptions = {},
): Promise<RecomputeResult> {
  if (opts.lockHeld) {
    const { stored, input, hasBaseline } = await loadHeldRollupState(db, runId);
    return writeRollup(db, runId, stored, input, hasBaseline);
  }
  return db.transaction(async (tx) => {
    // 1. Lock (FOR NO KEY UPDATE; see above). Everything below runs in
    //    this transaction, after the lock.
    const [run] = await tx
      .select({
        status: testRuns.status,
        merge: testRuns.merge,
        pendingSteps: testRuns.pendingSteps,
        failedSteps: testRuns.failedSteps,
      })
      .from(testRuns)
      .where(eq(testRuns.id, runId))
      .for("no key update");
    if (!run) throw new Error(`run_not_found:${runId}`);

    // 2. Compute. Read after the lock so a writer that committed while we
    //    waited for it is visible (READ COMMITTED: each statement re-snapshots).
    const input = (await loadRollupInputs(tx, [runId])).get(runId);
    if (!input) throw new Error(`run_not_found:${runId}`);

    const [baseline] = await tx
      .select({ id: baselines.id })
      .from(baselines)
      .where(eq(baselines.testRunId, runId))
      .limit(1);

    // 3. Write, only when something moved.
    return writeRollup(tx, runId, run, input, baseline !== undefined);
  });
}

/** What {@link recomputeRunStatus} returns. */
export interface RecomputeResult {
  before: RunStatus;
  after: RunStatus;
  changed: boolean;
}

/** How {@link recomputeRunStatus} is called. */
export interface RecomputeOptions {
  /**
   * The caller already holds the run's row lock (`FOR NO KEY UPDATE`), taken
   * in this same transaction, so it is not taken again (see
   * `recomputeRunStatus`).
   */
  lockHeld?: boolean;
}

/** The run columns a recompute compares its result with. */
interface StoredRollup {
  status: RunStatus;
  merge: boolean;
  pendingSteps: number;
  failedSteps: number;
}

/**
 * The status and counters of a run from its inputs, written when something
 * moved: one UPDATE for the status, merge and both counters. `updated_at`
 * follows the status and merge only.
 */
async function writeRollup(
  db: DB | Tx,
  runId: string,
  stored: StoredRollup,
  input: RunCountersInput,
  merge: boolean,
): Promise<RecomputeResult> {
  const after = rollupRunStatus(input);
  const counters = computeRunCounters(input, after);
  const statusMoved = after !== stored.status || merge !== stored.merge;
  const changed =
    statusMoved ||
    counters.pendingSteps !== stored.pendingSteps ||
    counters.failedSteps !== stored.failedSteps;
  if (changed) {
    await db
      .update(testRuns)
      .set({
        status: after,
        merge,
        pendingSteps: counters.pendingSteps,
        failedSteps: counters.failedSteps,
        ...(statusMoved ? { updatedAt: new Date() } : {}),
      })
      .where(eq(testRuns.id, runId));
  }
  return { before: stored.status, after, changed };
}

/** One row of {@link loadHeldRollupState}'s statement. */
interface HeldRollupRow extends Record<string, unknown> {
  status: RunStatus;
  override: RunStatusOverride | null;
  merge: boolean;
  pending_steps: number;
  failed_steps: number;
  has_baseline: boolean;
  /** NULL with `n`, when the run has no steps. */
  verdict: CheckpointVerdict | null;
  decision: CheckpointDecisionKind | null;
  diff_failed: boolean | null;
  n: number | null;
}

/**
 * Everything a recompute reads, for a run whose row lock the caller holds, in
 * ONE statement: the stored columns it compares with, the lifecycle and
 * override, the run's steps (each with its verdict, its active decision and
 * whether its diff failed) and whether a `baselines` row exists for the run.
 *
 * The same facts as the lock, `loadRollupInputs` and the baseline probe: a
 * step's active decision is the one with `reverted_at IS NULL` filed under the
 * step's own run (at most one, by the partial unique index), as
 * `loadRollupInputs` keys them. Steps come grouped by (verdict, decision,
 * diff failed) with a count and are expanded back to one entry per step: the
 * rollup and the counters depend only on that multiset, and a large run sends
 * a few rows instead of one per step.
 *
 * @throws `run_not_found:<runId>` when the run does not exist.
 */
async function loadHeldRollupState(
  db: DB | Tx,
  runId: string,
): Promise<{
  stored: StoredRollup;
  input: RunCountersInput;
  hasBaseline: boolean;
}> {
  const rows = await db.execute<HeldRollupRow>(sql`
    SELECT ${testRuns.status} AS status,
           ${testRuns.statusOverride} AS override,
           ${testRuns.merge} AS merge,
           ${testRuns.pendingSteps} AS pending_steps,
           ${testRuns.failedSteps} AS failed_steps,
           EXISTS (
             SELECT 1 FROM ${baselines} WHERE ${baselines.testRunId} = ${runId}
           ) AS has_baseline,
           steps.verdict, steps.decision, steps.diff_failed, steps.n
    FROM ${testRuns}
    LEFT JOIN LATERAL (
      SELECT ${screenshots.verdict} AS verdict,
             ${checkpointDecisions.decision} AS decision,
             ${screenshots.diffFailedAt} IS NOT NULL AS diff_failed,
             count(*)::int AS n
      FROM ${screenshots}
      LEFT JOIN ${checkpointDecisions}
        ON ${checkpointDecisions.screenshotId} = ${screenshots.id}
       AND ${checkpointDecisions.runId} = ${screenshots.runId}
       AND ${checkpointDecisions.revertedAt} IS NULL
      WHERE ${screenshots.runId} = ${testRuns.id}
      GROUP BY 1, 2, 3
    ) AS steps ON true
    WHERE ${testRuns.id} = ${runId}`);
  const run = rows[0];
  if (!run) throw new Error(`run_not_found:${runId}`);
  const checkpoints: Array<RunCountersInput["checkpoints"][number]> = [];
  for (const r of rows) {
    if (r.n === null) continue;
    const step = {
      verdict: r.verdict,
      decision: r.decision,
      diffFailed: r.diff_failed === true,
    };
    for (let i = 0; i < r.n; i++) checkpoints.push(step);
  }
  return {
    stored: {
      status: run.status,
      merge: run.merge,
      pendingSteps: run.pending_steps,
      failedSteps: run.failed_steps,
    },
    input: { lifecycle: run.status, override: run.override, checkpoints },
    hasBaseline: run.has_baseline,
  };
}
