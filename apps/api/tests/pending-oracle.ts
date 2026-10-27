import {
  and,
  count,
  eq,
  inArray,
  screenshots,
  testRuns,
  type DB,
  type Tx,
} from "@furan/db";

import {
  pendingStepCondition,
  type StepFacets,
} from "../src/lib/review/pending.js";

/**
 * The pending steps counted from the steps themselves (`pendingStepCondition`,
 * the definition), never from the runs' stored counters: the oracle the
 * suites hold the counter-served reads (the queue, the lists, the badge, the
 * batch detail) against. The app reads the counters (spec 2026-10-27 §3), so
 * these have no production caller.
 */

/**
 * The pending steps in each of `runIds` (the project's runs only). A run with
 * no pending step is absent from the map.
 */
export async function pendingCountsByRun(
  db: DB | Tx,
  args: {
    projectId: string;
    runIds: string[];
    facets?: StepFacets | undefined;
  },
): Promise<Map<string, number>> {
  if (args.runIds.length === 0) return new Map();
  const rows = await db
    .select({ id: screenshots.runId, pending: count() })
    .from(screenshots)
    .innerJoin(testRuns, eq(testRuns.id, screenshots.runId))
    .where(
      and(
        eq(testRuns.projectId, args.projectId),
        eq(screenshots.projectId, args.projectId),
        inArray(testRuns.id, args.runIds),
        pendingStepCondition(args.facets),
      ),
    )
    .groupBy(screenshots.runId);
  return new Map(rows.map((r) => [r.id, r.pending]));
}

/**
 * The pending steps in each of `buildIds` (the project's builds' runs only). A
 * build with no pending step is absent from the map.
 */
export async function pendingCountsByBuild(
  db: DB | Tx,
  args: {
    projectId: string;
    buildIds: string[];
    facets?: StepFacets | undefined;
  },
): Promise<Map<string, number>> {
  if (args.buildIds.length === 0) return new Map();
  const rows = await db
    .select({ id: testRuns.buildId, pending: count() })
    .from(screenshots)
    .innerJoin(testRuns, eq(testRuns.id, screenshots.runId))
    .where(
      and(
        eq(testRuns.projectId, args.projectId),
        eq(screenshots.projectId, args.projectId),
        inArray(testRuns.buildId, args.buildIds),
        pendingStepCondition(args.facets),
      ),
    )
    .groupBy(testRuns.buildId);
  return new Map(rows.map((r) => [r.id, r.pending]));
}
