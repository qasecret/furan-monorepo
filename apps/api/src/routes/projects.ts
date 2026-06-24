import { asc, eq, inArray, projectMembers, projects } from "@furan/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { requireProjectMember } from "../hooks/require-project-member.js";
import { requireRole } from "../hooks/require-role.js";
import {
  mergeBranchBaselinesImpl,
  SameBranchError,
} from "../lib/branch-merge.js";

export const mergeBody = z.object({
  fromBranch: z.string().min(1).max(255),
  toBranch: z.string().min(1).max(255),
});

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
      return app.db.select().from(projects).orderBy(asc(projects.name));
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
      )
      .orderBy(asc(projects.name));
  });

  app.post(
    "/projects",
    { preHandler: [app.authenticate, requireRole("admin")] },
    async (req, reply) => {
      const parsed = createBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_body" });
      }
      const creatorId = req.auth!.id;
      try {
        const row = await app.db.transaction(async (tx) => {
          const inserted = await tx
            .insert(projects)
            .values(parsed.data)
            .returning();
          const created = inserted[0];
          if (!created) {
            throw new Error("project insert returned no rows");
          }
          // Auto-add the creator as a project member with write access.
          // Admins already bypass the membership gate everywhere, but the
          // row materializes their relationship for: (a) the project's
          // member list under /admin/projects/:id/members, (b) the future
          // RLS flip (ADR-022) where admin-bypass is on a separate axis,
          // (c) less-than-admin co-creators in environments that drop a
          // user to editor post-bootstrap.
          await tx
            .insert(projectMembers)
            .values({ projectId: created.id, userId: creatorId })
            .onConflictDoNothing();
          return created;
        });
        return reply.code(201).send(row);
      } catch (err) {
        // Only a Postgres unique violation (23505) on projects.name is a
        // real "name taken". postgres-js surfaces the code on the error;
        // drizzle-orm >=0.40 wraps the original PostgresError as `cause`
        // (same detection as members.ts). Any other failure — schema drift,
        // FK, etc. — must surface as a real error, not be masked as a 409.
        const outerCode = (err as { code?: string })?.code;
        const causeCode = (err as { cause?: { code?: string } })?.cause?.code;
        if (outerCode === "23505" || causeCode === "23505") {
          req.log.warn({ err }, "project_create_conflict");
          return reply.code(409).send({ error: "project_name_taken" });
        }
        req.log.error({ err }, "project_create_failed");
        throw err;
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

  /**
   * Cross-branch baseline merge — REST surface for the GitHub App
   * webhook + any HTTP-only consumer. Delegates to the same
   * `mergeBranchBaselinesImpl` helper as the tRPC mutation so both
   * surfaces stay in lock-step.
   *
   * Body: { fromBranch, toBranch }
   * Auth: project_members write action (admin bypasses).
   *
   * Why POST, not GET (legacy used GET): this is a mutation — creates a
   * synthetic build + a fan-out of test_runs + enqueues N diff jobs.
   * Legacy's NestJS controller used `@Get('merge/')` which was incorrect
   * REST shape; the rewrite fixes it.
   */
  app.post(
    "/projects/:id/merge",
    {
      preHandler: [
        app.authenticate,
        requireProjectMember("write", { from: { params: "id" } }),
      ],
    },
    async (req, reply) => {
      const params = paramsId.safeParse(req.params);
      if (!params.success) {
        return reply.code(404).send({ error: "not_found" });
      }
      const body = mergeBody.safeParse(req.body);
      if (!body.success) {
        return reply.code(400).send({ error: "invalid_body" });
      }
      try {
        const result = await mergeBranchBaselinesImpl(
          {
            projectId: params.data.id,
            fromBranch: body.data.fromBranch,
            toBranch: body.data.toBranch,
          },
          {
            db: app.db,
            diffQueue: app.diffQueue,
            telemetry: app.telemetry,
            broadcaster: app.broadcaster,
            userId: req.auth?.id ?? null,
            log: req.log,
          },
        );
        return reply.code(200).send(result);
      } catch (err) {
        if (err instanceof SameBranchError) {
          return reply.code(400).send({ error: "same_branch" });
        }
        throw err;
      }
    },
  );
}
