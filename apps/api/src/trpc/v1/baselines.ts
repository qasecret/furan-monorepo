import { baselines, desc, eq, sql, testVariations, users } from "@furan/db";
import { z } from "zod";

import { authed } from "../middlewares/authed.js";
import { projectMember } from "../middlewares/project-member.js";
import { publicProcedure, t } from "../trpc.js";

const listInput = z.object({
  testVariationId: z.string().uuid(),
  limit: z.number().int().min(1).max(100).default(50),
});

export const baselinesRouter = t.router({
  listForVariation: publicProcedure
    .input(listInput)
    .use(authed)
    // Resolve the projectId via the variation so we can reuse the
    // existing projectMember(read) middleware: a PK lookup the gate runs
    // inside its own statement, which avoids inventing a variation-member
    // middleware just for this.
    .use(
      projectMember<{ testVariationId: string; limit: number }>("read", {
        from: {
          query: ({ input }) =>
            sql`SELECT ${testVariations.projectId} FROM ${testVariations}
              WHERE ${testVariations.id} = ${input.testVariationId} LIMIT 1`,
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
        .orderBy(desc(baselines.createdAt), desc(baselines.id))
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
