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

      return {
        totalActions,
        approves,
        rejects,
        viaKeyboard,
        sessions,
        medianMsPerAction,
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
