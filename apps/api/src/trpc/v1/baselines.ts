import { baselines, desc, eq, testVariations, users } from "@furan/db";
import { z } from "zod";

import { authed } from "../middlewares/authed.js";
import { projectMember } from "../middlewares/project-member.js";
import { t } from "../trpc.js";

const listInput = z.object({
  testVariationId: z.string().uuid(),
  limit: z.number().int().min(1).max(100).default(50),
});

export const baselinesRouter = t.router({
  listForVariation: t.procedure
    .input(listInput)
    .use(authed)
    // Resolve the projectId via the variation so we can reuse the
    // existing projectMember(read) middleware. One extra round-trip
    // but cheap (PK lookup) and avoids inventing a variation-member
    // middleware just for this.
    .use(
      projectMember<{ testVariationId: string; limit: number }>("read", {
        from: {
          resolver: async ({ input, ctx }) => {
            const rows = await ctx.db
              .select({ projectId: testVariations.projectId })
              .from(testVariations)
              .where(eq(testVariations.id, input.testVariationId))
              .limit(1);
            return rows[0]?.projectId ?? null;
          },
        },
      }),
    )
    .query(async ({ input, ctx }) => {
      const rows = await ctx.db
        .select({
          id: baselines.id,
          baselineName: baselines.baselineName,
          testRunId: baselines.testRunId,
          userId: baselines.userId,
          environment: baselines.environment,
          branchName: baselines.branchName,
          createdAt: baselines.createdAt,
          // Pull the approver's email for display. userId IS NULL is
          // the auto-approve signal (per diff-worker handler comment).
          approverEmail: users.email,
        })
        .from(baselines)
        .leftJoin(users, eq(users.id, baselines.userId))
        .where(eq(baselines.testVariationId, input.testVariationId))
        .orderBy(desc(baselines.createdAt))
        .limit(input.limit);

      return {
        items: rows.map((r) => ({
          ...r,
          createdAt: r.createdAt.toISOString(),
          isAuto: r.userId === null,
        })),
      };
    }),
});
