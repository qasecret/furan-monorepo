import { dashboardTelemetryEvents, sql, testRuns, users } from "@furan/db";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { authed } from "../middlewares/authed.js";
import { t } from "../trpc.js";

const windowInput = z.object({
  days: z.number().int().min(1).max(90).default(7),
});

// Common pattern: every procedure gates on admin role first.
// (We don't have a generic adminOnly middleware factory; inline check
// keeps this self-contained.)
function requireAdmin(role: string | undefined) {
  if (role !== "admin") {
    throw new TRPCError({ code: "FORBIDDEN", message: "Admin role required" });
  }
}

export const analyticsRouter = t.router({
  summary: t.procedure
    .input(windowInput)
    .use(authed)
    .query(async ({ ctx, input }) => {
      requireAdmin(ctx.user?.role);

      const window = sql`(${input.days} || ' days')::interval`;
      const doubleWindow = sql`(${input.days * 2} || ' days')::interval`;

      const rows = await ctx.db.execute(sql`
        SELECT
          count(*) FILTER (WHERE event = 'inbox.row_action'
            AND created_at >= now() - ${window}) AS total_actions,
          count(*) FILTER (WHERE event = 'inbox.row_action' AND props->>'action' = 'approve'
            AND created_at >= now() - ${window}) AS approves,
          count(*) FILTER (WHERE event = 'inbox.row_action' AND props->>'action' = 'reject'
            AND created_at >= now() - ${window}) AS rejects,
          count(*) FILTER (WHERE event = 'inbox.row_action' AND (props->>'viaKeyboard')::boolean
            AND created_at >= now() - ${window}) AS via_keyboard,
          count(*) FILTER (WHERE event = 'inbox.session_duration'
            AND created_at >= now() - ${window}) AS sessions,
          coalesce(
            (
              percentile_cont(0.5) WITHIN GROUP (ORDER BY (props->>'durationMs')::bigint / nullif((props->>'actionsTaken')::int, 0))
              FILTER (WHERE event = 'inbox.session_duration' AND (props->>'actionsTaken')::int > 0
                AND created_at >= now() - ${window})
            ),
            0
          )::bigint AS median_ms_per_action,
          count(*) FILTER (WHERE event = 'inbox.row_action'
            AND created_at >= now() - ${doubleWindow}
            AND created_at < now() - ${window}) AS prev_total_actions,
          count(*) FILTER (WHERE event = 'inbox.row_action' AND props->>'action' = 'approve'
            AND created_at >= now() - ${doubleWindow}
            AND created_at < now() - ${window}) AS prev_approves
        FROM ${dashboardTelemetryEvents}
        WHERE created_at >= now() - ${doubleWindow}
      `);

      // Separate query for medianTimeToFirstActionMs via sessionId join.
      const ttfaRows = await ctx.db.execute(sql`
        WITH session_viewed AS (
          SELECT
            props->>'sessionId' AS session_id,
            min(created_at) AS viewed_at
          FROM ${dashboardTelemetryEvents}
          WHERE event = 'inbox.viewed'
            AND props->>'sessionId' IS NOT NULL
            AND created_at >= now() - ${window}
          GROUP BY props->>'sessionId'
        ),
        session_first_action AS (
          SELECT
            props->>'sessionId' AS session_id,
            min(created_at) AS first_action_at
          FROM ${dashboardTelemetryEvents}
          WHERE event = 'inbox.row_action'
            AND props->>'sessionId' IS NOT NULL
            AND created_at >= now() - ${window}
          GROUP BY props->>'sessionId'
        )
        SELECT
          coalesce(
            percentile_cont(0.5) WITHIN GROUP (
              ORDER BY extract(epoch FROM (a.first_action_at - v.viewed_at)) * 1000
            ),
            0
          )::bigint AS median_time_to_first_action_ms
        FROM session_viewed v
        JOIN session_first_action a USING (session_id)
        WHERE a.first_action_at > v.viewed_at
      `);

      // ctx.db.execute returns whatever the driver hands back. Drizzle's
      // postgres-js driver returns an array of plain objects. Read the
      // first row defensively.
      const row = (rows as unknown as Array<Record<string, unknown>>)[0] ?? {};
      const totalActions = Number(row.total_actions ?? 0);
      const approves = Number(row.approves ?? 0);
      const rejects = Number(row.rejects ?? 0);
      const viaKeyboard = Number(row.via_keyboard ?? 0);
      const sessions = Number(row.sessions ?? 0);
      const medianMsPerAction = Number(row.median_ms_per_action ?? 0);
      const prevTotalActions = Number(row.prev_total_actions ?? 0);
      const prevApproves = Number(row.prev_approves ?? 0);

      const ttfaRow =
        (ttfaRows as unknown as Array<Record<string, unknown>>)[0] ?? {};
      const medianTimeToFirstActionMs = Number(
        ttfaRow.median_time_to_first_action_ms ?? 0,
      );

      return {
        totalActions,
        approves,
        rejects,
        viaKeyboard,
        sessions,
        medianMsPerAction,
        medianTimeToFirstActionMs,
        approveRate: totalActions === 0 ? 0 : approves / totalActions,
        rejectRate: totalActions === 0 ? 0 : rejects / totalActions,
        keyboardRate: totalActions === 0 ? 0 : viaKeyboard / totalActions,
        prevTotalActions,
        prevApproveRate:
          prevTotalActions === 0 ? 0 : prevApproves / prevTotalActions,
      };
    }),

  actionsByDay: t.procedure
    .input(windowInput)
    .use(authed)
    .query(async ({ ctx, input }) => {
      requireAdmin(ctx.user?.role);

      const window = sql`(${input.days} || ' days')::interval`;

      const rows = await ctx.db.execute(sql`
        SELECT
          date_trunc('day', created_at)::date AS day,
          count(*) FILTER (WHERE props->>'action' = 'approve') AS approves,
          count(*) FILTER (WHERE props->>'action' = 'reject') AS rejects
        FROM ${dashboardTelemetryEvents}
        WHERE event = 'inbox.row_action'
          AND created_at >= now() - ${window}
        GROUP BY day
        ORDER BY day
      `);

      const items = (rows as unknown as Array<Record<string, unknown>>).map(
        (r) => ({
          day:
            r.day instanceof Date
              ? (r.day as Date).toISOString().slice(0, 10)
              : String(r.day),
          approves: Number(r.approves ?? 0),
          rejects: Number(r.rejects ?? 0),
        }),
      );

      return { items };
    }),

  topReviewers: t.procedure
    .input(
      z.object({
        days: z.number().int().min(1).max(90).default(7),
        limit: z.number().int().min(1).max(50).default(5),
      }),
    )
    .use(authed)
    .query(async ({ ctx, input }) => {
      requireAdmin(ctx.user?.role);

      // Group all rows whose user has been deleted (FK is ON DELETE
      // SET NULL) under a single synthetic "(deleted user)" bucket so
      // the summary card's totalActions reconciles with the sum of
      // topReviewers rather than disappearing entirely when the only
      // reviewer leaves. The summary card had been showing
      // "Actions: 4" with "No reviewer activity" — the unattributed
      // bucket fixes that mismatch.
      const rows = await ctx.db.execute(sql`
        SELECT
          dte.user_id,
          u.email,
          count(*) AS actions
        FROM ${dashboardTelemetryEvents} dte
        LEFT JOIN ${users} u ON u.id = dte.user_id
        WHERE dte.event = 'inbox.row_action'
          AND dte.created_at >= now() - (${input.days} || ' days')::interval
        GROUP BY dte.user_id, u.email
        ORDER BY actions DESC
        LIMIT ${input.limit}
      `);

      const items = (rows as unknown as Array<Record<string, unknown>>).map(
        (r) => ({
          userId: r.user_id == null ? null : String(r.user_id),
          email: r.email == null ? null : String(r.email),
          actions: Number(r.actions ?? 0),
        }),
      );

      return { items };
    }),

  testResultsSummary: t.procedure
    .input(
      z.object({
        days: z.number().int().min(1).max(90).default(7),
        projectId: z.string().uuid(),
      }),
    )
    .use(authed)
    .query(async ({ ctx, input }) => {
      requireAdmin(ctx.user?.role);

      const window = sql`(${input.days} || ' days')::interval`;
      const doubleWindow = sql`(${input.days * 2} || ' days')::interval`;

      const rows = await ctx.db.execute(sql`
        SELECT
          count(*) FILTER (
            WHERE created_at >= now() - ${window}
          ) AS total,
          count(*) FILTER (
            WHERE status = 'passed' AND created_at >= now() - ${window}
          ) AS passed,
          count(*) FILTER (
            WHERE status = 'failed' AND created_at >= now() - ${window}
          ) AS failed,
          count(*) FILTER (
            WHERE status = 'unresolved' AND created_at >= now() - ${window}
          ) AS unresolved,
          count(*) FILTER (
            WHERE created_at >= now() - ${doubleWindow}
              AND created_at < now() - ${window}
          ) AS prev_total,
          count(*) FILTER (
            WHERE status = 'passed'
              AND created_at >= now() - ${doubleWindow}
              AND created_at < now() - ${window}
          ) AS prev_passed
        FROM ${testRuns}
        WHERE project_id = ${input.projectId}
          AND created_at >= now() - ${doubleWindow}
          AND status NOT IN ('running', 'aborted', 'empty')
      `);

      const row = (rows as unknown as Array<Record<string, unknown>>)[0] ?? {};
      const total = Number(row.total ?? 0);
      const passed = Number(row.passed ?? 0);
      const failed = Number(row.failed ?? 0);
      const unresolved = Number(row.unresolved ?? 0);
      const prevTotal = Number(row.prev_total ?? 0);
      const prevPassed = Number(row.prev_passed ?? 0);
      const prevPassRate = prevTotal === 0 ? 0 : prevPassed / prevTotal;

      return {
        total,
        passed,
        failed,
        unresolved,
        passRate: total === 0 ? 0 : passed / total,
        prevTotal,
        prevPassRate,
      };
    }),

  runsByDay: t.procedure
    .input(
      z.object({
        days: z.number().int().min(1).max(90).default(7),
        projectId: z.string().uuid(),
      }),
    )
    .use(authed)
    .query(async ({ ctx, input }) => {
      requireAdmin(ctx.user?.role);

      const window = sql`(${input.days} || ' days')::interval`;

      const rows = await ctx.db.execute(sql`
        SELECT
          date_trunc('day', created_at)::date AS day,
          count(*) FILTER (WHERE status = 'passed') AS passed,
          count(*) FILTER (WHERE status = 'failed') AS failed,
          count(*) FILTER (WHERE status = 'unresolved') AS unresolved
        FROM ${testRuns}
        WHERE project_id = ${input.projectId}
          AND created_at >= now() - ${window}
          AND status NOT IN ('running', 'aborted', 'empty')
        GROUP BY day
        ORDER BY day
      `);

      const items = (rows as unknown as Array<Record<string, unknown>>).map(
        (r) => ({
          day:
            r.day instanceof Date
              ? (r.day as Date).toISOString().slice(0, 10)
              : String(r.day),
          passed: Number(r.passed ?? 0),
          failed: Number(r.failed ?? 0),
          unresolved: Number(r.unresolved ?? 0),
        }),
      );

      return { items };
    }),

  topFragileTests: t.procedure
    .input(
      z.object({
        days: z.number().int().min(1).max(90).default(7),
        projectId: z.string().uuid(),
        limit: z.number().int().min(1).max(50).default(5),
      }),
    )
    .use(authed)
    .query(async ({ ctx, input }) => {
      requireAdmin(ctx.user?.role);

      const window = sql`(${input.days} || ' days')::interval`;

      const rows = await ctx.db.execute(sql`
        SELECT
          name,
          count(*) AS executions,
          count(*) FILTER (WHERE status = 'passed') AS passed
        FROM ${testRuns}
        WHERE project_id = ${input.projectId}
          AND created_at >= now() - ${window}
          AND status NOT IN ('running', 'aborted', 'empty')
        GROUP BY name
        HAVING count(*) > 0
        ORDER BY
          (count(*) FILTER (WHERE status = 'passed'))::float / count(*) ASC,
          count(*) DESC
        LIMIT ${input.limit}
      `);

      const items = (rows as unknown as Array<Record<string, unknown>>).map(
        (r) => ({
          name: String(r.name),
          executions: Number(r.executions ?? 0),
          passed: Number(r.passed ?? 0),
        }),
      );

      return { items };
    }),
});
