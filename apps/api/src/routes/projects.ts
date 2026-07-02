import { asc, eq, inArray, projectMembers, projects } from "@furan/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { requireProjectMember } from "../hooks/require-project-member.js";
import { requireRole } from "../hooks/require-role.js";
import {
  mergeBranchBaselinesImpl,
  SameBranchError,
} from "../lib/branch-merge.js";
import { sendError } from "../lib/errors.js";
import { isAtLeastAdmin } from "../lib/roles.js";
import { withRequestScope } from "../lib/with-request-scope.js";

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
      return sendError(reply, 401, "unauthenticated");
    }
    if (req.auth.role === "guest") return [];
    const auth = req.auth;
    return withRequestScope(app, req, async (db) => {
      if (isAtLeastAdmin(auth.role)) {
        return db.select().from(projects).orderBy(asc(projects.name));
      }
      // editor — only member-of projects
      const memberRows = await db
        .select({ projectId: projectMembers.projectId })
        .from(projectMembers)
        .where(eq(projectMembers.userId, auth.id));
      if (memberRows.length === 0) return [];
      return db
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
  });

  app.post(
    "/projects",
    { preHandler: [app.authenticate, requireRole("admin")] },
    async (req, reply) => {
      const parsed = createBody.safeParse(req.body);
      if (!parsed.success) {
        return sendError(reply, 400, "invalid_body");
      }
      const creatorId = req.auth!.id;
      // The scope transaction IS the atomic unit (project + member insert).
      // `ON CONFLICT DO NOTHING RETURNING` on projects.name gives a clean 409
      // without catching a failed INSERT (which would poison the transaction);
      // any other failure surfaces as a real 500.
      return withRequestScope(app, req, async (db) => {
        const inserted = await db
          .insert(projects)
          .values(parsed.data)
          .onConflictDoNothing()
          .returning();
        const created = inserted[0];
        if (!created) {
          req.log.warn({ name: parsed.data.name }, "project_create_conflict");
          return sendError(reply, 409, "project_name_taken");
        }
        // Auto-add the creator as a project member with write access.
        // Admins already bypass the membership gate everywhere, but the row
        // materializes their relationship for: (a) the project's member list
        // under /admin/projects/:id/members, (b) the RLS flip (ADR-058) where
        // admin-bypass is on a separate axis, (c) less-than-admin co-creators
        // in environments that drop a user to editor post-bootstrap.
        await db
          .insert(projectMembers)
          .values({ projectId: created.id, userId: creatorId })
          .onConflictDoNothing();
        // Set status + RETURN the row so Fastify sends it AFTER the scope
        // commits (a client that reads the project right after must see it).
        reply.code(201);
        return created;
      });
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
        return sendError(reply, 404, "not_found");
      }
      return withRequestScope(
        app,
        req,
        async (db) => {
          const rows = await db
            .select()
            .from(projects)
            .where(eq(projects.id, parsed.data.id))
            .limit(1);
          if (!rows[0]) {
            return sendError(reply, 404, "not_found");
          }
          return rows[0];
        },
        parsed.data.id,
      );
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
        return sendError(reply, 404, "not_found");
      }
      const body = mergeBody.safeParse(req.body);
      if (!body.success) {
        return sendError(reply, 400, "invalid_body");
      }
      try {
        const result = await withRequestScope(
          app,
          req,
          (db, onCommit) =>
            mergeBranchBaselinesImpl(
              {
                projectId: params.data.id,
                fromBranch: body.data.fromBranch,
                toBranch: body.data.toBranch,
              },
              {
                db,
                diffQueue: app.diffQueue,
                telemetry: app.telemetry,
                broadcaster: app.broadcaster,
                userId: req.auth?.id ?? null,
                log: req.log,
                onCommit,
              },
            ),
          params.data.id,
        );
        return reply.code(200).send(result);
      } catch (err) {
        if (err instanceof SameBranchError) {
          return sendError(reply, 400, "same_branch");
        }
        throw err;
      }
    },
  );
}
