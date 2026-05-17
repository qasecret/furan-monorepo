import { eq, projects } from "@furan/db";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import type { Context } from "../context.js";
import { authed } from "../middlewares/authed.js";
import { projectMember } from "../middlewares/project-member.js";
import { t } from "../trpc.js";

const projectIdInput = z.object({ projectId: z.string().uuid() });
type ProjectIdInput = z.infer<typeof projectIdInput>;

const updateInput = z.object({
  projectId: z.string().uuid(),
  name: z.string().min(1).max(120).optional(),
  mainBranchName: z.string().min(1).max(120).optional(),
  diffThreshold: z.number().min(0).max(1).optional(),
  l2Enabled: z.boolean().optional(),
  autoApproveFeature: z.boolean().optional(),
  retentionDays: z.number().int().min(1).max(3650).optional(),
  maxBuildAllowed: z.number().int().min(1).optional(),
  maxBranchLifetime: z.number().int().min(1).optional(),
  imageComparison: z.enum(["pixelmatch", "looks_same", "odiff"]).optional(),
  imageComparisonConfig: z.string().optional(),
});
type UpdateInput = z.infer<typeof updateInput>;

export const projectsRouter = t.router({
  /**
   * Fetch the project row by id. Authorization mirrors `members.list`:
   * admin-bypass, otherwise the caller must hold a `project_members` row.
   *
   * Note on `projectMember("read" | "write")`: the v1.0 middleware does not
   * differentiate actions — any project_members row grants read AND write.
   * The action label is kept for parity with the REST hook so a future
   * per-role split is a single-site change.
   */
  getById: t.procedure
    .input(projectIdInput)
    .use(authed)
    .use(
      projectMember<ProjectIdInput>("read", {
        from: {
          resolver: ({ input }: { input: ProjectIdInput; ctx: Context }) =>
            Promise.resolve(input.projectId),
        },
      }),
    )
    .query(async ({ input, ctx }) => {
      const rows = await ctx.db
        .select()
        .from(projects)
        .where(eq(projects.id, input.projectId))
        .limit(1);
      const project = rows[0];
      if (!project) throw new TRPCError({ code: "NOT_FOUND" });
      return project;
    }),

  /**
   * Partial update of the project row. All non-id fields are optional;
   * undefined entries are dropped so callers can submit just the columns
   * they want to change. Bumps `updatedAt` on every write.
   *
   * Authorization: admin-bypass OR project_members row (see note above
   * about `projectMember("write")` semantics).
   */
  update: t.procedure
    .input(updateInput)
    .use(authed)
    .use(
      projectMember<UpdateInput>("write", {
        from: {
          resolver: ({ input }: { input: UpdateInput; ctx: Context }) =>
            Promise.resolve(input.projectId),
        },
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const { projectId, ...rest } = input;
      const updates: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(rest)) {
        if (v !== undefined) updates[k] = v;
      }
      if (Object.keys(updates).length === 0) {
        const rows = await ctx.db
          .select()
          .from(projects)
          .where(eq(projects.id, projectId))
          .limit(1);
        const project = rows[0];
        if (!project) throw new TRPCError({ code: "NOT_FOUND" });
        return project;
      }
      updates.updatedAt = new Date();
      const updated = await ctx.db
        .update(projects)
        .set(updates)
        .where(eq(projects.id, projectId))
        .returning();
      if (!updated[0]) throw new TRPCError({ code: "NOT_FOUND" });
      return updated[0];
    }),
});
