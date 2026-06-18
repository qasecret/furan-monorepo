import { and, builds, eq, sql } from "@furan/db";
import {
  buildAggregateStatusSchema,
  type BuildAggregateStatus,
} from "@furan/shared-types";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { authed } from "../middlewares/authed.js";
import { projectMember } from "../middlewares/project-member.js";
import { t } from "../trpc.js";

const projectIdInput = z.object({ projectId: z.string().uuid() });
type ProjectIdInput = z.infer<typeof projectIdInput>;

const listInput = z.object({
  projectId: z.string().uuid(),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(25),
  branch: z.string().min(1).max(200).optional(),
  status: buildAggregateStatusSchema.optional(),
  properties: z.record(z.string(), z.string()).optional(),
});
type ListInput = z.infer<typeof listInput>;

const buildIdInput = z.object({
  projectId: z.string().uuid(),
  buildId: z.string().uuid(),
});
type BuildIdInput = z.infer<typeof buildIdInput>;

const getByIdInput = z.object({ buildId: z.string().uuid() });
type GetByIdInput = z.infer<typeof getByIdInput>;

interface CursorPayload {
  createdAt: string;
  id: string;
}

function decodeCursor(raw: string): CursorPayload | null {
  try {
    return JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    ) as CursorPayload;
  } catch {
    return null;
  }
}

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(
    JSON.stringify({ createdAt: createdAt.toISOString(), id }),
    "utf8",
  ).toString("base64url");
}

/**
 * SQL CASE expression — keep this string in sync with spec §3.2 precedence:
 * running > unresolved > failed > aborted > passed > empty.
 */
const aggregateStatusExpr = sql<string>`
  CASE
    WHEN coalesce(r.running_count, 0)    > 0 THEN 'running'
    WHEN coalesce(r.unresolved_count, 0) > 0 THEN 'unresolved'
    WHEN coalesce(r.failed_count, 0)     > 0 THEN 'failed'
    WHEN coalesce(r.aborted_count, 0)    > 0 THEN 'aborted'
    WHEN coalesce(r.passed_count, 0)     > 0 THEN 'passed'
    ELSE 'empty'
  END
`;

export const buildsRouter = t.router({
  /**
   * Cursor-paginated listing for the Builds tab. Joins child runs as a CTE
   * to compute the aggregate status + counts in one query.
   */
  list: t.procedure
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

      const cursorPayload = input.cursor ? decodeCursor(input.cursor) : null;

      // CTE-based aggregate over test_runs grouped by build_id.
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
        aggregate_status: string;
      }>(sql`
        WITH run_agg AS (
          SELECT
            build_id,
            count(*)                                                AS run_count,
            count(*) FILTER (WHERE status = 'running')              AS running_count,
            count(*) FILTER (WHERE status = 'unresolved')           AS unresolved_count,
            count(*) FILTER (WHERE status = 'failed')               AS failed_count,
            count(*) FILTER (WHERE status = 'aborted')              AS aborted_count,
            count(*) FILTER (WHERE status IN ('passed','new'))      AS passed_count,
            count(*) FILTER (WHERE status = 'empty')                AS empty_count
          FROM test_runs
          WHERE build_id IN (SELECT id FROM builds WHERE project_id = ${input.projectId})
          GROUP BY build_id
        )
        SELECT
          b.id, b.ci_build_id, b.number, b.branch_name, b.status, b.name,
          b.properties, b.project_id, b.user_id, b.is_running, b.environment,
          b.created_at, b.updated_at,
          coalesce(r.run_count, 0)         AS run_count,
          coalesce(r.running_count, 0)     AS running_count,
          coalesce(r.unresolved_count, 0)  AS unresolved_count,
          coalesce(r.failed_count, 0)      AS failed_count,
          coalesce(r.aborted_count, 0)     AS aborted_count,
          coalesce(r.passed_count, 0)      AS passed_count,
          coalesce(r.empty_count, 0)       AS empty_count,
          ${aggregateStatusExpr}            AS aggregate_status
        FROM builds b
        LEFT JOIN run_agg r ON r.build_id = b.id
        WHERE b.project_id = ${input.projectId}
          AND (${input.branch ?? null}::text IS NULL OR b.branch_name = ${input.branch ?? null})
          AND (${propertyJson}::jsonb IS NULL OR b.properties @> ${propertyJson}::jsonb)
          AND (${input.status ?? null}::text IS NULL OR ${aggregateStatusExpr} = ${input.status ?? null})
          AND (
            ${cursorPayload?.createdAt ?? null}::timestamptz IS NULL
            OR (b.created_at, b.id) < (${cursorPayload?.createdAt ?? null}::timestamptz, ${cursorPayload?.id ?? null}::uuid)
          )
        ORDER BY b.created_at DESC, b.id DESC
        LIMIT ${input.limit + 1}
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
        aggregateStatus: r.aggregate_status as BuildAggregateStatus,
      }));
      const last = items[items.length - 1];
      const nextCursor =
        hasMore && last ? encodeCursor(last.createdAt, last.id) : null;
      return { items, nextCursor };
    }),

  /**
   * Fetch a single build by its id with the same aggregated status + counts
   * that `list` returns. Uses a resolve-then-gate auth pattern (mirrors
   * `runs.getById`) because the input is a bare `buildId` with no `projectId`.
   */
  getById: t.procedure
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
        empty_count: number;
        aggregate_status: string;
      }>(sql`
        WITH run_agg AS (
          SELECT
            build_id,
            count(*)                                                AS run_count,
            count(*) FILTER (WHERE status = 'running')              AS running_count,
            count(*) FILTER (WHERE status = 'unresolved')           AS unresolved_count,
            count(*) FILTER (WHERE status = 'failed')               AS failed_count,
            count(*) FILTER (WHERE status = 'aborted')              AS aborted_count,
            count(*) FILTER (WHERE status IN ('passed','new'))      AS passed_count,
            count(*) FILTER (WHERE status = 'empty')                AS empty_count
          FROM test_runs
          WHERE build_id = ${input.buildId}
          GROUP BY build_id
        )
        SELECT
          b.id, b.ci_build_id, b.number, b.branch_name, b.status, b.name,
          b.properties, b.project_id, b.user_id, b.is_running, b.environment,
          b.created_at, b.updated_at,
          coalesce(r.run_count, 0)         AS run_count,
          coalesce(r.running_count, 0)     AS running_count,
          coalesce(r.unresolved_count, 0)  AS unresolved_count,
          coalesce(r.failed_count, 0)      AS failed_count,
          coalesce(r.aborted_count, 0)     AS aborted_count,
          coalesce(r.passed_count, 0)      AS passed_count,
          coalesce(r.empty_count, 0)       AS empty_count,
          ${aggregateStatusExpr}            AS aggregate_status
        FROM builds b
        LEFT JOIN run_agg r ON r.build_id = b.id
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
        aggregateStatus: r.aggregate_status as BuildAggregateStatus,
      };
    }),

  get: t.procedure
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
  listProperties: t.procedure
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
