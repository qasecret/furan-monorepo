import { recomputeRunStatus, sql, type DB, type RunStatus } from "@furan/db";

/**
 * The seed writes run statuses in SQL; this holds them to the app's one rule.
 * It runs the real `recomputeRunStatus` on a sample of runs inside a
 * transaction that is always rolled back, so it changes nothing, and reports
 * every run it would have changed.
 */

export interface StatusDrift {
  runId: string;
  before: RunStatus;
  after: RunStatus;
  /** `merge` (a baseline exists for the run) moved, the status did not. */
  mergeOnly: boolean;
}

const LISTED = 20;

export class SeedDriftError extends Error {
  constructor(readonly drift: StatusDrift[]) {
    const listed = drift
      .slice(0, LISTED)
      .map((d) =>
        d.mergeOnly
          ? `${d.runId}: merge flag (status ${d.before})`
          : `${d.runId}: ${d.before} -> ${d.after}`,
      )
      .join("; ");
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

/**
 * Calls `recomputeRunStatus` on up to `sample` runs of `projectId` inside a
 * transaction it rolls back, and throws `SeedDriftError` listing every run
 * whose status (or `merge` flag) it would change.
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
        const r = await recomputeRunStatus(tx, runId);
        if (r.changed) {
          drift.push({
            runId,
            before: r.before,
            after: r.after,
            mergeOnly: r.before === r.after,
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
