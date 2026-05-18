import { eq, inArray, projectMembers, projects } from "@furan/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { requireProjectMember } from "../hooks/require-project-member.js";
import { requireRole } from "../hooks/require-role.js";

export const createBody = z.object({
  name: z.string().min(1).max(120),
  mainBranchName: z.string().min(1).max(120).optional(),
});

export const paramsId = z.object({ id: z.string().uuid() });

export const projectResponse = z.object({
  id: z.string().uuid(),
  name: z.string(),
  mainBranchName: z.string().nullable(),
  buildsCounter: z.number().int().nonnegative(),
  maxBuildAllowed: z.number().int().nonnegative().nullable(),
  maxBranchLifetime: z.number().int().nonnegative().nullable(),
  autoApproveFeature: z.boolean(),
  imageComparison: z.enum(["odiff", "pixelmatch", "looks_same"]),
  imageComparisonConfig: z.unknown().nullable(),
  retentionDays: z.number().int().nonnegative().nullable(),
  diffThreshold: z.number().nullable(),
  l2Enabled: z.boolean(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const projectListResponse = z.array(projectResponse);

export async function registerProjectsRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.get("/projects", { preHandler: app.authenticate }, async (req, reply) => {
    if (!req.auth) {
      return reply.code(401).send({ error: "unauthenticated" });
    }
    if (req.auth.role === "guest") return [];
    if (req.auth.role === "admin") {
      return app.db.select().from(projects);
    }
    // editor — only member-of projects
    const memberRows = await app.db
      .select({ projectId: projectMembers.projectId })
      .from(projectMembers)
      .where(eq(projectMembers.userId, req.auth.id));
    if (memberRows.length === 0) return [];
    return app.db
      .select()
      .from(projects)
      .where(
        inArray(
          projects.id,
          memberRows.map((r) => r.projectId),
        ),
      );
  });

  app.post(
    "/projects",
    { preHandler: [app.authenticate, requireRole("admin")] },
    async (req, reply) => {
      const parsed = createBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_body" });
      }
      try {
        const [row] = await app.db
          .insert(projects)
          .values(parsed.data)
          .returning();
        return reply.code(201).send(row);
      } catch (err) {
        // UNIQUE violation on projects.name
        req.log.warn({ err }, "project_create_failed");
        return reply.code(409).send({ error: "project_name_taken" });
      }
    },
  );

  app.get(
    "/projects/:id",
    {
      preHandler: [
        app.authenticate,
        requireProjectMember("read", { from: { params: "id" } }),
      ],
    },
    async (req, reply) => {
      const parsed = paramsId.safeParse(req.params);
      if (!parsed.success) {
        return reply.code(404).send({ error: "not_found" });
      }
      const rows = await app.db
        .select()
        .from(projects)
        .where(eq(projects.id, parsed.data.id))
        .limit(1);
      if (!rows[0]) {
        return reply.code(404).send({ error: "not_found" });
      }
      return rows[0];
    },
  );
}
