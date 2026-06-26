import { eq, users } from "@furan/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

export const meResponse = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  firstName: z.string(),
  lastName: z.string(),
  role: z.enum(["owner", "admin", "editor", "guest"]),
  isActive: z.boolean(),
  defaultProjectId: z.string().uuid().nullable(),
  createdAt: z.date(),
});

export async function registerUsersRoutes(app: FastifyInstance): Promise<void> {
  app.get("/users/me", { preHandler: app.authenticate }, async (req, reply) => {
    if (!req.auth) {
      return reply.code(401).send({ error: "unauthenticated" });
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
      return reply.code(404).send({ error: "user_not_found" });
    }
    return rows[0];
  });
}
