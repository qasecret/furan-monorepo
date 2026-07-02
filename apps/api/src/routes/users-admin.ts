import { and, desc, eq, ilike, sql, users, type DB } from "@furan/db";
import { userRoleSchema } from "@furan/shared-types";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { requireRole } from "../hooks/require-role.js";
import { emitAudit } from "../lib/emit-audit.js";
import { sendError } from "../lib/errors.js";
import { hashPassword } from "../lib/password.js";

import {
  checkUserUpdateGuards,
  updateMayRemoveAdmin,
  updateMayRemoveOwner,
} from "./users-admin-guards.js";

export const createBody = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  firstName: z.string().min(1).max(80),
  lastName: z.string().min(1).max(80),
  role: userRoleSchema.default("editor"),
});

export const updateBody = z
  .object({
    role: userRoleSchema.optional(),
    isActive: z.boolean().optional(),
    firstName: z.string().min(1).max(80).optional(),
    lastName: z.string().min(1).max(80).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, {
    message: "at_least_one_field_required",
  });

export const paramsId = z.object({ id: z.string().uuid() });
export const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  q: z.string().max(120).optional(),
});

export const userResponse = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  firstName: z.string(),
  lastName: z.string(),
  role: userRoleSchema,
  isActive: z.boolean(),
  defaultProjectId: z.string().uuid().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const userListResponse = z.array(userResponse);

const safeUserCols = {
  id: users.id,
  email: users.email,
  firstName: users.firstName,
  lastName: users.lastName,
  role: users.role,
  isActive: users.isActive,
  defaultProjectId: users.defaultProjectId,
  createdAt: users.createdAt,
  updatedAt: users.updatedAt,
};

/**
 * Counts, in ONE round-trip, the OTHER active users (excluding `targetId`) that
 * hold each protected tier:
 * - `owners`: active owners — feeds the last-owner invariant.
 * - `admins`: active admin-capable users (admin OR owner, since owner ⊇ admin) —
 *   feeds the last-admin invariant.
 * Used by both the fast-path guard and the post-UPDATE cold path, so the count
 * shape lives in one place. Postgres `count(*)` is bigint → string over the
 * wire, hence the `Number(...)`.
 */
async function countOtherActiveTiers(
  db: DB,
  targetId: string,
): Promise<{ owners: number; admins: number }> {
  const [row] = await db
    .select({
      owners: sql<number>`count(*) filter (where ${users.role} = 'owner' and ${users.isActive} = true and ${users.id} <> ${targetId})`,
      admins: sql<number>`count(*) filter (where ${users.role} in ('admin','owner') and ${users.isActive} = true and ${users.id} <> ${targetId})`,
    })
    .from(users);
  return { owners: Number(row?.owners ?? 0), admins: Number(row?.admins ?? 0) };
}

