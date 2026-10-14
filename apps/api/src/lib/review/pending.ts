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
 * "No active decision" is the `NOT EXISTS` on `checkpoint_decisions`, with
 * `NOT screenshots.has_active_decision` beside it as a pre-filter (ADR-074):
 * a decided step keeps its verdict, so without the flag every pending scan
 * would probe the decisions of the project's whole history.
 *
 * The conditions are over `screenshots` joined to `test_runs` on
 * `screenshots.run_id = test_runs.id`; the caller does the join and adds its
 * own explicit `project_id` filter (the queries here do).
 *
 * They reference the **unaliased** `"screenshots"` and `"test_runs"` tables by
 * name. A caller must therefore embed them in a fresh `EXISTS` subquery over
 * those tables (`... from screenshots join test_runs ...`), never against an
 * aliased `test_runs` (e.g. `test_runs r`), where `"test_runs"` would not
 * resolve (or would silently bind to another scope's `test_runs`). Raw-SQL
 * callers (the build-level queue and counts) depend on this.
 */

/**
 * The environment a reviewer narrows to; each set field is an exact match and
 * an unset (or explicitly `undefined`) one is no filter. The fields accept
 * `undefined` so zod-optional inputs can be passed in as they are under
 * `exactOptionalPropertyTypes`.
 */
export interface StepFacets {
  browser?: string | undefined;
  viewport?: string | undefined;
  os?: string | undefined;
  device?: string | undefined;
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
    // ADR-074: a pre-filter the partial index `screenshots_pending_open_idx`
    // can serve (a literal, not a bound parameter, so its predicate is
    // provably implied). The trigger on `checkpoint_decisions` keeps the flag
    // exact, but correctness never rests on it: the `NOT EXISTS` below stays
    // the definition, so a flag left false would still be filtered there.
    sql`not ${screenshots.hasActiveDecision}`,
    notExists(activeDecision),
    reviewableRunCondition(),
    facetCondition(facets),
  )!;
}

/**
 * The build has at least one pending step inside `facets`, other than
 * `exceptStepId` when given (the step a reviewer is deciding). `buildId` is
 * the enclosing query's build id: `sql\`b.id\`` in a raw query over
 * `builds b`, or `sql\`${builds.id}\`` in the `where` of a drizzle select
 * from `builds` (drizzle prints a one-table select's own columns bare in its
 * select list, so keep this condition out of that list).
 *
 * The step conditions reference the unaliased `screenshots` / `test_runs`, so
 * they go in a fresh EXISTS over those tables; the only link to the enclosing
 * query is `buildId`.
 */
export function buildHasPendingStep(
  projectId: string,
  buildId: SQL,
  opts: {
    facets?: StepFacets | undefined;
    exceptStepId?: string | undefined;
  } = {},
): SQL {
  const except =
    opts.exceptStepId === undefined
      ? sql``
      : sql`and ${screenshots.id} <> ${opts.exceptStepId}`;
  return sql`exists (
    select 1 from ${testRuns}
    join ${screenshots} on ${screenshots.runId} = ${testRuns.id}
    where ${testRuns.buildId} = ${buildId}
      and ${testRuns.projectId} = ${projectId}
      and ${screenshots.projectId} = ${projectId}
      and ${pendingStepCondition(opts.facets)}
      ${except}
  )`;
}

/**
 * The number of the build's pending steps inside `facets`, as a scalar
 * subquery: `buildId` is the enclosing query's build id, as for
 * `buildHasPendingStep`. A query that picks a build (`LIMIT 1`) and wants its
 * count in the same statement computes this over the picked row only, so pick
 * the build in a subquery and select this from it.
 *
 * Every column sits inside a nested fragment, so it keeps its table name even
 * in the select list of a drizzle one-table select (which prints a direct
 * column chunk of a select-list expression bare).
 */
export function buildPendingCount(
  projectId: string,
  buildId: SQL,
  facets?: StepFacets | undefined,
): SQL<number> {
  const joined = sql`${screenshots.runId} = ${testRuns.id}`;
  const inBuild = and(
    sql`${testRuns.buildId} = ${buildId}`,
    eq(testRuns.projectId, projectId),
    eq(screenshots.projectId, projectId),
    pendingStepCondition(facets),
  );
  return sql<number>`(select count(*) from ${testRuns} join ${screenshots} on ${joined} where ${inBuild})`.mapWith(
    Number,
  );
}

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

/** One value of an environment dimension in a batch, with its pending steps. */
export interface FacetValue {
  value: string;
  /** The batch's pending steps (`pendingStepCondition`) that have this value. */
  pending: number;
}

/** The values of each environment dimension (ADR-038) a batch has steps in. */
export interface BatchFacets {
  browser: FacetValue[];
  viewport: FacetValue[];
  os: FacetValue[];
  device: FacetValue[];
}

/** The `screenshots` column behind each dimension. */
const FACET_DIMENSIONS = [
  ["browser", screenshots.browser],
  ["viewport", screenshots.viewport],
  ["os", screenshots.os],
  ["device", screenshots.device],
] as const;

/**
 * The environment values of a build's steps and, for each, its pending steps:
 * what the batch page's environment filter offers. Every value any step of the
 * build has is listed, even one whose steps are all decided or not reviewable
 * (`pending: 0`); NULL `os` / `device` (a desktop step) are omitted. `pending`
 * counts steps, over the whole build and with no facet applied (so it is the
 * count the filter would show before narrowing). Values are ascending by
 * string order, independent of the database collation.
 *
 * One statement for the four dimensions, so they come from one snapshot.
 */
export async function facetValuesByBuild(
  db: DB | Tx,
  args: { projectId: string; buildId: string },
): Promise<BatchFacets> {
  const branches = FACET_DIMENSIONS.map(
    ([dimension, column]) => sql`
      select '${sql.raw(dimension)}' as dimension,
             ${column} as value,
             (count(*) filter (where ${pendingStepCondition()}))::int as pending
      from ${screenshots}
      inner join ${testRuns} on ${testRuns.id} = ${screenshots.runId}
      where ${testRuns.projectId} = ${args.projectId}
        and ${screenshots.projectId} = ${args.projectId}
        and ${testRuns.buildId} = ${args.buildId}
        and ${column} is not null
      group by ${column}`,
  );
  const rows = await db.execute<{
    dimension: keyof BatchFacets;
    value: string;
    pending: number;
  }>(sql.join(branches, sql` union all `));

  const out: BatchFacets = { browser: [], viewport: [], os: [], device: [] };
  for (const r of rows) {
    out[r.dimension].push({ value: r.value, pending: Number(r.pending) });
  }
  for (const [dimension] of FACET_DIMENSIONS) {
    out[dimension].sort((a, b) =>
      a.value < b.value ? -1 : a.value > b.value ? 1 : 0,
    );
  }
  return out;
}
