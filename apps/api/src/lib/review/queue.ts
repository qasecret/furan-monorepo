import {
  and,
  asc,
  builds,
  count,
  desc,
  eq,
  ne,
  notInArray,
  screenshots,
  sql,
  testRuns,
  type DB,
  type SQL,
  type Tx,
} from "@furan/db";

import {
  buildHasPendingStep,
  facetCondition,
  pendingCountsByBuild,
  pendingStepCondition,
  type StepFacets,
} from "./pending.js";
import { buildDisplayName } from "./reads.js";

/**
 * The review queue (spec §3.2, §4.2). Inside a batch, steps go in capture
 * order: runs by `created_at, id`, as `runs.list({ order: "capture" })` lists
 * them, then each run's steps by `created_at, id`. Across batches, the newest
 * batch with a pending step goes first, the current batch's branch before any
 * other. "Pending" is `pendingStepCondition` inside the facets, and every
 * query is pinned to the project. `findNext` trusts its input (the caller
 * checks that the `at` ids belong to the project and to each other) and
 * takes no locks: its answer is a hint.
 */

/**
 * Where the reviewer is: a batch, optionally one of its runs and a step of
 * it. Optional fields here and in `NextInput` also accept `undefined`, so
 * zod-optional input passes straight through (`exactOptionalPropertyTypes`).
 */
export interface QueueAt {
  buildId: string;
  runId?: string | undefined;
  checkpointId?: string | undefined;
}

export interface NextInput {
  projectId: string;
  /** Absent: start from the newest batch with a pending step. */
  at?: QueueAt | undefined;
  /** Default `next`. */
  direction?: "next" | "prev" | undefined;
  facets?: StepFacets | undefined;
  /** Batches never chosen as the next (or starting) batch. */
  excludeBuildIds?: string[] | undefined;
}

export interface NextResult {
  target: { buildId: string; runId: string; checkpointId: string } | null;
  scope: "run" | "batch" | "nextBatch" | "none";
  remaining: {
    run: number;
    batch: number;
    batchUnfiltered: number;
    projectBatches: number;
  };
  nextBatch: {
    buildId: string;
    name: string;
    number: number | null;
    branch: string | null;
    pending: number;
  } | null;
}

type Target = NonNullable<NextResult["target"]>;
type Direction = "next" | "prev";
type BatchRow = Omit<NonNullable<NextResult["nextBatch"]>, "pending">;

/** Leaves out the step at hand, when `at` names one. */
function notAt(at: QueueAt): SQL | undefined {
  return at.checkpointId === undefined
    ? undefined
    : ne(screenshots.id, at.checkpointId);
}

/**
 * The steps after `at` in the walk's direction, as a keyset on
 * `(run.created_at, run.id, step.created_at, step.id)`. A step position
 * excludes the step itself; a run position takes in the whole run (from
 * before its first step, or after its last for `prev`); a batch position is
 * no condition. `at`'s own key is read in SQL, never through a JS Date (which
 * would round the microseconds away).
 */
function afterAt(projectId: string, at: QueueAt, direction: Direction) {
  const next = direction === "next";
  if (at.checkpointId !== undefined) {
    return sql`(${testRuns.createdAt}, ${testRuns.id}, ${screenshots.createdAt}, ${screenshots.id}) ${sql.raw(next ? ">" : "<")} (
      select at_run.created_at, at_run.id, at_step.created_at, at_step.id
      from ${screenshots} at_step
      join ${testRuns} at_run on at_run.id = at_step.run_id
      where at_step.id = ${at.checkpointId}
        and at_step.project_id = ${projectId}
        and at_run.project_id = ${projectId})`;
  }
  if (at.runId !== undefined) {
    return sql`(${testRuns.createdAt}, ${testRuns.id}) ${sql.raw(next ? ">=" : "<=")} (
      select at_run.created_at, at_run.id from ${testRuns} at_run
      where at_run.id = ${at.runId} and at_run.project_id = ${projectId})`;
  }
  return undefined;
}

