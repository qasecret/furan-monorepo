import { and, count, desc, eq, ilike, inArray, sql, users } from "@furan/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { requireRole } from "../hooks/require-role.js";
import { emitAudit } from "../lib/emit-audit.js";
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
  role: z.enum(["owner", "admin", "editor", "guest"]).default("editor"),
});

export const updateBody = z
  .object({
    role: z.enum(["owner", "admin", "editor", "guest"]).optional(),
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
  role: z.enum(["owner", "admin", "editor", "guest"]),
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

      const removesAdmin = updateMayRemoveAdmin(target, update);
      const removesOwner = updateMayRemoveOwner(target, update);

      // Only pay for the admin-count query when the change could remove an
      // active admin-capable user. `count()` includes the target (an active
      // admin/owner in that case), so subtract one to get the number of OTHER
      // active admin-capable users. Owners count here because owner ⊇ admin.
      let otherActiveAdminCount = 0;
      if (removesAdmin) {
        const [row] = await app.db
          .select({ n: count() })
          .from(users)
          .where(
            and(
              inArray(users.role, ["admin", "owner"]),
              eq(users.isActive, true),
            ),
          );
        otherActiveAdminCount = Math.max(0, Number(row?.n ?? 0) - 1);
      }

      // Likewise for the owner-count, used by the last-owner invariant.
      let otherActiveOwnerCount = 0;
      if (removesOwner) {
        const [row] = await app.db
          .select({ n: count() })
          .from(users)
          .where(and(eq(users.role, "owner"), eq(users.isActive, true)));
        otherActiveOwnerCount = Math.max(0, Number(row?.n ?? 0) - 1);
      }

      const guard = checkUserUpdateGuards({
        actorId: req.auth.id,
        actorRole: req.auth.role,
        target,
        update,
        otherActiveAdminCount,
        otherActiveOwnerCount,
      });
      if (!guard.ok) {
        return reply.code(guard.status).send({ error: guard.error });
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
        // The row either vanished (concurrent delete → 404) or an EXISTS guard
        // failed because a concurrent change removed the last other owner /
        // admin between our check and write (→ 409). Disambiguate on the cold
        // path with targeted counts so the caller gets the precise reason.
        if (removesOwner) {
          const [o] = await app.db
            .select({ n: count() })
            .from(users)
            .where(
              and(
                eq(users.role, "owner"),
                eq(users.isActive, true),
                sql`${users.id} <> ${targetId}`,
              ),
            );
          if (Number(o?.n ?? 0) === 0) {
            return reply.code(409).send({ error: "last_owner" });
          }
        }
        if (removesAdmin) {
          const [a] = await app.db
            .select({ n: count() })
            .from(users)
            .where(
              and(
                inArray(users.role, ["admin", "owner"]),
                eq(users.isActive, true),
                sql`${users.id} <> ${targetId}`,
              ),
            );
          if (Number(a?.n ?? 0) === 0) {
            return reply.code(409).send({ error: "last_admin" });
          }
        }
        return reply.code(404).send({ error: "not_found" });
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
