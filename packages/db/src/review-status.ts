import {
  rollupRunStatus,
  type CheckpointDecisionKind,
  type CheckpointVerdict,
  type RollupInput,
} from "@furan/shared-types";
import { and, eq, inArray, isNull } from "drizzle-orm";

import type { DB } from "./client.js";
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
 * Loads everything `rollupRunStatus` needs for each run in `runIds`, in three
 * queries however many runs there are: the runs (lifecycle + override), their
 * checkpoints (`screenshots.verdict`) and their **active** decisions
 * (`reverted_at IS NULL`). Runs that don't exist are absent from the map.
 *
 * This only reads. Callers that go on to write the result must hold the run's
 * row lock first (`recomputeRunStatus` does).
 */
export async function loadRollupInputs(
  db: DB | Tx,
  runIds: string[],
): Promise<Map<string, RollupInput>> {
  const inputs = new Map<string, RollupInput>();
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
    Array<{
      verdict: CheckpointVerdict | null;
      decision: CheckpointDecisionKind | null;
    }>
  >(foundIds.map((id) => [id, []]));
  for (const s of shots) {
    checkpointsByRun.get(s.runId)!.push({
      verdict: s.verdict,
      decision: decisionByShot.get(s.id) ?? null,
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
 * - `changed` is also true when only `merge` moved (`before === after`).
 *   Callers that emit a status-change event must compare `before !== after`.
 *
 * Nothing is written, and `updated_at` is left alone, when neither `status`
 * nor `merge` changed. `aborted` and `empty` are lifecycle states the rollup
 * returns unchanged; this function does not "fix" them.
 *
 * @throws `run_not_found:<runId>` when the run does not exist.
 */
export async function recomputeRunStatus(
  db: DB | Tx,
  runId: string,
): Promise<{ before: RunStatus; after: RunStatus; changed: boolean }> {
  return db.transaction(async (tx) => {
    // 1. Lock (FOR NO KEY UPDATE; see above). Everything below runs in
    //    this transaction, after the lock.
    const [run] = await tx
      .select({ status: testRuns.status, merge: testRuns.merge })
      .from(testRuns)
      .where(eq(testRuns.id, runId))
      .for("no key update");
    if (!run) throw new Error(`run_not_found:${runId}`);

    // 2. Compute. Read after the lock so a writer that committed while we
    //    waited for it is visible (READ COMMITTED: each statement re-snapshots).
    const input = (await loadRollupInputs(tx, [runId])).get(runId);
    if (!input) throw new Error(`run_not_found:${runId}`);
    const after = rollupRunStatus(input);

    const [baseline] = await tx
      .select({ id: baselines.id })
      .from(baselines)
      .where(eq(baselines.testRunId, runId))
      .limit(1);
    const merge = baseline !== undefined;

    // 3. Write, only when something moved.
    const changed = after !== run.status || merge !== run.merge;
    if (changed) {
      await tx
        .update(testRuns)
        .set({ status: after, merge, updatedAt: new Date() })
        .where(eq(testRuns.id, runId));
    }
    return { before: run.status, after, changed };
  });
}
