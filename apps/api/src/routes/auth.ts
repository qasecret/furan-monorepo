import { eq, users } from "@furan/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { verifyPassword } from "../lib/password.js";

export const loginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const loginResponse = z.object({
  token: z.string().describe("JWT bearer token (signed with HS256)."),
  user: z.object({
    id: z.string().uuid(),
    email: z.string().email(),
    role: z.enum(["admin", "editor", "guest"]),
  }),
});

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  app.post("/auth/login", async (req, reply) => {
    const parsed = loginBody.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid_body", details: parsed.error.flatten() });
    }
    const { email, password } = parsed.data;

    const rows = await app.db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    const user = rows[0];
    if (!user || !user.isActive) {
      return reply.code(401).send({ error: "invalid_credentials" });
    }
    const ok = await verifyPassword(password, user.hashedPassword);
    if (!ok) {
      return reply.code(401).send({ error: "invalid_credentials" });
    }

    const token = await reply.jwtSign({ sub: user.id, role: user.role });
    return reply.code(200).send({
      token,
      user: { id: user.id, email: user.email, role: user.role },
    });
  });
}
