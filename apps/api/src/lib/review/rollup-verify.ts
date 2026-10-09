import {
  and,
  asc,
  auditLog,
  eq,
  gt,
  loadRollupInputs,
  sql,
  testRuns,
  type DB,
} from "@furan/db";
import { rollupRunStatus, type RunStatus } from "@furan/shared-types";

/**
 * The read-only checks behind the `verify-review-rollup` operator CLI (spec
 * §4.6, runbook `docs/runbooks/review-model-upgrade.md`). Nothing here writes:
 * every read runs in a READ ONLY transaction.
 */

/** How many runs `findRollupMismatches` loads per batch. */
export const ROLLUP_VERIFY_BATCH_SIZE = 500;

/** A finished run whose stored status is not what the rollup computes. */
export interface RollupMismatch {
  runId: string;
  /** `test_runs.status` as stored. */
  stored: RunStatus;
  /** `rollupRunStatus` over its verdicts, active decisions and override. */
  computed: RunStatus;
}

/**
 * Every finished run (status other than `running`), optionally of one
 * project, whose stored status differs from `rollupRunStatus` over its
 * checkpoints' verdicts, their active decisions and the run's override. After
 * the `0037` backfill, and with `recomputeRunStatus` as the only writer, this
 * is empty.
 *
 * Runs are visited in ascending id order, `batchSize` at a time (keyset
 * pagination, so the cost per batch does not grow with the offset). Each
 * batch is read in one REPEATABLE READ, READ ONLY transaction, so a run's
 * status, verdicts and decisions come from the same snapshot: a review that
 * commits mid-scan cannot show up as a false mismatch.
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
          .select({ id: testRuns.id })
          .from(testRuns)
          .where(
            and(
              sql`${testRuns.status} <> 'running'`,
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
        for (const id of pageIds) {
          const input = inputs.get(id);
          // Defensive only: the page and its inputs share one snapshot, so
          // every id on the page has its inputs.
          if (!input) continue;
          const computed = rollupRunStatus(input);
          if (computed !== input.lifecycle) {
            batch.push({ runId: id, stored: input.lifecycle, computed });
          }
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
