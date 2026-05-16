import type { FastifyReply, FastifyRequest } from "fastify";

import type { UserRole } from "../plugins/auth.js";

export function requireRole(...roles: UserRole[]) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!req.auth) {
      return reply.code(401).send({ error: "unauthenticated" });
    }
    if (!roles.includes(req.auth.role)) {
      return reply.code(403).send({ error: "forbidden" });
    }
  };
}
