import { baselines, desc, eq, projects, sql, testVariations } from "@furan/db";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import {
  mergeBranchBaselinesImpl,
  SameBranchError,
} from "../../lib/branch-merge.js";
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
  autoApproveFeature: z.boolean().optional(),
  retentionDays: z.number().int().min(1).max(3650).optional(),
  maxBuildAllowed: z.number().int().min(1).optional(),
  maxBranchLifetime: z.number().int().min(1).optional(),
  imageComparison: z
    .enum(["pixelmatch", "looks_same", "odiff", "vlm"])
    .optional(),
  imageComparisonConfig: z.string().optional(),
  dynamicTextEnabled: z.boolean().optional(),
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

  /**
   * Cross-branch baseline merge — promote every variation's `fromBranch`
   * baseline onto `toBranch` as a synthetic test run for reviewer approval.
   *
   * Mirrors the legacy `/test-variations/merge` endpoint's behavior: each
   * variation with a baseline on `fromBranch` produces a `merge=true` test
   * run on `toBranch` in a shared synthetic build. The diff worker then
   * runs the standard pipeline — byte-identical sources auto-approve via
   * ADR-032 and become the new toBranch baseline; divergent sources flip
   * the synthetic run to `unresolved` for explicit reviewer review.
   *
   * Spec: furan-design/specs/2026-05-24-cross-branch-baseline-merge-design.md
   */
  mergeBranchBaselines: t.procedure
    .input(
      z
        .object({
          projectId: z.string().uuid(),
          fromBranch: z.string().min(1).max(255),
          toBranch: z.string().min(1).max(255),
        })
        .refine((v) => v.fromBranch !== v.toBranch, {
          message: "same_branch: fromBranch and toBranch must differ",
          path: ["toBranch"],
        }),
    )
    .use(authed)
    .use(
      projectMember<{ projectId: string }>("write", {
        from: {
          resolver: ({
            input,
          }: {
            input: { projectId: string };
            ctx: Context;
          }) => Promise.resolve(input.projectId),
        },
      }),
    )
    .mutation(async ({ input, ctx }) => {
      try {
        return await mergeBranchBaselinesImpl(input, {
          db: ctx.db,
          diffQueue: ctx.diffQueue,
          telemetry: ctx.telemetry,
          broadcaster: ctx.broadcaster,
          userId: ctx.user?.id ?? null,
          log: ctx.req.log,
        });
      } catch (err) {
        if (err instanceof SameBranchError) {
          throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
        }
        throw err;
      }
    }),

  /**
   * Distinct `branchName` values that have at least one `baselines` row for
   * the project, ordered by most-recent activity. Drives the merge-baselines
   * panel's branch selectors so the reviewer only picks from branches that
   * actually have approved baselines to promote.
   *
   * Uses MAX(createdAt) ordering rather than alphabetical because reviewers
   * almost always want to merge their most-recent feature branch first.
   */
  listBranches: t.procedure
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
        .select({
          branchName: baselines.branchName,
          latestAt: sql<Date>`max(${baselines.createdAt})`.as("latest_at"),
        })
        .from(baselines)
        .innerJoin(
          testVariations,
          eq(testVariations.id, baselines.testVariationId),
        )
        .where(eq(testVariations.projectId, input.projectId))
        .groupBy(baselines.branchName)
        .orderBy(desc(sql`max(${baselines.createdAt})`));
      return rows.map((r) => r.branchName);
    }),
});
