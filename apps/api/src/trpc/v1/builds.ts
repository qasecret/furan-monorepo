import { and, builds, eq, sql, type SQL } from "@furan/db";
import {
  buildAggregateStatusSchema,
  type BuildAggregateStatus,
  type RunStatus,
} from "@furan/shared-types";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import {
  cursorTimestamp,
  decodeKeysetCursor,
  encodeKeysetCursor,
} from "../../lib/keyset-cursor.js";
import {
  buildHasStoredPending,
  pendingBatchCount,
} from "../../lib/review/pending.js";
import { authed } from "../middlewares/authed.js";
import { projectMember } from "../middlewares/project-member.js";
import { publicProcedure, t } from "../trpc.js";

const projectIdInput = z.object({ projectId: z.string().uuid() });
type ProjectIdInput = z.infer<typeof projectIdInput>;

const listInput = z.object({
  projectId: z.string().uuid(),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(25),
  branch: z.string().min(1).max(200).optional(),
  status: buildAggregateStatusSchema.optional(),
  properties: z.record(z.string(), z.string()).optional(),
  /**
   * `true` keeps the builds that need review: at least one pending step (spec
   * §3.1; `pendingStepCondition`), read from the runs' stored counters (spec
   * 2026-10-27 §3), so exactly the batches the Batches badge counts. `false`
   * or omitted is no filter. Combines with the other filters by AND.
   */
  needsReview: z.boolean().optional(),
  /**
   * `true` keeps the builds with no pending step: the complement of
   * `needsReview: true`. The Passed chip on the Batches page sends it with
   * `status: "passed"` (Ruling R32), since a `new` run rolls up to passed
   * while its steps still need review. `false` or omitted is no filter.
   * Combines with the other filters by AND.
   */
  noPending: z.boolean().optional(),
  /**
   * `true` keeps the builds with at least one failed run (`failedCount > 0`),
   * whatever else they hold: a build with a failed run and a pending one is
   * `unresolved` in the rollup and still listed here. The Failed chip on the
   * Batches page (spec §3.1: the chips are filters, not a partition). `false`
   * or omitted is no filter. Combines with the other filters by AND.
   */
  anyFailed: z.boolean().optional(),
});
type ListInput = z.infer<typeof listInput>;

const buildIdInput = z.object({
  projectId: z.string().uuid(),
  buildId: z.string().uuid(),
});
type BuildIdInput = z.infer<typeof buildIdInput>;

const getByIdInput = z.object({ buildId: z.string().uuid() });
type GetByIdInput = z.infer<typeof getByIdInput>;

/**
 * A build's aggregate status (spec §3.2), in precedence order: running >
 * unresolved > failed > aborted > passed > empty, each with the run statuses
 * behind it. A build is the first status it has a run in, and `empty` when it
 * has none of them (no runs, or only `empty` ones). The per-status counts
 * (`RUN_STATUS_COUNTS`), the CASE that picks the status from them
 * (`aggregateStatusExpr`) and the status filter (`aggregateStatusIs`) are all
 * derived from this table, so they cannot disagree.
 */
export const AGGREGATE_STATUS_RUNS: ReadonlyArray<
  readonly [Exclude<BuildAggregateStatus, "empty">, readonly RunStatus[]]
> = [
  ["running", ["running"]],
  ["unresolved", ["unresolved"]],
  ["failed", ["failed"]],
  ["aborted", ["aborted"]],
  ["passed", ["passed", "new"]],
];

/** `'a', 'b'`: run statuses as SQL literals (code constants, never input). */
function statusList(statuses: readonly RunStatus[]): string {
  return statuses.map((s) => `'${s}'`).join(", ");
}

/**
 * Over the runs `r` of one build: `count(*) FILTER (...) AS <status>_count`
 * for each aggregate status of `AGGREGATE_STATUS_RUNS`, its runs counted.
 */
