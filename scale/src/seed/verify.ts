import {
  eq,
  recomputeRunStatus,
  sql,
  testRuns,
  type DB,
  type RunStatus,
  type Tx,
} from "@furan/db";

/**
 * The seed writes run statuses, `merge` flags and (through the counter
 * backfill) the stored pending counters in SQL; this holds them to the app's
 * one writer. It runs the real `recomputeRunStatus` on a sample of runs inside
 * a transaction that is always rolled back, so it changes nothing, and reports
 * every run it would have changed, and what.
 */

/** What `recomputeRunStatus` would rewrite on a run. */
export type DriftField = "status" | "merge" | "counters";

export interface StatusDrift {
  runId: string;
  before: RunStatus;
  after: RunStatus;
  /** Every field that moved; `status` is listed first when it did. */
  moved: DriftField[];
  /** `pending/failed` before and after (equal unless `counters` moved). */
  counters: { before: string; after: string };
}

const LISTED = 20;

function describeDrift(d: StatusDrift): string {
  const parts: string[] = [];
  if (d.moved.includes("status")) parts.push(`${d.before} -> ${d.after}`);
  if (d.moved.includes("merge")) parts.push("merge flag");
  if (d.moved.includes("counters")) {
    parts.push(`counters ${d.counters.before} -> ${d.counters.after}`);
  }
  const status = d.moved.includes("status") ? "" : ` (status ${d.before})`;
  return `${d.runId}: ${parts.join(", ")}${status}`;
}

export class SeedDriftError extends Error {
  constructor(readonly drift: StatusDrift[]) {
    const listed = drift.slice(0, LISTED).map(describeDrift).join("; ");
    const more =
      drift.length > LISTED ? `; and ${drift.length - LISTED} more` : "";
    super(
      `seed drift: recomputeRunStatus would change ${drift.length} run(s): ${listed}${more}`,
    );
    this.name = "SeedDriftError";
  }
}

/** Thrown inside the verification transaction to roll it back. */
class Rollback extends Error {}

/**
 * Up to `sample` random runs of the project, spread across its statuses: the
 * first of each status, then the second of each, and so on, so a rare status
 * (`running`, `aborted`) is checked even in a project of 200,000 passed runs.
 */
async function sampleRuns(
  db: DB,
  projectId: string,
  sample: number,
): Promise<string[]> {
  const rows = await db.execute<{ id: string }>(sql`
    select id from (
      select id, row_number() over (partition by status order by random()) as rn
      from test_runs where project_id = ${projectId}::uuid
    ) x
    order by rn, random()
    limit ${sample}`);
  return rows.map((r) => r.id);
}

/** The fields of a run that `recomputeRunStatus` writes. */
async function written(tx: Tx, runId: string) {
  const [row] = await tx
    .select({
      status: testRuns.status,
      merge: testRuns.merge,
      pendingSteps: testRuns.pendingSteps,
      failedSteps: testRuns.failedSteps,
    })
    .from(testRuns)
    .where(eq(testRuns.id, runId));
  return row!;
}

/**
 * Calls `recomputeRunStatus` on up to `sample` runs of `projectId` inside a
 * transaction it rolls back, and throws `SeedDriftError` listing every run
 * whose status, `merge` flag or stored pending counters it would change.
 */
export async function verifyStatuses(
  db: DB,
  projectId: string,
  sample = 200,
): Promise<void> {
  // Ascending id order: the lock order every multi-run caller of
  // recomputeRunStatus keeps.
  const ids = (await sampleRuns(db, projectId, sample)).sort();
  const drift: StatusDrift[] = [];
  try {
    await db.transaction(async (tx) => {
      for (const runId of ids) {
        const was = await written(tx, runId);
        const r = await recomputeRunStatus(tx, runId);
        if (r.changed) {
          const now = await written(tx, runId);
          const counters = {
            before: `${was.pendingSteps}/${was.failedSteps}`,
            after: `${now.pendingSteps}/${now.failedSteps}`,
          };
          const moved: DriftField[] = [];
          if (r.before !== r.after) moved.push("status");
          if (was.merge !== now.merge) moved.push("merge");
          if (counters.before !== counters.after) moved.push("counters");
          drift.push({
            runId,
            before: r.before,
            after: r.after,
            moved,
            counters,
          });
        }
      }
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  if (drift.length > 0) throw new SeedDriftError(drift);
}
