import { and, count, desc, eq, ilike, sql, users } from "@furan/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { requireRole } from "../hooks/require-role.js";
import { hashPassword } from "../lib/password.js";

import {
  checkUserUpdateGuards,
  updateMayRemoveAdmin,
} from "./users-admin-guards.js";

export const createBody = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  firstName: z.string().min(1).max(80),
  lastName: z.string().min(1).max(80),
  role: z.enum(["admin", "editor", "guest"]).default("editor"),
});

export const updateBody = z
  .object({
    role: z.enum(["admin", "editor", "guest"]).optional(),
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
  role: z.enum(["admin", "editor", "guest"]),
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

export async function registerUsersAdminRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.get(
    "/users",
    { preHandler: [app.authenticate, requireRole("admin")] },
    async (req, reply) => {
      const parsed = listQuery.safeParse(req.query);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_query" });
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
        return reply.code(400).send({ error: "invalid_body" });
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
        return reply.code(201).send(row);
      } catch (err) {
        req.log.warn({ err }, "user_create_failed");
        return reply.code(409).send({ error: "email_taken" });
      }
    },
  );

  app.patch(
    "/users/:id",
    { preHandler: [app.authenticate, requireRole("admin")] },
    async (req, reply) => {
      if (!req.auth) {
        return reply.code(401).send({ error: "unauthenticated" });
      }
      const paramsParsed = paramsId.safeParse(req.params);
      if (!paramsParsed.success) {
        return reply.code(404).send({ error: "not_found" });
      }
      const bodyParsed = updateBody.safeParse(req.body);
      if (!bodyParsed.success) {
        return reply.code(400).send({ error: "invalid_body" });
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
        return reply.code(404).send({ error: "not_found" });
      }

      // Only pay for the admin-count query when the change could remove an
      // active admin. `count()` includes the target (an active admin in that
      // case), so subtract one to get the number of OTHER active admins.
      let otherActiveAdminCount = 0;
      if (updateMayRemoveAdmin(target, update)) {
        const [row] = await app.db
          .select({ n: count() })
          .from(users)
          .where(and(eq(users.role, "admin"), eq(users.isActive, true)));
        otherActiveAdminCount = Math.max(0, Number(row?.n ?? 0) - 1);
      }

      const guard = checkUserUpdateGuards({
        actorId: req.auth.id,
        target,
        update,
        otherActiveAdminCount,
      });
      if (!guard.ok) {
        return reply.code(guard.status).send({ error: guard.error });
      }

      // Apply the change. When it would remove an active admin, enforce the
      // last-admin invariant ATOMICALLY in the UPDATE's WHERE clause — the
      // count-based guard above is only a fast path. The row updates only if
      // another active admin still exists, closing the read-then-write race
      // where two concurrent demotions both pass the count check and leave
      // zero admins.
      const removesAdmin = updateMayRemoveAdmin(target, update);
      const result = await app.db
        .update(users)
        .set({ ...update, updatedAt: new Date() })
        .where(
          removesAdmin
            ? and(
                eq(users.id, targetId),
                sql`EXISTS (SELECT 1 FROM ${users} AS other WHERE other.role = 'admin' AND other.is_active = true AND other.id <> ${targetId})`,
              )
            : eq(users.id, targetId),
        )
        .returning(safeUserCols);

      if (result.length === 0) {
        // Plain path: the row vanished (concurrent delete) → 404.
        // Removes-admin path: the EXISTS guard failed — a concurrent change
        // removed the last other admin between our check and write — so this
        // would have left zero admins → 409.
        return reply
          .code(removesAdmin ? 409 : 404)
          .send({ error: removesAdmin ? "last_admin" : "not_found" });
      }

      const updated = result[0]!;

      // Audit + invalidate on a real role/activation change (skip no-ops).
      if (
        updated.role !== target.role ||
        updated.isActive !== target.isActive
      ) {
        req.log.info(
          {
            audit: "user.updated",
            actorId: req.auth.id,
            targetId,
            oldRole: target.role,
            newRole: updated.role,
            oldIsActive: target.isActive,
            newIsActive: updated.isActive,
          },
          "audit_user_updated",
        );
        // Drop the cached auth snapshot so the demotion/deactivation takes
        // effect on the target's NEXT request, cluster-wide (shared Redis).
        await app.cache?.del(targetId);
      }

      return updated;
    },
  );
}