const RUN_STATUS_COUNTS = sql.raw(
  AGGREGATE_STATUS_RUNS.map(
    ([status, runs]) =>
      `count(*) FILTER (WHERE r.status IN (${statusList(runs)})) AS ${status}_count`,
  ).join(",\n"),
);

/**
 * The aggregate status from `RUN_STATUS_COUNTS` (as `r.<status>_count`): the
 * first in precedence order with a run, else `empty`.
 */
const aggregateStatusExpr = sql.raw(
  `CASE ${AGGREGATE_STATUS_RUNS.map(
    ([status]) => `WHEN coalesce(r.${status}_count, 0) > 0 THEN '${status}'`,
  ).join(" ")} ELSE 'empty' END`,
);

/**
 * The aggregate over one build's runs `r` that `list` and `getById` both
 * report: one row, from the runs' own columns.
 */
const RUN_AGGREGATE = sql`
  count(*)                                         AS run_count,
  ${RUN_STATUS_COUNTS},
  count(*) FILTER (WHERE r.status = 'empty')       AS empty_count,
  -- The pending steps by the runs' stored counters (spec 2026-10-27 §3.1),
  -- the number both the list and getById report.
  coalesce(sum(r.pending_steps), 0)                AS pending_checkpoints,
  -- The build's single distinct test name (NULL when 0 or >1 tests), so the
  -- Builds list can title a one-test build by its test rather than the
  -- opaque build id. SDK runs are one-test-per-build (ADR-038).
  CASE WHEN count(DISTINCT r.name) = 1 THEN min(r.name) ELSE NULL END AS test_name
`;

/**
 * The build (`b` in the enclosing raw query) has a run of the project in one
 * of `statuses`: an `EXISTS` probe by build on `test_runs_build_status_idx`
 * (`build_id, status`), which stops at the first such run, so the project
 * filter costs one row read at most. The statuses are code constants
 * (`AGGREGATE_STATUS_RUNS`), never input, written as literals so a generic
 * plan still sees them.
 */
function hasRunIn(projectId: string, statuses: readonly RunStatus[]): SQL {
  return sql`EXISTS (
    SELECT 1 FROM test_runs sr
    WHERE sr.build_id = b.id
      AND sr.project_id = ${projectId}
      AND sr.status IN (${sql.raw(statusList(statuses))})
  )`;
}

/**
 * The build's aggregate status is `status`, without computing it: a run in
 * its own statuses, and none in a status that outranks it. `empty` is no run
 * in any of them.
 */
function aggregateStatusIs(
  projectId: string,
  status: BuildAggregateStatus,
): SQL {
  if (status === "empty") {
    return sql`NOT ${hasRunIn(
      projectId,
      AGGREGATE_STATUS_RUNS.flatMap(([, runs]) => runs),
    )}`;
  }
  const at = AGGREGATE_STATUS_RUNS.findIndex(([s]) => s === status);
  if (at === -1) {
    // Only a status added to the schema and not to the table gets here: it
    // must not silently filter as `empty`.
    throw new Error(`aggregate status "${status}" has no precedence`);
  }
  const own = AGGREGATE_STATUS_RUNS[at]![1];
  const outranking = AGGREGATE_STATUS_RUNS.slice(0, at).flatMap(
    ([, runs]) => runs,
  );
  return and(
    hasRunIn(projectId, own),
    outranking.length > 0
      ? sql`NOT ${hasRunIn(projectId, outranking)}`
      : undefined,
  )!;
}