/**
 * The next pending step after `at` in its batch (the previous one for
 * `prev`): one ordered query with `LIMIT 1`. When nothing comes after `at`,
 * a second one without the keyset wraps to the batch's other end, the steps
 * skipped earlier. Never `at`'s own step.
 */
async function stepInBatch(
  db: DB | Tx,
  projectId: string,
  at: QueueAt,
  direction: Direction,
  facets: StepFacets | undefined,
): Promise<Target | null> {
  const dir = direction === "next" ? asc : desc;
  const first = async (where: SQL | undefined) => {
    const [row] = await db
      .select({ runId: testRuns.id, checkpointId: screenshots.id })
      .from(screenshots)
      .innerJoin(testRuns, eq(testRuns.id, screenshots.runId))
      .where(
        and(
          eq(testRuns.projectId, projectId),
          eq(screenshots.projectId, projectId),
          eq(testRuns.buildId, at.buildId),
          pendingStepCondition(facets),
          where,
        ),
      )
      .orderBy(
        dir(testRuns.createdAt),
        dir(testRuns.id),
        dir(screenshots.createdAt),
        dir(screenshots.id),
      )
      .limit(1);
    return row ? { buildId: at.buildId, ...row } : null;
  };
  const after = afterAt(projectId, at, direction);
  const found = await first(after);
  return found || after === undefined ? found : first(notAt(at));
}

/**
 * The newest batch with a pending step inside `facets`, none of `exclude`,
 * among those matching `onBranch` (any when undefined). One `LIMIT 1` probe in
 * `created_at DESC, id DESC`, so it can stop at the first hit. Ties on
 * `created_at` go to the greater id.
 */
async function newestBatchWhere(
  db: DB | Tx,
  a: {
    projectId: string;
    exclude: string[];
    facets?: StepFacets | undefined;
  },
  onBranch: SQL | undefined,
): Promise<BatchRow | null> {
  const [row] = await db
    .select({
      id: builds.id,
      name: builds.name,
      number: builds.number,
      ciBuildId: builds.ciBuildId,
      branch: builds.branchName,
      // The builds list's rule: the test name only when every run shares one.
      // Qualified by hand: drizzle prints a one-table select's columns bare,
      // and a bare "id" would bind to the subquery's own `r.id`.
      testName: sql<string | null>`(
        select case when count(distinct r.name) = 1 then min(r.name) end
        from ${testRuns} r
        where r.build_id = ${builds}.id and r.project_id = ${a.projectId})`,
    })
    .from(builds)
    .where(
      and(
        eq(builds.projectId, a.projectId),
        a.exclude.length > 0 ? notInArray(builds.id, a.exclude) : undefined,
        onBranch,
        buildHasPendingStep(a.projectId, sql`${builds.id}`, {
          facets: a.facets,
        }),
      ),
    )
    .orderBy(desc(builds.createdAt), desc(builds.id))
    .limit(1);
  if (!row) return null;
  return {
    buildId: row.id,
    name: buildDisplayName(row),
    number: row.number,
    branch: row.branch,
  };
}

/**
 * The newest batch with a pending step inside `facets`, none of `exclude`;
 * with `branchOf`, the batches on that build's branch first (NULL matching
 * NULL). That is two probes, the branch's first and then any branch, each
 * stopping at its first hit: a single `ORDER BY` over "is on the branch" would
 * have to look at every batch of the project before it could answer.
 */
async function newestBatch(
  db: DB | Tx,
  a: {
    projectId: string;
    exclude: string[];
    facets?: StepFacets | undefined;
    branchOf?: string;
  },
): Promise<BatchRow | null> {
  if (a.branchOf !== undefined) {
    const sameBranch = await newestBatchWhere(
      db,
      a,
      sql`${builds.branchName} is not distinct from (select cur.branch_name from ${builds} cur where cur.id = ${a.branchOf} and cur.project_id = ${a.projectId})`,
    );
    if (sameBranch) return sameBranch;
  }
  return newestBatchWhere(db, a, undefined);
}

