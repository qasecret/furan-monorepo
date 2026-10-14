import {
  and,
  checkpointDecisions,
  count,
  eq,
  inArray,
  isNull,
  notExists,
  notInArray,
  screenshots,
  sql,
  testRuns,
  type DB,
  type SQL,
  type Tx,
} from "@furan/db";

import { UNREVIEWABLE_LIFECYCLE_LIST } from "./legality.js";

/**
 * The one SQL definition of a *pending* review step (spec §3.1 / §4.1), for
 * every surface that filters or counts by it: the list filters, the
 * `review.next` queue and the counts. It must select exactly what
 * `selectPendingTargets` does (the set `decideCheckpoints` accepts for
 * "approve"); `review-pending.test.ts` holds the two together.
 *
 * A step is pending when
 * - its verdict is `new` or `unresolved`,
 * - it has no active decision, and
 * - its run is reviewable (`reviewableRunCondition`).
 *
 * The conditions are over `screenshots` joined to `test_runs` on
 * `screenshots.run_id = test_runs.id`; the caller does the join and adds its
 * own explicit `project_id` filter (the queries here do).
 */

/** The environment a reviewer narrows to; each set field is an exact match. */
export interface StepFacets {
  browser?: string;
  viewport?: string;
  os?: string;
  device?: string;
}

/**
 * Equality on the `screenshots` environment columns (ADR-038) for each facet
 * that is set; `undefined` when none is, so callers can pass it straight to
 * `and(...)`.
 */
export function facetCondition(facets?: StepFacets): SQL | undefined {
  if (!facets) return undefined;
  return and(
    facets.browser === undefined
      ? undefined
      : eq(screenshots.browser, facets.browser),
    facets.viewport === undefined
      ? undefined
      : eq(screenshots.viewport, facets.viewport),
    facets.os === undefined ? undefined : eq(screenshots.os, facets.os),
    facets.device === undefined
      ? undefined
      : eq(screenshots.device, facets.device),
  );
}

/**
 * The run can be reviewed, on `test_runs` (`assessRun` in `legality.ts`, and
 * `lockBuildRuns`' selection, in SQL): its lifecycle is not `running`,
 * `aborted` or `empty`, it has no `status_override`, and none of its steps is
 * still undiffed (a NULL verdict), so one undiffed sibling makes the whole run
 * non-reviewable.
 */
export function reviewableRunCondition(): SQL {
  // The inner `screenshots` is its own scope and shadows an outer one; the
  // subquery only correlates on `test_runs.id`.
  const undiffedStep = sql`(select 1 from ${screenshots} where ${screenshots.runId} = ${testRuns.id} and ${isNull(screenshots.verdict)})`;
  return and(
    notInArray(testRuns.status, [...UNREVIEWABLE_LIFECYCLE_LIST]),
    isNull(testRuns.statusOverride),
    notExists(undiffedStep),
  )!;
}

/**
 * The step is pending. Over `screenshots` joined to `test_runs` on
 * `screenshots.run_id = test_runs.id`, with the optional environment facets
 * applied to the step.
 */
export function pendingStepCondition(facets?: StepFacets): SQL {
  const activeDecision = sql`(select 1 from ${checkpointDecisions} where ${checkpointDecisions.screenshotId} = ${screenshots.id} and ${isNull(checkpointDecisions.revertedAt)})`;
  return and(
    inArray(screenshots.verdict, ["new", "unresolved"]),
    notExists(activeDecision),
    reviewableRunCondition(),
    facetCondition(facets),
  )!;
}

/**
 * The pending steps in each of `runIds` (the project's runs only). A run with
 * no pending step is absent from the map.
 */
export async function pendingCountsByRun(
  db: DB | Tx,
  args: { projectId: string; runIds: string[]; facets?: StepFacets },
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
  args: { projectId: string; buildIds: string[]; facets?: StepFacets },
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