export async function registerUsersAdminRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.get(
    "/users",
    { preHandler: [app.authenticate, requireRole("admin")] },
    async (req, reply) => {
      const parsed = listQuery.safeParse(req.query);
      if (!parsed.success) {
        return sendError(reply, 400, "invalid_query");
      }
      const { limit, offset, q } = parsed.data;
      const trimmed = q?.trim();
      const whereClause = trimmed
        ? and(ilike(users.email, `%${trimmed}%`))
        : undefined;
      return app.db
        .select(safeUserCols)
        .from(users)
        .where(whereClause)
        .orderBy(desc(users.createdAt))
        .limit(limit)
        .offset(offset);
    },
  );

  app.post(
    "/users",
    { preHandler: [app.authenticate, requireRole("admin")] },
    async (req, reply) => {
      const parsed = createBody.safeParse(req.body);
      if (!parsed.success) {
        return sendError(reply, 400, "invalid_body");
      }
      const hashedPassword = await hashPassword(parsed.data.password);
      try {
        const [row] = await app.db
          .insert(users)
          .values({
            email: parsed.data.email,
            hashedPassword,
            firstName: parsed.data.firstName,
            lastName: parsed.data.lastName,
            role: parsed.data.role,
            isActive: true,
          })
          .returning(safeUserCols);
        await emitAudit(
          app.db,
          {
            actorId: req.auth?.id ?? null,
            action: "user.created",
            targetType: "user",
            targetId: row?.id ?? null,
            metadata: { email: parsed.data.email, role: parsed.data.role },
          },
          req.log,
        );
        return reply.code(201).send(row);
      } catch (err) {
        req.log.warn({ err }, "user_create_failed");
        return sendError(reply, 409, "email_taken");
      }
    },
  );

  app.patch(
    "/users/:id",
    { preHandler: [app.authenticate, requireRole("admin")] },
    async (req, reply) => {
      if (!req.auth) {
        return sendError(reply, 401, "unauthenticated");
      }
      const paramsParsed = paramsId.safeParse(req.params);
      if (!paramsParsed.success) {
        return sendError(reply, 404, "not_found");
      }
      const bodyParsed = updateBody.safeParse(req.body);
      if (!bodyParsed.success) {
        return sendError(reply, 400, "invalid_body");
      }

      const targetId = paramsParsed.data.id;
      const update = bodyParsed.data;

      // Current target state — needed for the authorization invariants below
      // (evaluated against the DB, never the request) and for the audit record.
      const [target] = await app.db
        .select({
          id: users.id,
          role: users.role,
          isActive: users.isActive,
        })
        .from(users)
        .where(eq(users.id, targetId))
        .limit(1);
      if (!target) {
        return sendError(reply, 404, "not_found");
      }

      const removesAdmin = updateMayRemoveAdmin(target, update);
      const removesOwner = updateMayRemoveOwner(target, update);

      // One round-trip for both tier counts (each already excludes the target).
      // Only pay for it when a removal is in play; otherwise the invariants
      // don't consult the counts.
      const counts =
        removesAdmin || removesOwner
          ? await countOtherActiveTiers(app.db, targetId)
          : { owners: 0, admins: 0 };

      const guard = checkUserUpdateGuards({
        actorId: req.auth.id,
        actorRole: req.auth.role,
        target,
        update,
        otherActiveAdminCount: counts.admins,
        otherActiveOwnerCount: counts.owners,
      });
      if (!guard.ok) {
        return sendError(reply, guard.status, guard.error);
      }

      // Apply the change. When it would remove an active admin-capable user or
      // the last owner, enforce those invariants ATOMICALLY in the UPDATE's
      // WHERE clause — the count-based guard above is only a fast path. The row
      // updates only if another active admin (resp. owner) still exists,
      // closing the read-then-write race where two concurrent demotions both
      // pass the count check and leave zero.
      const conds = [eq(users.id, targetId)];
      if (removesAdmin) {
        conds.push(
          sql`EXISTS (SELECT 1 FROM ${users} AS other WHERE other.role IN ('admin','owner') AND other.is_active = true AND other.id <> ${targetId})`,
        );
      }
      if (removesOwner) {
        conds.push(
          sql`EXISTS (SELECT 1 FROM ${users} AS other WHERE other.role = 'owner' AND other.is_active = true AND other.id <> ${targetId})`,
        );
      }
      const result = await app.db
        .update(users)
        .set({ ...update, updatedAt: new Date() })
        .where(conds.length === 1 ? conds[0] : and(...conds))
        .returning(safeUserCols);

      if (result.length === 0) {
        // The UPDATE matched no row: either the target vanished (concurrent
        // delete → 404) or an EXISTS invariant guard failed because a
        // concurrent change removed the last other owner / admin between our
        // check and write (→ 409). Check existence first so a delete reports
        // 404 (not a misleading last_*), then disambiguate with fresh counts.
        const [stillExists] = await app.db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, targetId))
          .limit(1);
        if (!stillExists) {
          return sendError(reply, 404, "not_found");
        }
        const fresh = await countOtherActiveTiers(app.db, targetId);
        if (removesOwner && fresh.owners === 0) {
          return sendError(reply, 409, "last_owner");
        }
        if (removesAdmin && fresh.admins === 0) {
          return sendError(reply, 409, "last_admin");
        }
        return sendError(reply, 404, "not_found");
      }

      const updated = result[0]!;

      // Audit + invalidate on a real role/activation change (skip no-ops).
      if (
        updated.role !== target.role ||
        updated.isActive !== target.isActive
      ) {
        await emitAudit(
          app.db,
          {
            actorId: req.auth.id,
            action: "user.updated",
            targetType: "user",
            targetId,
            metadata: {
              oldRole: target.role,
              newRole: updated.role,
              oldIsActive: target.isActive,
              newIsActive: updated.isActive,
            },
          },
          req.log,
        );
        // Drop the cached auth snapshot so the demotion/deactivation takes
        // effect on the target's NEXT request, cluster-wide (shared Redis).
        await app.cache?.del(targetId);
      }

      return updated;
    },
  );
}
