import { and, auditLog, desc, eq, sql, users } from "@furan/db";
import { z } from "zod";

import {
  cursorTimestamp,
  decodeKeysetCursor,
  encodeKeysetCursor,
} from "../../lib/keyset-cursor.js";
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
        // Opaque keyset cursor: the previous page's `nextCursor` — its last
        // row's full-µs `createdAt` + id (lib/keyset-cursor.ts).
        cursor: z.string().nullish(),
        actorId: z.string().uuid().optional(),
        action: z.string().max(100).optional(),
        targetType: z.string().max(50).optional(),
        targetId: z.string().uuid().optional(),
      }),
    )
    .use(requireAdmin)
    .query(async ({ input, ctx }) => {
      const cursor = input.cursor ? decodeKeysetCursor(input.cursor) : null;
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
          cursorAt: cursorTimestamp(auditLog.createdAt),
        })
        .from(auditLog)
        .leftJoin(users, eq(users.id, auditLog.actorId))
        .where(
          and(
            cursor
              ? sql`(${auditLog.createdAt}, ${auditLog.id}) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`
              : undefined,
            input.actorId ? eq(auditLog.actorId, input.actorId) : undefined,
            input.action ? eq(auditLog.action, input.action) : undefined,
            input.targetType
              ? eq(auditLog.targetType, input.targetType)
              : undefined,
            input.targetId ? eq(auditLog.targetId, input.targetId) : undefined,
          ),
        )
        .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
        .limit(input.limit + 1);

      const hasMore = rows.length > input.limit;
      const page = hasMore ? rows.slice(0, input.limit) : rows;
      const last = page[page.length - 1];
      return {
        items: page.map(({ cursorAt: _cursorAt, ...r }) => r),
        nextCursor:
          hasMore && last
            ? encodeKeysetCursor({ createdAt: last.cursorAt, id: last.id })
            : null,
      };
    }),
});
