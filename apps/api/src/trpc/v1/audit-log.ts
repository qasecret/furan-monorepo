import { and, auditLog, desc, eq, lt, users } from "@furan/db";
import { z } from "zod";

import { requireAdmin } from "../middlewares/admin.js";
import { publicProcedure, t } from "../trpc.js";

export const auditLogRouter = t.router({
  /**
   * Admin-only, keyset-paginated audit trail (newest first). Optional filters
   * by actor / action / target. The actor email is LEFT-JOINed (null if the
   * actor was since deleted — audit_log keeps actor_id FK-free on purpose).
   */
  list: publicProcedure
    .input(
      z.object({
        limit: z.number().int().min(1).max(100).default(50),
        // Keyset cursor: the `createdAt` (ISO) of the previous page's last row.
        cursor: z.string().datetime().nullish(),
        actorId: z.string().uuid().optional(),
        action: z.string().max(100).optional(),
        targetType: z.string().max(50).optional(),
        targetId: z.string().uuid().optional(),
      }),
    )
    .use(requireAdmin)
    .query(async ({ input, ctx }) => {
      const rows = await ctx.db
        .select({
          id: auditLog.id,
          actorId: auditLog.actorId,
          actorEmail: users.email,
          action: auditLog.action,
          targetType: auditLog.targetType,
          targetId: auditLog.targetId,
          metadata: auditLog.metadata,
          createdAt: auditLog.createdAt,
        })
        .from(auditLog)
        .leftJoin(users, eq(users.id, auditLog.actorId))
        .where(
          and(
            input.cursor
              ? lt(auditLog.createdAt, new Date(input.cursor))
              : undefined,
            input.actorId ? eq(auditLog.actorId, input.actorId) : undefined,
            input.action ? eq(auditLog.action, input.action) : undefined,
            input.targetType
              ? eq(auditLog.targetType, input.targetType)
              : undefined,
            input.targetId ? eq(auditLog.targetId, input.targetId) : undefined,
          ),
        )
        .orderBy(desc(auditLog.createdAt))
        .limit(input.limit + 1);

      const hasMore = rows.length > input.limit;
      const items = hasMore ? rows.slice(0, input.limit) : rows;
      const last = items[items.length - 1];
      return {
        items,
        nextCursor: hasMore && last ? last.createdAt.toISOString() : null,
      };
    }),
});
