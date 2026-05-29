import {
  and,
  builds,
  desc,
  eq,
  ilike,
  inArray,
  lt,
  screenshots,
  sql,
  testRuns,
  testVariations,
} from "@furan/db";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { authed } from "../middlewares/authed.js";
import { projectMember } from "../middlewares/project-member.js";
import { t } from "../trpc.js";

const getInput = z.object({
  projectId: z.string().uuid(),
  variationId: z.string().uuid(),
});
type GetInput = z.infer<typeof getInput>;

const historyInput = z.object({
  projectId: z.string().uuid(),
  variationId: z.string().uuid(),
  cursor: z.string().datetime().optional(),
  limit: z.number().int().min(1).max(100).default(25),
});
type HistoryInput = z.infer<typeof historyInput>;

const listInput = z.object({
  projectId: z.string().uuid(),
  search: z.string().max(120).optional(),
  cursor: z.string().datetime().optional(),
  limit: z.number().int().min(1).max(100).default(25),
});
type ListInput = z.infer<typeof listInput>;

export const variationsRouter = t.router({
  /**
   * Cursor-paginated list of variations for a project, newest-first.
   *
   * Feeds the project-level /variations index page so reviewers can
   * browse every test checkpoint the SDK has registered, search by
   * name, and drill into the per-variation history. The createdAt
   * cursor mirrors `runs.list`.
   *
   * `search`, when present, ILIKE-matches the variation name on the
   * fly. The substring filter is intentional — variation names land
   * via the SDK and we don't expect curated taxonomies, so prefix-only
   * search would miss the common case ("payment" matching
   * "checkout-payment-step").
   */
  list: t.procedure
    .input(listInput)
    .use(authed)
    .use(
      projectMember<ListInput>("read", {
        from: { resolver: ({ input }) => Promise.resolve(input.projectId) },
      }),
    )
    .query(async ({ input, ctx }) => {
      const conditions = [eq(testVariations.projectId, input.projectId)];
      if (input.search && input.search.trim().length > 0) {
        conditions.push(ilike(testVariations.name, `%${input.search.trim()}%`));
      }
      if (input.cursor) {
        conditions.push(lt(testVariations.createdAt, new Date(input.cursor)));
      }
      const rows = await ctx.db
        .select({
          id: testVariations.id,
          name: testVariations.name,
          branchName: testVariations.branchName,
          browser: testVariations.browser,
          viewport: testVariations.viewport,
          os: testVariations.os,
          device: testVariations.device,
          baselineName: testVariations.baselineName,
          createdAt: testVariations.createdAt,
        })
        .from(testVariations)
        .where(and(...conditions))
        .orderBy(desc(testVariations.createdAt))
        .limit(input.limit + 1);
      const hasMore = rows.length > input.limit;
      const items = hasMore ? rows.slice(0, input.limit) : rows;
      const last = items[items.length - 1];
      const nextCursor = hasMore && last ? last.createdAt.toISOString() : null;
      return { items, nextCursor };
    }),

  /**
   * Variation identity + total run count. Used to render the history-page
   * header (name · browser · viewport · totalRuns).
   *
   * Cross-tenant safety: WHERE clause AND-joins (id, projectId) so a member
   * of project A cannot probe variation ids in project B. Combined with the
   * projectMember middleware, the procedure is project-tenant-safe.
   */
  get: t.procedure
    .input(getInput)
    .use(authed)
    .use(
      projectMember<GetInput>("read", {
        from: { resolver: ({ input }) => Promise.resolve(input.projectId) },
      }),
    )
    .query(async ({ input, ctx }) => {
      const rows = await ctx.db
        .select()
        .from(testVariations)
        .where(
          and(
            eq(testVariations.id, input.variationId),
            eq(testVariations.projectId, input.projectId),
          ),
        )
        .limit(1);
      const row = rows[0];
      if (!row) throw new TRPCError({ code: "NOT_FOUND" });

      // ADR-038: runs are linked to variations through screenshots.
      // Count distinct runs that have at least one screenshot with this variation.
      const aggRows = await ctx.db
        .select({
          totalRuns: sql<number>`count(distinct ${screenshots.runId})::int`,
        })
        .from(screenshots)
        .where(eq(screenshots.testVariationId, input.variationId));
      const totalRuns = aggRows[0]?.totalRuns ?? 0;
      return { ...row, totalRuns };
    }),

  /**
   * Cursor-paginated runs for one variation, newest-first. Mirrors
   * `runs.list` (limit + 1, ISO createdAt cursor). LEFT JOINs `builds` so
   * the table can render `#{buildNumber}` without a second query per row.
   *
   * Cross-tenant safety: WHERE already filters on projectId AND
   * testVariationId; even if a caller passes a variationId from another
   * project, the projectId guard prevents leakage. The projectMember
   * middleware blocks the call before the query runs.
   */
  history: t.procedure
    .input(historyInput)
    .use(authed)
    .use(
      projectMember<HistoryInput>("read", {
        from: { resolver: ({ input }) => Promise.resolve(input.projectId) },
      }),
    )
    .query(async ({ input, ctx }) => {
      // ADR-038: runs are linked to variations through screenshots.
      // First, find all run IDs that have a screenshot with this variation.
      const linkedRunIds = await ctx.db
        .select({ runId: screenshots.runId })
        .from(screenshots)
        .where(eq(screenshots.testVariationId, input.variationId));

      if (linkedRunIds.length === 0) {
        return { items: [], nextCursor: null };
      }

      const runIdList = linkedRunIds.map((r) => r.runId);

      const conditions = [
        eq(testRuns.projectId, input.projectId),
        inArray(testRuns.id, runIdList),
      ];
      if (input.cursor) {
        conditions.push(lt(testRuns.createdAt, new Date(input.cursor)));
      }

      const rows = await ctx.db
        .select({
          id: testRuns.id,
          status: testRuns.status,
          branchName: testRuns.branchName,
          diffPercent: testRuns.diffPercent,
          pixelMisMatchCount: testRuns.pixelMisMatchCount,
          merge: testRuns.merge,
          baselineSource: testRuns.baselineSource,
          buildId: testRuns.buildId,
          buildNumber: builds.number,
          createdAt: testRuns.createdAt,
        })
        .from(testRuns)
        .leftJoin(builds, eq(builds.id, testRuns.buildId))
        .where(and(...conditions))
        .orderBy(desc(testRuns.createdAt))
        .limit(input.limit + 1);

      const hasMore = rows.length > input.limit;
      const items = hasMore ? rows.slice(0, input.limit) : rows;
      const last = items[items.length - 1];
      const nextCursor = hasMore && last ? last.createdAt.toISOString() : null;
      return { items, nextCursor };
    }),
});
