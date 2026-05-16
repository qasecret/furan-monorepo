import {
  baselines,
  diffRegions,
  eq,
  projects,
  resolveBaseline,
  screenshots,
  testRuns,
} from "@furan/db";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import type { Context } from "../context.js";
import { authed } from "../middlewares/authed.js";
import { projectMember } from "../middlewares/project-member.js";
import { t } from "../trpc.js";

const runIdInput = z.object({ runId: z.string().uuid() });
type RunIdInput = z.infer<typeof runIdInput>;

async function resolveRunProjectId(
  input: RunIdInput,
  ctx: Context,
): Promise<string | null> {
  const rows = await ctx.db
    .select({ projectId: testRuns.projectId })
    .from(testRuns)
    .where(eq(testRuns.id, input.runId))
    .limit(1);
  return rows[0]?.projectId ?? null;
}

export const runsRouter = t.router({
  getById: t.procedure
    .input(runIdInput)
    .use(authed)
    .use(
      projectMember<RunIdInput>("read", {
        from: {
          resolver: ({ input, ctx }) => resolveRunProjectId(input, ctx),
        },
      }),
    )
    .query(async ({ input, ctx }) => {
      const runRows = await ctx.db
        .select()
        .from(testRuns)
        .where(eq(testRuns.id, input.runId))
        .limit(1);
      const run = runRows[0];
      if (!run) throw new TRPCError({ code: "NOT_FOUND" });

      const shots = await ctx.db
        .select()
        .from(screenshots)
        .where(eq(screenshots.runId, input.runId));
      const regions = await ctx.db
        .select()
        .from(diffRegions)
        .where(eq(diffRegions.runId, input.runId));

      // Resolve the baseline screenshot for the BASELINE pane of the viewer.
      // T9: dashboard side-by-side / overlay / onion-skin all need the
      // baseline's screenshot row (its imageKey). Reuse the three-tier
      // resolver from @furan/db so we stay consistent with the diff worker.
      let baselineScreenshot: (typeof shots)[number] | null = null;
      let baselineSource: string | null = null;
      try {
        const projectRows = await ctx.db
          .select({ mainBranchName: projects.mainBranchName })
          .from(projects)
          .where(eq(projects.id, run.projectId))
          .limit(1);
        const defaultBranch = projectRows[0]?.mainBranchName ?? "main";

        const resolution = await resolveBaseline(
          ctx.db,
          run.projectId,
          run.branchName ?? defaultBranch,
          run.testVariationId,
          { defaultBranch },
        );

        if (resolution) {
          baselineSource = resolution.source;
          const baselineRows = await ctx.db
            .select({ testRunId: baselines.testRunId })
            .from(baselines)
            .where(eq(baselines.id, resolution.baselineId))
            .limit(1);
          const baselineRunId = baselineRows[0]?.testRunId;
          if (baselineRunId) {
            const blShots = await ctx.db
              .select()
              .from(screenshots)
              .where(eq(screenshots.runId, baselineRunId));
            baselineScreenshot = blShots[0] ?? null;
          }
        }
      } catch (err) {
        // Baseline resolution is informational; don't fail getById on it.
        ctx.telemetry.logger.warn(
          { err, runId: run.id },
          "baseline_screenshot_lookup_failed",
        );
      }

      return {
        ...run,
        screenshots: shots,
        diffRegions: regions,
        baselineScreenshot,
        baselineSource,
      };
    }),

  approve: t.procedure
    .input(runIdInput)
    .use(authed)
    .use(
      projectMember<RunIdInput>("write", {
        from: {
          resolver: ({ input, ctx }) => resolveRunProjectId(input, ctx),
        },
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const runRows = await ctx.db
        .select()
        .from(testRuns)
        .where(eq(testRuns.id, input.runId))
        .limit(1);
      const run = runRows[0];
      if (!run) throw new TRPCError({ code: "NOT_FOUND" });

      await ctx.db
        .update(testRuns)
        .set({ merge: true })
        .where(eq(testRuns.id, input.runId));

      // Snapshot the approved run into baselines (branch-scoped, §4.7).
      await ctx.db.insert(baselines).values({
        baselineName: run.baselineName ?? run.name ?? "auto",
        testVariationId: run.testVariationId,
        testRunId: run.id,
        userId: ctx.user.id,
        ...(run.branchName ? { branchName: run.branchName } : {}),
      });

      return { runId: run.id, approved: true };
    }),

  reject: t.procedure
    .input(runIdInput)
    .use(authed)
    .use(
      projectMember<RunIdInput>("write", {
        from: {
          resolver: ({ input, ctx }) => resolveRunProjectId(input, ctx),
        },
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const runRows = await ctx.db
        .select()
        .from(testRuns)
        .where(eq(testRuns.id, input.runId))
        .limit(1);
      const run = runRows[0];
      if (!run) throw new TRPCError({ code: "NOT_FOUND" });

      await ctx.db
        .update(testRuns)
        .set({ merge: false })
        .where(eq(testRuns.id, input.runId));

      return { runId: run.id, approved: false };
    }),
});
