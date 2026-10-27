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
 * "approve"); `review-pending.test.ts` holds the two together, with one
 * deliberate exception: a step whose diff failed (spec 2026-10-23 §10) is
 * pending here, so the review loop stops on it and counts show it, but it is
 * not approvable (`diff_failed`, `assessDecision`) until it is retried, so
 * `selectPendingTargets` leaves it out.
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
 *
 * The run stores its pending rollup (spec 2026-10-27 §3):
 * `test_runs.pending_steps` is the number of its steps this condition selects
 * with no facets, kept by `recomputeRunStatus` alone, the one writer. The
 * project-wide reads that need no facet take it from there
 * (`pendingBuildIds`, `pendingBatchCount`, `buildPendingCount`), through the
 * partial index `test_runs_pending_idx`. Whatever picks a step, or answers
 * inside facets, still asks this condition, with `storedPendingRun` beside
 * it as a pre-filter: the counter cannot see facets, but no step of a run
 * stored at 0 is pending.
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
 * The run's stored counter says it has a pending step (`test_runs.pending_steps
 * > 0`, spec 2026-10-27 §3.1): a necessary condition of `pendingStepCondition`
 * under any facets, and the predicate of `test_runs_pending_idx`. The `0` is a
 * literal, not a bound parameter, so the index's predicate is provably implied
 * under a generic plan too. Over the unaliased `test_runs`.
 */
export function storedPendingRun(): SQL {
  return sql`${testRuns.pendingSteps} > 0`;
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
 *
 * It asks the steps, never the stored counters, so it holds on rows whose
 * counters are not written yet (the scale seed resolves batches with it
 * before it backfills them). The review queue and the Batches badge use
 * `pendingBuildIds` instead.
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
 * The project's batches with a pending step inside `facets`, other than
 * `exceptBuildId` when given: a `select build_id` with one row per batch, for
 * a derived table or an `IN`.
 *
 * With no facet it reads the runs' stored counters alone: an index-only read
 * of `test_runs_pending_idx`, whose size is the project's runs with pending
 * work, not its history. With a facet the steps decide
 * (`pendingStepCondition(facets)`), and the counter only narrows the runs
 * whose steps are asked. A run's project is its build's (run creation checks
 * it), so these are exactly the project's batches with such a step.
 *
 * The step conditions reference the unaliased `screenshots` / `test_runs`, so
 * embed this as its own subquery.
 */
export function pendingBuildIds(
  projectId: string,
  opts: {
    facets?: StepFacets | undefined;
    exceptBuildId?: string | undefined;
  } = {},
): SQL {
  const except =
    opts.exceptBuildId === undefined
      ? sql``
      : sql`and ${testRuns.buildId} <> ${opts.exceptBuildId}`;
  const stored = sql`select distinct ${testRuns.buildId} as build_id
    from ${testRuns}
    where ${testRuns.projectId} = ${projectId}
      and ${storedPendingRun()}
      ${except}`;
  if (facetCondition(opts.facets) === undefined) return stored;
  // The batches the counters name are read first, on their own (an
  // InitPlan, from the index alone), and each is kept when one of its steps
  // is pending inside the facets, probed through its pending runs. Joined in
  // one scan instead, the planner can misjudge how many runs are pending and
  // scan every run of the project.
  return sql`select pending_batch.build_id
    from unnest(array(${stored})) pending_batch(build_id)
    where exists (
      select 1 from ${testRuns}
      join ${screenshots} on ${screenshots.runId} = ${testRuns.id}
      where ${testRuns.buildId} = pending_batch.build_id
        and ${testRuns.projectId} = ${projectId}
        and ${screenshots.projectId} = ${projectId}
        and ${storedPendingRun()}
        and ${pendingStepCondition(opts.facets)})`;
}

/**
 * How many of the project's batches have a pending step inside `facets`, other
 * than `exceptBuildId`: `pendingBuildIds` counted, as a scalar subquery.
 */
export function pendingBatchCount(
  projectId: string,
  opts: {
    facets?: StepFacets | undefined;
    exceptBuildId?: string | undefined;
  } = {},
): SQL<number> {
  return sql<number>`(select count(*) from (${pendingBuildIds(projectId, opts)}) pending_builds)`.mapWith(
    Number,
  );
}

/**
 * The number of the build's pending steps inside `facets`, as a scalar
 * subquery: `buildId` is the enclosing query's build id, as for
 * `buildHasPendingStep`. A query that picks a build (`LIMIT 1`) and wants its
 * count in the same statement computes this over the picked row only, so pick
 * the build in a subquery and select this from it.
 *
 * With no facet it is the sum of the build's runs' stored counters
 * (`test_runs_pending_idx`); with one, the steps' count, over the runs whose
 * counter is above 0.
 *
 * Every column sits inside a nested fragment or behind an alias, so it keeps
 * its table even in the select list of a drizzle one-table select (which
 * prints a direct column chunk of a select-list expression bare).
 */
export function buildPendingCount(
  projectId: string,
  buildId: SQL,
  facets?: StepFacets | undefined,
): SQL<number> {
  if (facetCondition(facets) === undefined) {
    return sql<number>`(select coalesce(sum(r.pending_steps), 0) from ${testRuns} r where r.build_id = ${buildId} and r.project_id = ${projectId} and r.pending_steps > 0)`.mapWith(
      Number,
    );
  }
  const joined = sql`${screenshots.runId} = ${testRuns.id}`;
  const inBuild = and(
    sql`${testRuns.buildId} = ${buildId}`,
    eq(testRuns.projectId, projectId),
    eq(screenshots.projectId, projectId),
    storedPendingRun(),
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
