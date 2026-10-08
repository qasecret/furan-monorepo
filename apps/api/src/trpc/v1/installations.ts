import { asc, eq, installations, projects } from "@furan/db";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { requireAdmin } from "../middlewares/admin.js";
import { authed } from "../middlewares/authed.js";
import { publicProcedure, t } from "../trpc.js";

/**
 * Admin-only router for the `/admin/installations` UI (D6(f)).
 *
 * Replaces the manual `UPDATE installations SET project_id = ...` step
 * previously documented in `docs/integrations/github-actions.md` §2: an
 * admin can list known GitHub App installations and link each one to a
 * Furan project so the run-events consumer can route the installation's
 * webhook events into the right project.
 */
export const installationsRouter = t.router({
  /**
   * Admin-only: list every installation row (sorted oldest-first so the UI
   * order is stable) alongside every project (sorted by name so the row's
   * project picker has a predictable ordering).
   */
  list: publicProcedure
    .use(authed)
    .use(requireAdmin)
    .query(async ({ ctx }) => {
      const installationRows = await ctx.db
        .select({
          id: installations.id,
          installationId: installations.installationId,
          accountLogin: installations.accountLogin,
          repositoryIds: installations.repositoryIds,
          projectId: installations.projectId,
          createdAt: installations.createdAt,
        })
        .from(installations)
        .orderBy(asc(installations.createdAt));
      const projectRows = await ctx.db
        .select({ id: projects.id, name: projects.name })
        .from(projects)
        .orderBy(asc(projects.name));
      return { installations: installationRows, projects: projectRows };
    }),

  /**
   * Admin-only: set or clear an installation's `project_id`. We
   * explicitly look up the row first so a typo'd UUID surfaces as
   * NOT_FOUND with a useful message instead of a silent no-op.
   */
  update: publicProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        projectId: z.string().uuid().nullable(),
      }),
    )
    .use(authed)
    .use(requireAdmin)
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.db
        .select({ id: installations.id })
        .from(installations)
        .where(eq(installations.id, input.id))
        .limit(1);
      if (existing.length === 0) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "installation_not_found",
        });
      }
      await ctx.db
        .update(installations)
        .set({ projectId: input.projectId, updatedAt: new Date() })
        .where(eq(installations.id, input.id));
      return { ok: true };
    }),
});
