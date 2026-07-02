import { eq, users } from "@furan/db";
import { userRoleSchema } from "@furan/shared-types";
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
    role: userRoleSchema,
  }),
});

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/auth/login",
    {
      // Brute-force / credential-stuffing brake on the one unauthenticated
      // credential endpoint. Opt-in per-route (the plugin is registered with
      // `global: false`), keyed by client IP. See app.ts for the trustProxy /
      // Redis-store note for multi-instance deployments.
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (req, reply) => {
      const parsed = loginBody.safeParse(req.body);
      if (!parsed.success) {
        // Don't echo the Zod field/constraint map back on the unauthenticated
        // login endpoint — it needlessly reveals the expected schema shape.
        return reply.code(400).send({ error: "invalid_body" });
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
    },
  );
}