export const buildsRouter = t.router({
  /**
   * Cursor-paginated listing for the Builds tab, in one statement (spec
   * 2026-10-27 §4, "`builds.list`"; budget R3). It pages first, then
   * aggregates: the page's builds are read newest first from
   * `builds_project_created_idx` with `LIMIT`, every filter an `EXISTS` probe
   * per build, and only then does a `LEFT JOIN LATERAL` count the runs of
   * each page build. The work is proportional to the page, not to the
   * project's history.
   *
   * `needsReview` keeps the builds with a pending step and `noPending` those
   * without one, both on the runs' stored counters (`buildHasStoredPending`,
   * the batches the badge counts); `anyFailed` keeps those with at least one
   * failed run; `status` is the aggregate status (`aggregateStatusIs`). Each
   * item carries `pendingCheckpoints` (the pending steps in the build:
   * `sum(pending_steps)` over its runs).
   */
  list: publicProcedure
    .input(listInput)
    .use(authed)
    .use(
      projectMember<ListInput>("read", {
        from: {
          resolver: ({ input }) => Promise.resolve(input.projectId),
        },
      }),
    )
    .query(async ({ input, ctx }) => {
      const propertyJson =
        input.properties && Object.keys(input.properties).length > 0
          ? JSON.stringify(input.properties)
          : null;

      const cursorPayload = input.cursor
        ? decodeKeysetCursor(input.cursor)
        : null;

      const filters: SQL[] = [];
      if (input.status) {
        filters.push(aggregateStatusIs(input.projectId, input.status));
      }
      if (input.needsReview) {
        filters.push(buildHasStoredPending(input.projectId, sql`b.id`));
      }
      if (input.noPending) {
        filters.push(
          sql`NOT ${buildHasStoredPending(input.projectId, sql`b.id`)}`,
        );
      }
      if (input.anyFailed) filters.push(hasRunIn(input.projectId, ["failed"]));

      // The page (limit + 1 rows, to know whether there is a next one) is a
      // subquery: its LIMIT keeps it from being flattened, so the lateral
      // aggregate runs once per page build, after the LIMIT. Every run read
      // carries the project too, beside the project-scoped `b`.
      const rows = await ctx.db.execute<{
        id: string;
        ci_build_id: string | null;
        number: number | null;
        branch_name: string | null;
        status: string | null;
        name: string | null;
        properties: Record<string, string>;
        project_id: string;
        user_id: string | null;
        is_running: boolean;
        environment: string;
        created_at: Date;
        updated_at: Date;
        run_count: number;
        running_count: number;
        unresolved_count: number;
        failed_count: number;
        aborted_count: number;
        passed_count: number;
        empty_count: number;
        pending_checkpoints: number;
        test_name: string | null;
        aggregate_status: string;
        cursor_at: string;
      }>(sql`
        SELECT
          b.id, b.ci_build_id, b.number, b.branch_name, b.status, b.name,
          b.properties, b.project_id, b.user_id, b.is_running, b.environment,
          b.created_at, b.updated_at,
          ${cursorTimestamp(sql`b.created_at`)} AS cursor_at,
          r.run_count, r.running_count, r.unresolved_count, r.failed_count,
          r.aborted_count, r.passed_count, r.empty_count,
          r.pending_checkpoints, r.test_name,
          ${aggregateStatusExpr}            AS aggregate_status
        FROM (
          SELECT
            b.id, b.ci_build_id, b.number, b.branch_name, b.status, b.name,
            b.properties, b.project_id, b.user_id, b.is_running, b.environment,
            b.created_at, b.updated_at
          FROM builds b
          WHERE b.project_id = ${input.projectId}
            AND (${input.branch ?? null}::text IS NULL OR b.branch_name = ${input.branch ?? null})
            AND (${propertyJson}::jsonb IS NULL OR b.properties @> ${propertyJson}::jsonb)
            ${sql.join(
              filters.map((f) => sql`AND ${f}`),
              sql` `,
            )}
            AND (
              ${cursorPayload?.createdAt ?? null}::timestamptz IS NULL
              OR (b.created_at, b.id) < (${cursorPayload?.createdAt ?? null}::timestamptz, ${cursorPayload?.id ?? null}::uuid)
            )
          ORDER BY b.created_at DESC, b.id DESC
          LIMIT ${input.limit + 1}
        ) b
        LEFT JOIN LATERAL (
          SELECT ${RUN_AGGREGATE}
          FROM test_runs r
          WHERE r.build_id = b.id
            AND r.project_id = ${input.projectId}
        ) r ON true
        ORDER BY b.created_at DESC, b.id DESC
      `);

      const hasMore = rows.length > input.limit;
      const sliced = hasMore ? rows.slice(0, input.limit) : rows;
      const items = sliced.map((r) => ({
        id: r.id,
        ciBuildId: r.ci_build_id,
        number: r.number,
        branchName: r.branch_name,
        status: r.status,
        name: r.name,
        testName: r.test_name,
        properties: r.properties,
        projectId: r.project_id,
        userId: r.user_id,
        isRunning: r.is_running,
        environment: r.environment,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        runCount: Number(r.run_count),
        runningCount: Number(r.running_count),
        unresolvedCount: Number(r.unresolved_count),
        failedCount: Number(r.failed_count),
        abortedCount: Number(r.aborted_count),
        passedCount: Number(r.passed_count),
        emptyCount: Number(r.empty_count),
        pendingCheckpoints: Number(r.pending_checkpoints),
        aggregateStatus: r.aggregate_status as BuildAggregateStatus,
      }));
      const last = sliced[sliced.length - 1];
      const nextCursor =
        hasMore && last
          ? encodeKeysetCursor({ createdAt: last.cursor_at, id: last.id })
          : null;
      return { items, nextCursor };
    }),

  /**
   * How many of the project's builds need review (have at least one pending
   * step): the Batches badge. Counts builds, not steps, from the runs' stored
   * counters (`pendingBatchCount`, an index-only read of
   * `test_runs_pending_idx`).
   */
  pendingCount: publicProcedure
    .input(projectIdInput)
    .use(authed)
    .use(
      projectMember<ProjectIdInput>("read", {
        from: { resolver: ({ input }) => Promise.resolve(input.projectId) },
      }),
    )
    .query(async ({ input, ctx }) => {
      const rows = await ctx.db.execute<{ total: number }>(
        sql`SELECT ${pendingBatchCount(input.projectId)}::int AS total`,
      );
      return { total: Number(rows[0]?.total ?? 0) };
    }),

  /**
   * Fetch a single build by its id with the same aggregated status + counts
   * that `list` returns, in one statement whatever the build's size (spec
   * 2026-10-27 §4, "`builds.getById`"; budget R5): the counts are sums of its
   * runs' columns, `pendingCheckpoints` the stored counters (the number the
   * list shows) and `stepsTotal` the step counts. Every run read is the
   * build's project's. Uses a resolve-then-gate auth pattern (mirrors
   * `runs.getById`) because the input is a bare `buildId` with no `projectId`.
   */
  getById: publicProcedure
    .input(getByIdInput)
    .use(authed)
    .use(
      projectMember<GetByIdInput>("read", {
        from: {
          resolver: async ({ input, ctx }) => {
            const [b] = await ctx.db
              .select({ projectId: builds.projectId })
              .from(builds)
              .where(eq(builds.id, input.buildId))
              .limit(1);
            return b?.projectId ?? null;
          },
        },
      }),
    )
    .query(async ({ input, ctx }) => {
      const rows = await ctx.db.execute<{
        id: string;
        ci_build_id: string | null;
        number: number | null;
        branch_name: string | null;
        status: string | null;
        name: string | null;
        properties: Record<string, string>;
        project_id: string;
        user_id: string | null;
        is_running: boolean;
        environment: string;
        created_at: Date;
        updated_at: Date;
        run_count: number;
        running_count: number;
        unresolved_count: number;
        failed_count: number;
        aborted_count: number;
        passed_count: number;
        new_count: number;
        empty_count: number;
        steps_total: number;
        pending_checkpoints: number;
        run_by_first_name: string | null;
        run_by_last_name: string | null;
        test_name: string | null;
        aggregate_status: string;
      }>(sql`
        SELECT
          b.id, b.ci_build_id, b.number, b.branch_name, b.status, b.name,
          b.properties, b.project_id, b.user_id, b.is_running, b.environment,
          b.created_at, b.updated_at,
          r.run_count, r.running_count, r.unresolved_count, r.failed_count,
          r.aborted_count, r.passed_count, r.new_count, r.empty_count,
          r.steps_total, r.pending_checkpoints,
          u.first_name                     AS run_by_first_name,
          u.last_name                      AS run_by_last_name,
          r.test_name                      AS test_name,
          ${aggregateStatusExpr}            AS aggregate_status
        FROM builds b
        LEFT JOIN LATERAL (
          SELECT ${RUN_AGGREGATE},
            count(*) FILTER (WHERE r.status = 'new')     AS new_count,
            -- Every step of the build, by the runs' step counts (upload,
            -- complete, merge and the capture worker's step insert keep
            -- checkpoint_count).
            coalesce(sum(r.checkpoint_count), 0)         AS steps_total
          FROM test_runs r
          WHERE r.build_id = b.id
            AND r.project_id = b.project_id
        ) r ON true
        LEFT JOIN users u ON u.id = b.user_id
        WHERE b.id = ${input.buildId}
        LIMIT 1
      `);
      const r = rows[0];
      if (!r) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }
      return {
        id: r.id,
        ciBuildId: r.ci_build_id,
        number: r.number,
        branchName: r.branch_name,
        status: r.status,
        name: r.name,
        testName: r.test_name,
        properties: r.properties,
        projectId: r.project_id,
        userId: r.user_id,
        isRunning: r.is_running,
        environment: r.environment,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        runCount: Number(r.run_count),
        runningCount: Number(r.running_count),
        unresolvedCount: Number(r.unresolved_count),
        failedCount: Number(r.failed_count),
        abortedCount: Number(r.aborted_count),
        passedCount: Number(r.passed_count),
        newCount: Number(r.new_count),
        emptyCount: Number(r.empty_count),
        stepsTotal: Number(r.steps_total),
        pendingCheckpoints: Number(r.pending_checkpoints),
        runByName:
          r.run_by_first_name || r.run_by_last_name
            ? `${r.run_by_first_name ?? ""} ${r.run_by_last_name ?? ""}`.trim()
            : null,
        aggregateStatus: r.aggregate_status as BuildAggregateStatus,
      };
    }),

  get: publicProcedure
    .input(buildIdInput)
    .use(authed)
    .use(
      projectMember<BuildIdInput>("read", {
        from: { resolver: ({ input }) => Promise.resolve(input.projectId) },
      }),
    )
    .query(async ({ input, ctx }) => {
      const rows = await ctx.db
        .select()
        .from(builds)
        .where(
          and(
            eq(builds.id, input.buildId),
            eq(builds.projectId, input.projectId),
          ),
        )
        .limit(1);
      const row = rows[0];
      if (!row) throw new TRPCError({ code: "NOT_FOUND" });
      return row;
    }),

  /**
   * Distinct (key, values[]) pairs across the project's builds. Drives the
   * filter-chip autocomplete on the Builds tab. Capped in the app layer to
   * avoid pathological UIs on projects with many distinct property values.
   */
  listProperties: publicProcedure
    .input(projectIdInput)
    .use(authed)
    .use(
      projectMember<ProjectIdInput>("read", {
        from: { resolver: ({ input }) => Promise.resolve(input.projectId) },
      }),
    )
    .query(async ({ input, ctx }) => {
      const rows = await ctx.db.execute<{ key: string; values: string[] }>(sql`
        SELECT key, array_agg(DISTINCT value ORDER BY value) AS values
        FROM builds, jsonb_each_text(properties)
        WHERE project_id = ${input.projectId}
        GROUP BY key
        ORDER BY key
        LIMIT 200
      `);
      return rows.map((r) => ({
        key: r.key,
        values: r.values.slice(0, 100),
      }));
    }),
});
