import {
  and,
  asc,
  auditLog,
  computeRunCounters,
  eq,
  gt,
  loadRollupInputs,
  recomputeRunStatus,
  sql,
  testRuns,
  type DB,
  type RunCounters,
} from "@furan/db";
import { rollupRunStatus, type RunStatus } from "@furan/shared-types";

/**
 * The checks behind the `verify-review-rollup` operator CLI (spec §4.6,
 * runbook `docs/runbooks/review-model-upgrade.md`), and its
 * `--repair-counters` of the stored pending counters (spec 2026-10-27 server
 * reads §3.3). The checks never write: every read runs in a READ ONLY
 * transaction. The repair writes only through `recomputeRunStatus`, one run
 * at a time, under the run lock.
 *
 * Both run on the connection they are given, which must see every project's
 * rows: the CLI passes the OWNER connection (`DATABASE_URL`), which row-level
 * security does not apply to. Under the api's RLS-subject role with no
 * request identity the policies would hide the runs and their steps.
 */

/** How many runs `findRollupMismatches` loads per batch. */
export const ROLLUP_VERIFY_BATCH_SIZE = 500;

/**
 * A run whose stored status is not what the rollup computes, or whose stored
 * pending counters are not what their definition gives.
 */
export interface RollupMismatch {
  runId: string;
  /** `test_runs.status` as stored. */
  stored: RunStatus;
  /**
   * `rollupRunStatus` over its verdicts, active decisions and override. Only
   * a finished run's status is checked: for a run stored `running` (listed
   * for its counters alone) this is its stored status.
   */
  computed: RunStatus;
  /** `test_runs.pending_steps` / `failed_steps` as stored. */
  storedCounters: RunCounters;
  /**
   * `computeRunCounters` over the run as stored, judged by its stored status:
   * what `pendingStepCondition` counts for it (spec 2026-10-27 §3.1).
   */
  computedCounters: RunCounters;
}

/** True when the run's stored counters are what their definition gives. */
export function countersMatch(m: RollupMismatch): boolean {
  return (
    m.storedCounters.pendingSteps === m.computedCounters.pendingSteps &&
    m.storedCounters.failedSteps === m.computedCounters.failedSteps
  );
}

/**
 * Every run, optionally of one project, that is out of step with its inputs:
 * - a finished run (status other than `running`) whose stored status differs
 *   from `rollupRunStatus` over its checkpoints' verdicts, their active
 *   decisions and the run's override;
 * - any run, `running` ones included, whose stored `pending_steps` /
 *   `failed_steps` differ from `computeRunCounters` over the run as stored.
 * After the `0037` and `0043` backfills, and with `recomputeRunStatus` as the
 * only writer of both, this is empty.
 *
 * Runs are visited in ascending id order, `batchSize` at a time (keyset
 * pagination, so the cost per batch does not grow with the offset). Each
 * batch is read in one REPEATABLE READ, READ ONLY transaction, so a run's
 * status, counters, verdicts and decisions come from the same snapshot: a
 * review that commits mid-scan cannot show up as a false mismatch.
 *
 * Mismatches are returned in ascending run id order.
 */
