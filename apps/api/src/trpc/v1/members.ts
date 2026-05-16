import { and, asc, eq, projectMembers, users } from "@furan/db";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import type { Context } from "../context.js";
import { requireAdmin } from "../middlewares/admin.js";
import { authed } from "../middlewares/authed.js";
import { projectMember } from "../middlewares/project-member.js";
import { t } from "../trpc.js";

const projectIdInput = z.object({ projectId: z.string().uuid() });
type ProjectIdInput = z.infer<typeof projectIdInput>;

export const membersRouter = t.router({
  /**
   * List project_members for `projectId`, joined with `users` so the UI can
   * render email + role without a second roundtrip. Authorization mirrors
   * other read procedures: admin bypass, else project_members lookup.
   */
  list: t.procedure
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
      return ctx.db
        .select({
          id: projectMembers.id,
          userId: projectMembers.userId,
          createdAt: projectMembers.createdAt,
          email: users.email,
          role: users.role,
        })
        .from(projectMembers)
        .innerJoin(users, eq(projectMembers.userId, users.id))
        .where(eq(projectMembers.projectId, input.projectId))
        .orderBy(asc(users.email));
    }),

  /**
   * Admin-only: look up the user by email, verify they hold the `editor`
   * role, then insert `(project_id, user_id)`. Duplicate inserts surface as
   * Postgres `23505` (unique violation) → CONFLICT.
   */
  add: t.procedure
    .input(
      z.object({
        projectId: z.string().uuid(),
        email: z.string().email(),
      }),
    )
    .use(authed)
    .use(requireAdmin)
    .mutation(async ({ input, ctx }) => {
      const userRows = await ctx.db
        .select({ id: users.id, role: users.role })
        .from(users)
        .where(eq(users.email, input.email))
        .limit(1);
      const targetUser = userRows[0];
      if (!targetUser) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "no_user_with_that_email",
        });
      }
      if (targetUser.role !== "editor") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "user_must_be_editor_role",
        });
      }

      try {
        await ctx.db.insert(projectMembers).values({
          projectId: input.projectId,
          userId: targetUser.id,
        });
      } catch (err) {
        // postgres-js surfaces unique violations as `code: "23505"`.
        if ((err as { code?: string })?.code === "23505") {
          throw new TRPCError({
            code: "CONFLICT",
            message: "already_a_member",
          });
        }
        throw err;
      }

      return { added: true };
    }),

  /**
   * Admin-only: idempotent delete of `(project_id, user_id)`.
   */
  remove: t.procedure
    .input(
      z.object({
        projectId: z.string().uuid(),
        userId: z.string().uuid(),
      }),
    )
    .use(authed)
    .use(requireAdmin)
    .mutation(async ({ input, ctx }) => {
      await ctx.db
        .delete(projectMembers)
        .where(
          and(
            eq(projectMembers.projectId, input.projectId),
            eq(projectMembers.userId, input.userId),
          ),
        );
      return { removed: true };
    }),
});
