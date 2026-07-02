import { and, asc, eq, projectMembers, users } from "@furan/db";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { emitAudit } from "../../lib/emit-audit.js";
import { isOwner } from "../../lib/roles.js";
import type { Context } from "../context.js";
import { requireAdmin } from "../middlewares/admin.js";
import { authed } from "../middlewares/authed.js";
import { projectMember } from "../middlewares/project-member.js";
import { publicProcedure, t } from "../trpc.js";

const projectIdInput = z.object({ projectId: z.string().uuid() });
type ProjectIdInput = z.infer<typeof projectIdInput>;

export const membersRouter = t.router({
  /**
   * List project_members for `projectId`, joined with `users` so the UI can
   * render email + role without a second roundtrip. Authorization mirrors
   * other read procedures: admin bypass, else project_members lookup.
   */
  list: publicProcedure
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
  add: publicProcedure
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

      // `ON CONFLICT DO NOTHING RETURNING` instead of catch-the-unique-
      // violation: catching a failed INSERT would poison the surrounding
      // per-request transaction (ADR-058 scoping), and this is also race-free.
      // An empty result means the (project_id, user_id) row already existed.
      const inserted = await ctx.db
        .insert(projectMembers)
        .values({ projectId: input.projectId, userId: targetUser.id })
        .onConflictDoNothing()
        .returning({ id: projectMembers.id });
      if (inserted.length === 0) {
        throw new TRPCError({ code: "CONFLICT", message: "already_a_member" });
      }

      // New membership → invalidate the cached set so it's visible next request.
      await ctx.req.server.memberProjectsCache?.del(targetUser.id);
      await emitAudit(
        ctx.db,
        {
          actorId: ctx.user.id,
          action: "member.add",
          targetType: "project",
          targetId: input.projectId,
          metadata: { userId: targetUser.id, email: input.email },
        },
        ctx.req.log,
      );
      return { added: true };
    }),

  /**
   * Admin-only: idempotent delete of `(project_id, user_id)`.
   */
  remove: publicProcedure
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
      // Invalidate the member-project cache so revoked access takes effect on
      // the target's next request rather than after the 30s TTL (ADR-058).
      await ctx.req.server.memberProjectsCache?.del(input.userId);
      await emitAudit(
        ctx.db,
        {
          actorId: ctx.user.id,
          action: "member.remove",
          targetType: "project",
          targetId: input.projectId,
          metadata: { userId: input.userId },
        },
        ctx.req.log,
      );
      return { removed: true };
    }),

  /** Admin-only: the project ids a user belongs to (for the assignment panel). */
  listUserProjects: publicProcedure
    .input(z.object({ userId: z.string().uuid() }))
    .use(authed)
    .use(requireAdmin)
    .query(async ({ input, ctx }) => {
      const rows = await ctx.db
        .select({ projectId: projectMembers.projectId })
        .from(projectMembers)
        .where(eq(projectMembers.userId, input.userId));
      return rows.map((r) => r.projectId);
    }),

  /**
   * Admin-only: reconcile a user's project memberships to exactly `projectIds`
   * and set their default landing project. `defaultProjectId` must be one of
   * `projectIds` (or null). Atomic.
   */
  setUserProjects: publicProcedure
    .input(
      z.object({
        userId: z.string().uuid(),
        projectIds: z.array(z.string().uuid()),
        defaultProjectId: z.string().uuid().nullable(),
      }),
    )
    .use(authed)
    .use(requireAdmin)
    .mutation(async ({ input, ctx }) => {
      if (
        input.defaultProjectId !== null &&
        !input.projectIds.includes(input.defaultProjectId)
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "default_must_be_one_of_assigned_projects",
        });
      }
      const target = (
        await ctx.db
          .select({ id: users.id, role: users.role })
          .from(users)
          .where(eq(users.id, input.userId))
          .limit(1)
      )[0];
      if (!target) {
        throw new TRPCError({ code: "NOT_FOUND", message: "no_such_user" });
      }
      // Owner-protection (separation of duties): only an owner may rewrite an
      // owner's project memberships / default project — parallels the
      // owner_protected rule on PATCH /users/:id.
      if (isOwner(target.role) && !isOwner(ctx.user.role)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "owner_protected" });
      }

      try {
        await ctx.db.transaction(async (tx) => {
          const existing = await tx
            .select({ projectId: projectMembers.projectId })
            .from(projectMembers)
            .where(eq(projectMembers.userId, input.userId));
          const have = new Set(existing.map((r) => r.projectId));
          const want = new Set(input.projectIds);
          // Dedup via `want` so a repeated id can't insert a duplicate
          // (user_id, project_id) row and trip the unique constraint.
          const toAdd = [...want].filter((id) => !have.has(id));
          const toRemove = [...have].filter((id) => !want.has(id));

          for (const projectId of toRemove) {
            await tx
              .delete(projectMembers)
              .where(
                and(
                  eq(projectMembers.userId, input.userId),
                  eq(projectMembers.projectId, projectId),
                ),
              );
          }
          if (toAdd.length > 0) {
            await tx
              .insert(projectMembers)
              .values(
                toAdd.map((projectId) => ({ userId: input.userId, projectId })),
              );
          }
          await tx
            .update(users)
            .set({ defaultProjectId: input.defaultProjectId })
            .where(eq(users.id, input.userId));
        });
      } catch (err) {
        // FK (23503: a projectId that doesn't exist) and unique (23505)
        // violations surface via `code`; drizzle wraps the PostgresError as
        // `cause` — mirror the `add` handler and translate to clean 4xx.
        const outerCode = (err as { code?: string })?.code;
        const causeCode = (err as { cause?: { code?: string } })?.cause?.code;
        if (outerCode === "23503" || causeCode === "23503") {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "unknown_project_id",
          });
        }
        if (outerCode === "23505" || causeCode === "23505") {
          throw new TRPCError({
            code: "CONFLICT",
            message: "already_a_member",
          });
        }
        throw err;
      }
      // Membership set changed → drop the cached member-project set (ADR-058).
      await ctx.req.server.memberProjectsCache?.del(input.userId);
      await emitAudit(
        ctx.db,
        {
          actorId: ctx.user.id,
          action: "member.set_projects",
          targetType: "user",
          targetId: input.userId,
          metadata: {
            projectIds: input.projectIds,
            defaultProjectId: input.defaultProjectId,
          },
        },
        ctx.req.log,
      );
      return { ok: true };
    }),
});
