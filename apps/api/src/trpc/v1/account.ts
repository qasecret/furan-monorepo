import { eq, users } from "@furan/db";
import { z } from "zod";

import { authed } from "../middlewares/authed.js";
import { projectMember } from "../middlewares/project-member.js";
import { t } from "../trpc.js";

export const accountRouter = t.router({
  /**
   * Sets the caller's per-user default project. Membership-gated via the
   * shared `projectMember` middleware (admin bypass; editor must be a member;
   * guest rejected) so a user can only default to a project they can access.
   */
  setDefaultProject: t.procedure
    .input(z.object({ projectId: z.string().uuid() }))
    .use(authed)
    .use(
      projectMember<{ projectId: string }>("read", {
        from: { resolver: async ({ input }) => input.projectId },
      }),
    )
    .mutation(async ({ input, ctx }) => {
      await ctx.db
        .update(users)
        .set({ defaultProjectId: input.projectId })
        .where(eq(users.id, ctx.user.id));
      return { ok: true as const };
    }),
});
