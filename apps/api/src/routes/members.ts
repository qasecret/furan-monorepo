import { and, eq, projectMembers } from "@furan/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { requireRole } from "../hooks/require-role.js";

export const addBody = z.object({ userId: z.string().uuid() });

export const paramsAdd = z.object({ id: z.string().uuid() });
export const paramsRemove = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
});

export const memberResponse = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  userId: z.string().uuid(),
  createdAt: z.date(),
});

export async function registerMembersRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.post(
    "/projects/:id/members",
    { preHandler: [app.authenticate, requireRole("admin")] },
    async (req, reply) => {
      const paramsParsed = paramsAdd.safeParse(req.params);
      if (!paramsParsed.success) {
        return reply.code(404).send({ error: "not_found" });
      }
      const bodyParsed = addBody.safeParse(req.body);
      if (!bodyParsed.success) {
        return reply.code(400).send({ error: "invalid_body" });
      }
      try {
        const [row] = await app.db
          .insert(projectMembers)
          .values({
            userId: bodyParsed.data.userId,
            projectId: paramsParsed.data.id,
          })
          .returning();
        return reply.code(201).send(row);
      } catch (err) {
        req.log.warn({ err }, "member_add_failed");
        return reply.code(409).send({ error: "already_member" });
      }
    },
  );

  app.delete(
    "/projects/:id/members/:userId",
    { preHandler: [app.authenticate, requireRole("admin")] },
    async (req, reply) => {
      const parsed = paramsRemove.safeParse(req.params);
      if (!parsed.success) {
        return reply.code(404).send({ error: "not_found" });
      }
      const result = await app.db
        .delete(projectMembers)
        .where(
          and(
            eq(projectMembers.projectId, parsed.data.id),
            eq(projectMembers.userId, parsed.data.userId),
          ),
        )
        .returning({ id: projectMembers.id });
      if (result.length === 0) {
        return reply.code(404).send({ error: "not_found" });
      }
      return reply.code(204).send();
    },
  );
}
