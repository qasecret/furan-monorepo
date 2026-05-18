import {
  and,
  baselines,
  desc,
  diffRegions,
  eq,
  lt,
  projects,
  resolveBaseline,
  screenshots,
  testRuns,
  testVariations,
} from "@furan/db";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import type { Context } from "../context.js";
import { authed } from "../middlewares/authed.js";
import { projectMember } from "../middlewares/project-member.js";
import { t } from "../trpc.js";

const runIdInput = z.object({ runId: z.string().uuid() });
type RunIdInput = z.infer<typeof runIdInput>;

type IgnoreRegion = {
  x: number;
  y: number;
  width: number;
  height: number;
  viewport?: string;
};

const listInput = z.object({
  projectId: z.string().uuid(),
  cursor: z.string().datetime().optional(),
  limit: z.number().int().min(1).max(100).default(25),
  /** Exact-match filter on `test_runs.branch_name`. */
  branch: z.string().min(1).max(255).optional(),
  /**
   * Exact-match filter on `test_runs.status`. The column is free-form `text`
   * (not a pgEnum), so we accept any short string here and let the DB return
   * an empty page for unknown values rather than rejecting at the boundary.
   * Known values across the codebase: "new" | "ok" | "running" | "passed" |
   * "failed". Task 9 should constrain to that union at the UI layer.
   */
  status: z.string().min(1).max(32).optional(),
});
type ListInput = z.infer<typeof listInput>;

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
  /**
   * Cursor-paginated run listing for the dashboard index page (T9).
   * Order: `desc(created_at)`. Cursor is the `created_at` (ISO string) of
   * the last item from the previous page; we fetch `limit + 1` rows and use
   * the extra row to decide whether `nextCursor` should be set.
   */
  list: t.procedure
    .input(listInput)
    .use(authed)
    .use(
      projectMember<ListInput>("read", {
        from: {
          resolver: ({ input }: { input: ListInput; ctx: Context }) =>
            Promise.resolve(input.projectId),
        },
      }),
    )
    .query(async ({ input, ctx }) => {
      const conditions = [eq(testRuns.projectId, input.projectId)];
      if (input.cursor) {
        conditions.push(lt(testRuns.createdAt, new Date(input.cursor)));
      }
      if (input.branch) {
        conditions.push(eq(testRuns.branchName, input.branch));
      }
      if (input.status) {
        conditions.push(eq(testRuns.status, input.status));
      }

      const rows = await ctx.db
        .select()
        .from(testRuns)
        .where(and(...conditions))
        .orderBy(desc(testRuns.createdAt))
        .limit(input.limit + 1);

      const hasMore = rows.length > input.limit;
      const items = hasMore ? rows.slice(0, input.limit) : rows;
      const last = items[items.length - 1];
      const nextCursor = hasMore && last ? last.createdAt.toISOString() : null;
      return { items, nextCursor };
    }),

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

      // Fetch the variation's ignore areas for the diff viewer's region editor.
      // Returned as a parsed array; null when the column is unset or malformed.
      const variationRows = await ctx.db
        .select({ ignoreAreas: testVariations.ignoreAreas })
        .from(testVariations)
        .where(eq(testVariations.id, run.testVariationId))
        .limit(1);
      const variationIgnoreAreasRaw = variationRows[0]?.ignoreAreas ?? null;
      let variationIgnoreAreas: IgnoreRegion[] | null = null;
      if (variationIgnoreAreasRaw) {
        try {
          const parsed = JSON.parse(variationIgnoreAreasRaw);
          if (Array.isArray(parsed)) {
            variationIgnoreAreas = parsed as IgnoreRegion[];
          }
        } catch {
          // malformed JSON → treat as null
        }
      }

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
        variationIgnoreAreas,
      };
    }),

  setComment: t.procedure
    .input(
      z.object({
        runId: z.string().uuid(),
        comment: z.string().max(10_000).nullable(),
      }),
    )
    .use(authed)
    .use(
      projectMember<RunIdInput>("write", {
        from: {
          resolver: ({ input, ctx }) =>
            resolveRunProjectId({ runId: input.runId }, ctx),
        },
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const updated = await ctx.db
        .update(testRuns)
        .set({ comment: input.comment, updatedAt: new Date() })
        .where(eq(testRuns.id, input.runId))
        .returning({ id: testRuns.id, comment: testRuns.comment });
      const row = updated[0];
      if (!row) throw new TRPCError({ code: "NOT_FOUND" });
      return { runId: row.id, comment: row.comment };
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
