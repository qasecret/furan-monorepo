import { diffRegions, eq, screenshots, sql } from "@furan/db";
import type { DB } from "@furan/db";
import type { RunStatus } from "@furan/db";

/**
 * Rolls up per-checkpoint diff results into a single run status.
 *
 * v1.1.0 limitation: per-checkpoint status is derived from diff_regions
 * presence (zero rows with non-none severity ⇒ passed; any ⇒ unresolved).
 * The proper per-checkpoint diff_outcome column lands in a Phase 6
 * follow-up.
 */
export async function rollupRunStatus(
  db: DB,
  runId: string,
): Promise<{ status: RunStatus; checkpointCount: number }> {
  const rows = await db
    .select({ id: screenshots.id })
    .from(screenshots)
    .where(eq(screenshots.runId, runId));
  const checkpointCount = rows.length;
  if (checkpointCount === 0) {
    return { status: "empty", checkpointCount: 0 };
  }

  const unresolvedRows = await db
    .select({ id: diffRegions.id })
    .from(diffRegions)
    .where(
      sql`${diffRegions.runId} = ${runId} AND ${diffRegions.severity} != 'none'`,
    )
    .limit(1);

  if (unresolvedRows.length > 0) {
    return { status: "unresolved", checkpointCount };
  }
  return { status: "passed", checkpointCount };
}