export async function findRollupMismatches(
  db: DB,
  opts: { projectId?: string | undefined; batchSize?: number | undefined } = {},
): Promise<RollupMismatch[]> {
  const batchSize = opts.batchSize ?? ROLLUP_VERIFY_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new RangeError(`batchSize must be a positive integer: ${batchSize}`);
  }

  const mismatches: RollupMismatch[] = [];
  let after: string | null = null;
  for (;;) {
    const cursor: string | null = after;
    const { ids, found } = await db.transaction(
      async (tx): Promise<{ ids: string[]; found: RollupMismatch[] }> => {
        const page = await tx
          .select({
            id: testRuns.id,
            pendingSteps: testRuns.pendingSteps,
            failedSteps: testRuns.failedSteps,
          })
          .from(testRuns)
          .where(
            and(
              opts.projectId === undefined
                ? undefined
                : eq(testRuns.projectId, opts.projectId),
              cursor === null ? undefined : gt(testRuns.id, cursor),
            ),
          )
          .orderBy(asc(testRuns.id))
          .limit(batchSize);
        const pageIds = page.map((r) => r.id);
        const inputs = await loadRollupInputs(tx, pageIds);
        const batch: RollupMismatch[] = [];
        for (const row of page) {
          const input = inputs.get(row.id);
          // Defensive only: the page and its inputs share one snapshot, so
          // every id on the page has its inputs.
          if (!input) continue;
          const stored = input.lifecycle;
          const computed =
            stored === "running" ? stored : rollupRunStatus(input);
          const found: RollupMismatch = {
            runId: row.id,
            stored,
            computed,
            storedCounters: {
              pendingSteps: row.pendingSteps,
              failedSteps: row.failedSteps,
            },
            computedCounters: computeRunCounters(input, stored),
          };
          if (computed !== stored || !countersMatch(found)) batch.push(found);
        }
        return { ids: pageIds, found: batch };
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
    mismatches.push(...found);
    if (ids.length < batchSize) break;
    after = ids[ids.length - 1]!;
  }
  return mismatches;
}

/** What `repairRunCounters` did for one run. */
export type CounterRepairOutcome =
  /** Its counters (or `merge`) were rewritten. */
  | "repaired"
  /** Right by the time its lock was taken: a writer got there first. */
  | "already_right"
  /**
   * Left alone: its stored status is not its rollup, so recomputing would
   * change the status too. Settle the status first (review-model-upgrade.md §5).
   */
  | "status_differs"
  /** Gone since the scan (retention). */
  | "run_gone";

/** What `repairRunCounters` did for one run, and why when it left it alone. */
export interface CounterRepair {
  runId: string;
  outcome: CounterRepairOutcome;
  /**
   * With `status_differs`: the run's stored status and the status its rollup
   * computes, both read under its lock.
   */
  status?: { stored: RunStatus; rollup: RunStatus };
}

/**
 * The repair of stale pending counters (`--repair-counters`): for each run, in
 * ascending id order and each in its own transaction, takes the run lock
 * (`FOR NO KEY UPDATE`, the first lock of every write path), re-reads the
 * run's inputs and, when its stored status is its rollup, calls
 * `recomputeRunStatus`, which writes the counters from what it reads under
 * that lock. A writer that commits while the repair waits for the lock is
 * seen, never overwritten.
 *
 * It never changes a status: a run whose stored status is not its rollup
 * (for example a pre-review-model run the `0037` backfill has not filled in)
 * is left as it is (`status_differs`); recomputing it would rewrite its
 * status from incomplete data.
 *
 * Not `COUNTERS_BACKFILL_SQL`: that one statement reads one snapshot and can
 * overwrite a concurrent writer's counters under READ COMMITTED, so it is for
 * migration time only.
 *
 * `db` must see every row of the runs it names (the owner connection; see the
 * module note).
 */
export async function repairRunCounters(
  db: DB,
  runIds: readonly string[],
): Promise<CounterRepair[]> {
  const ordered = [...new Set(runIds)].sort();
  const out: CounterRepair[] = [];
  for (const runId of ordered) {
    const repair = await db.transaction(
      async (tx): Promise<Omit<CounterRepair, "runId">> => {
        const [locked] = await tx
          .select({ id: testRuns.id })
          .from(testRuns)
          .where(eq(testRuns.id, runId))
          .for("no key update");
        if (!locked) return { outcome: "run_gone" };
        // Under the lock: what a concurrent writer committed is seen here.
        const input = (await loadRollupInputs(tx, [runId])).get(runId);
        if (!input) return { outcome: "run_gone" };
        const rollup = rollupRunStatus(input);
        if (rollup !== input.lifecycle) {
          return {
            outcome: "status_differs",
            status: { stored: input.lifecycle, rollup },
          };
        }
        const { changed } = await recomputeRunStatus(tx, runId);
        return { outcome: changed ? "repaired" : "already_right" };
      },
    );
    out.push({ runId, ...repair });
  }
  return out;
}

/**
 * The CLI's line for a run `repairRunCounters` left alone (`status_differs`),
 * naming its stored status and its rollup; null for any other outcome. Both
 * statuses are printed because the check lists a `running` run (whose status
 * it does not judge) with its stored status on both sides: the rollup is what
 * says why it was not repaired.
 */
export function notRepairedLine(repair: CounterRepair): string | null {
  if (repair.outcome !== "status_differs" || repair.status === undefined) {
    return null;
  }
  const { stored, rollup } = repair.status;
  return `${repair.runId}, not repaired: stored ${stored}, rollup ${rollup} (review-model-upgrade.md §5)`;
}

/** One `baseline.repair` audit row written by migration `0036` (spec §4.4). */
export interface BaselineRepair {
  /** The audit row's id. */
  id: string;
  createdAt: Date;
  variationId: string | null;
  runId: string | null;
  branch: string | null;
  /** The variation's current baseline on the branch before the repair. */
  previousBaselineId: string | null;
  /** `inserted` | `updated`. */
  op: string | null;
}

/**
 * The `baseline.repair` audit rows (what `0036` wrote, one per baseline it
 * inserted or moved), oldest first. With `projectId`, only repairs whose
 * source run belongs to that project (a repair whose run was since deleted by
 * retention is then left out).
 */
export async function listBaselineRepairs(
  db: DB,
  opts: { projectId?: string | undefined } = {},
): Promise<BaselineRepair[]> {
  const rows = await db.transaction(
    (tx) =>
      tx
        .select({
          id: auditLog.id,
          createdAt: auditLog.createdAt,
          metadata: auditLog.metadata,
        })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.action, "baseline.repair"),
            eq(auditLog.targetType, "baseline"),
            opts.projectId === undefined
              ? undefined
              : sql`EXISTS (
                  SELECT 1 FROM ${testRuns}
                  WHERE ${testRuns.id}::text = ${auditLog.metadata}->>'runId'
                    AND ${testRuns.projectId} = ${opts.projectId}
                )`,
          ),
        )
        .orderBy(asc(auditLog.createdAt), asc(auditLog.id)),
    { accessMode: "read only" },
  );
  return rows.map((r) => {
    const m = (r.metadata ?? {}) as Record<string, unknown>;
    const text = (key: string): string | null =>
      typeof m[key] === "string" ? m[key] : null;
    return {
      id: r.id,
      createdAt: r.createdAt,
      variationId: text("variationId"),
      runId: text("runId"),
      branch: text("branch"),
      previousBaselineId: text("previousBaselineId"),
      op: text("op"),
    };
  });
}
