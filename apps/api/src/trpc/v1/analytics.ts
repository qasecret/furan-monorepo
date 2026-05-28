import { dashboardTelemetryEvents, sql, users } from "@furan/db";
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

      const rows = await ctx.db.execute(sql`
        SELECT
          count(*) FILTER (WHERE event = 'inbox.row_action') AS total_actions,
          count(*) FILTER (WHERE event = 'inbox.row_action' AND props->>'action' = 'approve') AS approves,
          count(*) FILTER (WHERE event = 'inbox.row_action' AND props->>'action' = 'reject') AS rejects,
          count(*) FILTER (WHERE event = 'inbox.row_action' AND (props->>'viaKeyboard')::boolean) AS via_keyboard,
          count(*) FILTER (WHERE event = 'inbox.session_duration') AS sessions,
          coalesce(
            (
              percentile_cont(0.5) WITHIN GROUP (ORDER BY (props->>'durationMs')::bigint / nullif((props->>'actionsTaken')::int, 0))
              FILTER (WHERE event = 'inbox.session_duration' AND (props->>'actionsTaken')::int > 0)
            ),
            0
          )::bigint AS median_ms_per_action
        FROM ${dashboardTelemetryEvents}
        WHERE created_at >= now() - (${input.days} || ' days')::interval
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
            AND created_at >= now() - (${input.days} || ' days')::interval
          GROUP BY props->>'sessionId'
        ),
        session_first_action AS (
          SELECT
            props->>'sessionId' AS session_id,
            min(created_at) AS first_action_at
          FROM ${dashboardTelemetryEvents}
          WHERE event = 'inbox.row_action'
            AND props->>'sessionId' IS NOT NULL
            AND created_at >= now() - (${input.days} || ' days')::interval
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
        // Pre-compute the ratios so the client doesn't divide-by-zero.
        approveRate: totalActions === 0 ? 0 : approves / totalActions,
        rejectRate: totalActions === 0 ? 0 : rejects / totalActions,
        keyboardRate: totalActions === 0 ? 0 : viaKeyboard / totalActions,
      };
    }),

  actionsByDay: t.procedure
    .input(windowInput)
    .use(authed)
    .query(async ({ ctx, input }) => {
      requireAdmin(ctx.user?.role);

      const rows = await ctx.db.execute(sql`
        SELECT
          date_trunc('day', created_at)::date AS day,
          count(*) FILTER (WHERE props->>'action' = 'approve') AS approves,
          count(*) FILTER (WHERE props->>'action' = 'reject') AS rejects
        FROM ${dashboardTelemetryEvents}
        WHERE event = 'inbox.row_action'
          AND created_at >= now() - (${input.days} || ' days')::interval
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

      const rows = await ctx.db.execute(sql`
        SELECT
          dte.user_id,
          u.email,
          count(*) AS actions
        FROM ${dashboardTelemetryEvents} dte
        LEFT JOIN ${users} u ON u.id = dte.user_id
        WHERE dte.event = 'inbox.row_action'
          AND dte.user_id IS NOT NULL
          AND dte.created_at >= now() - (${input.days} || ' days')::interval
        GROUP BY dte.user_id, u.email
        ORDER BY actions DESC
        LIMIT ${input.limit}
      `);

      const items = (rows as unknown as Array<Record<string, unknown>>).map(
        (r) => ({
          userId: String(r.user_id),
          email: r.email == null ? null : String(r.email),
          actions: Number(r.actions ?? 0),
        }),
      );

      return { items };
    }),
});
