import { and, eq, projectMembers, users } from "@furan/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { requireRole } from "../hooks/require-role.js";
import { emitAudit } from "../lib/emit-audit.js";
import { sendError } from "../lib/errors.js";
import { withRequestScope } from "../lib/with-request-scope.js";

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
        return sendError(reply, 404, "not_found");
      }
      const bodyParsed = addBody.safeParse(req.body);
      if (!bodyParsed.success) {
        return sendError(reply, 400, "invalid_body");
      }
      // `ON CONFLICT DO NOTHING RETURNING` rather than catching the unique
      // violation: catching a failed INSERT would poison the request-scoped
      // transaction (ADR-058). An empty result means the row already existed.
      return withRequestScope(
        app,
        req,
        async (db) => {
          // Verify the target user exists first so a bad userId is a clean 404
          // rather than a raw FK-violation 500 (onConflictDoNothing only
          // swallows the unique conflict, not the FK).
          const [target] = await db
            .select({ id: users.id })
            .from(users)
            .where(eq(users.id, bodyParsed.data.userId))
            .limit(1);
          if (!target) {
            return sendError(reply, 404, "user_not_found");
          }
          const [row] = await db
            .insert(projectMembers)
            .values({
              userId: bodyParsed.data.userId,
              projectId: paramsParsed.data.id,
            })
            .onConflictDoNothing()
            .returning();
          if (!row) {
            return sendError(reply, 409, "already_member");
          }
          // Invalidate the added user's cached member-project set (ADR-058).
          await app.memberProjectsCache?.del(bodyParsed.data.userId);
          await emitAudit(
            db,
            {
              actorId: req.auth?.id ?? null,
              action: "member.add",
              targetType: "project",
              targetId: paramsParsed.data.id,
              metadata: { userId: bodyParsed.data.userId },
            },
            req.log,
          );
          // Set status + RETURN the row so Fastify sends it AFTER the scope
          // commits (a client that lists members right after must see it).
          reply.code(201);
          return row;
        },
        paramsParsed.data.id,
      );
    },
  );

  app.delete(
    "/projects/:id/members/:userId",
    { preHandler: [app.authenticate, requireRole("admin")] },
    async (req, reply) => {
      const parsed = paramsRemove.safeParse(req.params);
      if (!parsed.success) {
        return sendError(reply, 404, "not_found");
      }
      const removed = await withRequestScope(
        app,
        req,
        async (db) => {
          const result = await db
            .delete(projectMembers)
            .where(
              and(
                eq(projectMembers.projectId, parsed.data.id),
                eq(projectMembers.userId, parsed.data.userId),
              ),
            )
            .returning({ id: projectMembers.id });
          return result.length > 0;
        },
        parsed.data.id,
      );
      // Send AFTER the scope commits so a follow-up read reflects the delete.
      if (!removed) {
        return sendError(reply, 404, "not_found");
      }
      // Revoked access → drop the cached set so it takes effect next request.
      await app.memberProjectsCache?.del(parsed.data.userId);
      await emitAudit(
        app.db,
        {
          actorId: req.auth?.id ?? null,
          action: "member.remove",
          targetType: "project",
          targetId: parsed.data.id,
          metadata: { userId: parsed.data.userId },
        },
        req.log,
      );
      return reply.code(204).send();
    },
  );
}