/** The project's batches with a pending step inside `facets`, but `exceptStepId`. */
function pendingBatches(
  projectId: string,
  facets: StepFacets | undefined,
  exceptStepId?: string,
): SQL<number> {
  return sql<number>`(select count(*) from ${builds} b where b.project_id = ${projectId} and ${buildHasPendingStep(projectId, sql`b.id`, { facets, exceptStepId })})`.mapWith(
    Number,
  );
}

/**
 * The counts, in one statement: the pending steps of the run and of the batch
 * inside `facets`, of the batch with none, and the project's batches with a
 * pending step inside `facets`; every count leaves out the step at hand.
 */
async function remainingIn(
  db: DB | Tx,
  projectId: string,
  at: QueueAt,
  facets: StepFacets | undefined,
): Promise<NextResult["remaining"]> {
  const inFacets = facetCondition(facets) ?? sql`true`;
  const inRun = at.runId === undefined ? sql`false` : eq(testRuns.id, at.runId);
  const [row] = await db
    .select({
      run: sql<number>`count(*) filter (where ${inRun} and ${inFacets})`.mapWith(
        Number,
      ),
      batch: sql<number>`count(*) filter (where ${inFacets})`.mapWith(Number),
      batchUnfiltered: count(),
      projectBatches: pendingBatches(projectId, facets, at.checkpointId),
    })
    .from(screenshots)
    .innerJoin(testRuns, eq(testRuns.id, screenshots.runId))
    .where(
      and(
        eq(testRuns.projectId, projectId),
        eq(screenshots.projectId, projectId),
        eq(testRuns.buildId, at.buildId),
        pendingStepCondition(),
        notAt(at),
      ),
    );
  return row!;
}

/**
 * Where the reviewer goes next (spec §4.2): the next pending step after `at`
 * in its batch, wrapping to the skipped ones, else the next batch's first
 * pending step. Without `at`, the first pending step of the newest batch with
 * one, any branch, and `remaining` is about that batch (with no run).
 * `nextBatch` is filled in even when the target is still in the batch.
 */
export async function findNext(
  db: DB | Tx,
  input: NextInput,
): Promise<NextResult> {
  const { projectId, facets } = input;
  const exclude = input.excludeBuildIds ?? [];
  const start =
    input.at ?? (await newestBatch(db, { projectId, exclude, facets }));
  if (!start) {
    const [row] = await db.execute<{ n: number }>(
      sql`select ${pendingBatches(projectId, facets)} as n`,
    );
    const projectBatches = Number(row?.n ?? 0);
    const remaining = { run: 0, batch: 0, batchUnfiltered: 0, projectBatches };
    return { target: null, scope: "none", remaining, nextBatch: null };
  }
  const at: QueueAt = input.at ?? { buildId: start.buildId };
  // Another batch always opens at its first pending step.
  const direction = input.at ? (input.direction ?? "next") : "next";

  let target = await stepInBatch(db, projectId, at, direction, facets);
  let scope: NextResult["scope"] = !target
    ? "none"
    : target.runId === at.runId
      ? "run"
      : "batch";
  const next = await newestBatch(db, {
    projectId,
    exclude: [at.buildId, ...exclude],
    facets,
    ...(input.at ? { branchOf: at.buildId } : {}),
  });
  if (!target && next) {
    const first = { buildId: next.buildId };
    target = await stepInBatch(db, projectId, first, "next", facets);
    if (target) scope = "nextBatch";
  }

  const remaining = await remainingIn(db, projectId, at, facets);
  const pending = await pendingCountsByBuild(db, {
    projectId,
    buildIds: next ? [next.buildId] : [],
    facets,
  });
  const nextBatch = next && {
    ...next,
    pending: pending.get(next.buildId) ?? 0,
  };
  return { target, scope, remaining, nextBatch };
}
