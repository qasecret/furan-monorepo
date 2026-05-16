import { builds, desc, eq, withProjectScope } from "@furan/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { requireProjectMember } from "../hooks/require-project-member.js";

const createBody = z.object({
  ciBuildId: z.string().min(1).optional(),
  number: z.number().int().optional(),
  branchName: z.string().min(1).optional(),
});

const paramsId = z.object({ id: z.string().uuid() });
const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export async function registerBuildsRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.get(
    "/projects/:id/builds",
    {
      preHandler: [
        app.authenticate,
        requireProjectMember("read", { from: { params: "id" } }),
      ],
    },
    async (req, reply) => {
      const paramsParsed = paramsId.safeParse(req.params);
      if (!paramsParsed.success) {
        return reply.code(404).send({ error: "not_found" });
      }
      const queryParsed = querySchema.safeParse(req.query);
      if (!queryParsed.success) {
        return reply.code(400).send({ error: "invalid_query" });
      }
      return app.db
        .select()
        .from(builds)
        .where(eq(builds.projectId, paramsParsed.data.id))
        .orderBy(desc(builds.createdAt))
        .limit(queryParsed.data.limit);
    },
  );

  app.post(
    "/projects/:id/builds",
    {
      preHandler: [
        app.authenticate,
        requireProjectMember("write", { from: { params: "id" } }),
      ],
    },
    async (req, reply) => {
      if (!req.auth) {
        return reply.code(401).send({ error: "unauthenticated" });
      }
      const paramsParsed = paramsId.safeParse(req.params);
      if (!paramsParsed.success) {
        return reply.code(404).send({ error: "not_found" });
      }
      const bodyParsed = createBody.safeParse(req.body);
      if (!bodyParsed.success) {
        return reply.code(400).send({ error: "invalid_body" });
      }

      const row = await withProjectScope(
        app.db,
        paramsParsed.data.id,
        async (tx) => {
          const [created] = await tx
            .insert(builds)
            .values({
              projectId: paramsParsed.data.id,
              userId: req.auth!.id,
              isRunning: true,
              ...bodyParsed.data,
            })
            .returning();
          return created;
        },
      );

      return reply.code(201).send(row);
    },
  );
}
