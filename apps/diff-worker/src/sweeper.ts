import { and, eq, lt, testRuns } from "@furan/db";
import type { DB } from "@furan/db";

import { rollupRunStatus } from "./checkpoint-rollup.js";

export interface SweepArgs {
  db: DB;
  now?: Date;
  thresholdMs?: number;
}

export async function sweepStaleRuns({
  db,
  now = new Date(),
  thresholdMs = 5 * 60_000,
}: SweepArgs): Promise<{ finalized: number }> {
  const cutoff = new Date(now.getTime() - thresholdMs);
  const stale = await db
    .select({ id: testRuns.id })
    .from(testRuns)
    .where(and(eq(testRuns.status, "running"), lt(testRuns.updatedAt, cutoff)));

  let finalized = 0;
  for (const row of stale) {
    const { status, checkpointCount } = await rollupRunStatus(db, row.id);
    await db
      .update(testRuns)
      .set({ status, checkpointCount, completedAt: now })
      .where(eq(testRuns.id, row.id));
    finalized++;
  }
  return { finalized };
}
