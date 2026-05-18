import { and, desc, eq, ilike, users } from "@furan/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { requireRole } from "../hooks/require-role.js";
import { hashPassword } from "../lib/password.js";

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

      if (
        paramsParsed.data.id === req.auth.id &&
        bodyParsed.data.isActive === false
      ) {
        return reply.code(400).send({ error: "cannot_disable_self" });
      }

      const result = await app.db
        .update(users)
        .set({ ...bodyParsed.data, updatedAt: new Date() })
        .where(eq(users.id, paramsParsed.data.id))
        .returning(safeUserCols);

      if (result.length === 0) {
        return reply.code(404).send({ error: "not_found" });
      }
      return result[0];
    },
  );
}
