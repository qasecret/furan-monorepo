import { eq, users } from "@furan/db";
import { userRoleSchema } from "@furan/shared-types";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { sendError } from "../lib/errors.js";

export const meResponse = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  firstName: z.string(),
  lastName: z.string(),
  role: userRoleSchema,
  isActive: z.boolean(),
  defaultProjectId: z.string().uuid().nullable(),
  createdAt: z.date(),
});

export async function registerUsersRoutes(app: FastifyInstance): Promise<void> {
  app.get("/users/me", { preHandler: app.authenticate }, async (req, reply) => {
    if (!req.auth) {
      return sendError(reply, 401, "unauthenticated");
    }
    const rows = await app.db
      .select({
        id: users.id,
        email: users.email,
        firstName: users.firstName,
        lastName: users.lastName,
        role: users.role,
        isActive: users.isActive,
        defaultProjectId: users.defaultProjectId,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(eq(users.id, req.auth.id))
      .limit(1);
    if (!rows[0]) {
      return sendError(reply, 404, "user_not_found");
    }
    return rows[0];
  });
}
