import {
  and,
  builds,
  count,
  desc,
  eq,
  inArray,
  projectMembers,
  projects,
  runReviewerDecisions,
  sql,
  testRuns,
  type DB,
  type RunStatus,
} from "@furan/db";
import {
  inboxCountInput,
  inboxListInput,
  inboxListOutput,
  inboxRejectInput,
} from "@furan/shared-types";
import { z } from "zod";

import { authed } from "../middlewares/authed.js";
import { projectMember } from "../middlewares/project-member.js";
import { t } from "../trpc.js";

import { approveRun } from "./runs.js";

/** Map the window filter to a Postgres interval literal, or null for "all". */
const WINDOW_INTERVAL: Record<"24h" | "7d" | "30d" | "all", string | null> = {
  "24h": "24 hours",
  "7d": "7 days",
  "30d": "30 days",
  all: null,
};

/**
 * Return the set of project IDs the caller is allowed to see.
 * Admins see all projects; non-admins see only projects they are a member of.
 */
async function listMemberProjectIds(
  db: DB,
  user: { id: string; role: string },
): Promise<string[]> {
  if (user.role === "admin") {
    const rows = await db.select({ id: projects.id }).from(projects);
    return rows.map((r) => r.id);
  }
  const rows = await db
    .select({ id: projectMembers.projectId })
    .from(projectMembers)
    .where(eq(projectMembers.userId, user.id));
  return rows.map((r) => r.id);
}

export const inboxRouter = t.router({
  /**
   * Cross-project "inbox" list: returns test runs in UNRESOLVED or FAILED
   * state (configurable via `status` input) across all projects the caller
   * is a member of, ordered newest-first.
   *
   * Admins bypass member-gating and see all projects.
   *
   * Spec: furan-design/specs/inbox-phase1-backend
   */
  list: t.procedure
    .input(inboxListInput)
    .use(authed)
    .output(inboxListOutput)
    .query(async ({ input, ctx }) => {
      // 1. Resolve which project IDs this user may see.
      const memberProjectIds = await listMemberProjectIds(ctx.db, ctx.user);

      // 2. Intersect with any caller-supplied project filter.
      const filterProjects =
        input.projectIds && input.projectIds.length > 0
          ? input.projectIds.filter((id) => memberProjectIds.includes(id))
          : memberProjectIds;

      if (filterProjects.length === 0) {
        return { items: [], nextCursor: null };
      }

      // 3. Build the status filter.
      const statusFilter =
        input.status === "all-open"
          ? sql`${testRuns.status} IN ('unresolved', 'failed')`
          : eq(testRuns.status, input.status);

      // 4. Build the time-window filter.
      const interval = WINDOW_INTERVAL[input.window];
      const windowFilter =
        interval === null
          ? sql`true`
          : sql`${testRuns.createdAt} >= now() - ${interval}::interval`;

      // 5-sim. Similarity grouping mode (ADR-043): cluster-contiguous ordering
      //        with cross-build run/build counts via a CTE + mixed-direction keyset.
      if (input.group === "similarity") {
        // Mixed-direction keyset cursor over the cluster-contiguous ordering.
        // Sort key: cluster_run_count DESC, project_id ASC, sig_sort ASC,
        // created_at DESC, id DESC — where sig_sort = COALESCE(primary_signature, '~')
        // pushes NULL-primary singletons last WITHOUT a NULLS LAST keyset special-case.
        let cursorPred = sql`true`;
        if (input.cursor) {
          try {
            const c = JSON.parse(
              Buffer.from(input.cursor, "base64url").toString("utf8"),
            ) as {
              crc: number;
              pid: string;
              sig: string;
              cat: string;
              id: string;
            };
            cursorPred = sql`(
              s.cluster_run_count < ${c.crc}
              OR (s.cluster_run_count = ${c.crc} AND s.project_id > ${c.pid}::uuid)
              OR (s.cluster_run_count = ${c.crc} AND s.project_id = ${c.pid}::uuid AND s.sig_sort > ${c.sig})
              OR (s.cluster_run_count = ${c.crc} AND s.project_id = ${c.pid}::uuid AND s.sig_sort = ${c.sig} AND s.created_at < ${c.cat}::timestamptz)
              OR (s.cluster_run_count = ${c.crc} AND s.project_id = ${c.pid}::uuid AND s.sig_sort = ${c.sig} AND s.created_at = ${c.cat}::timestamptz AND s.run_id < ${c.id}::uuid)
            )`;
          } catch {
            // Malformed cursor — start from the top.
          }
        }

        const limit = input.limit + 1;
        const projList = sql.join(
          filterProjects.map((p) => sql`${p}::uuid`),
          sql`, `,
        );

        // Build raw-sql status + window filters for use inside the CTE (where
        // Drizzle column references like "test_runs"."status" would fail because
        // the table is aliased as `tr`).
        const simStatusFilter =
          input.status === "all-open"
            ? sql`tr.status IN ('unresolved', 'failed')`
            : sql`tr.status = ${input.status}`;
        const simWindowFilter =
          interval === null
            ? sql`true`
            : sql`tr.created_at >= now() - ${interval}::interval`;

        // The cursor predicate + ORDER BY reference `cluster_run_count` and
        // `sig_sort`, which only exist on the OUTER select — so the in_scope/agg
        // CTEs + LEFT JOIN form an inner subquery and the keyset/order/limit wrap it.
        const rows = await ctx.db.execute<{
          run_id: string;
          project_id: string;
          project_name: string;
          variation_name: string;
          build_number: number | null;
          branch: string | null;
          status: RunStatus;
          created_at: Date;
          thumbnail_url: string | null;
          primary_signature: string | null;
          cluster_run_count: number;
          cluster_build_count: number;
        }>(sql`
          SELECT * FROM (
            WITH in_scope AS (
              SELECT tr.id, tr.project_id, tr.build_id, tr.name, tr.status,
                     tr.created_at, tr.thumbnail_url, tr.primary_signature,
                     p.name AS project_name, b.number AS build_number, b.branch_name AS branch
              FROM test_runs tr
              JOIN projects p ON p.id = tr.project_id
              JOIN builds b ON b.id = tr.build_id
              WHERE tr.project_id IN (${projList}) AND ${simStatusFilter} AND ${simWindowFilter}
            ),
            agg AS (
              SELECT project_id, primary_signature,
                     COUNT(*)::int AS run_count, COUNT(DISTINCT build_id)::int AS build_count
              FROM in_scope WHERE primary_signature IS NOT NULL
              GROUP BY project_id, primary_signature
            )
            SELECT s.id AS run_id, s.project_id, s.project_name, s.name AS variation_name,
                   s.build_number, s.branch, s.status, s.created_at, s.thumbnail_url,
                   s.primary_signature,
                   COALESCE(a.run_count, 1) AS cluster_run_count,
                   COALESCE(a.build_count, 1) AS cluster_build_count,
                   COALESCE(s.primary_signature, '~') AS sig_sort
            FROM in_scope s
            LEFT JOIN agg a ON a.project_id = s.project_id AND a.primary_signature = s.primary_signature
          ) s
          WHERE ${cursorPred}
          ORDER BY s.cluster_run_count DESC, s.project_id ASC, s.sig_sort ASC,
                   s.created_at DESC, s.run_id DESC
          LIMIT ${limit}
        `);

        const pageHasMore = rows.length > input.limit;
        const page = pageHasMore ? rows.slice(0, input.limit) : rows;
        const last = pageHasMore ? page[page.length - 1] : null;
        const nextCursor = last
          ? Buffer.from(
              JSON.stringify({
                crc: Number(last.cluster_run_count),
                pid: last.project_id,
                sig: last.primary_signature ?? "~",
                cat: new Date(last.created_at).toISOString(),
                id: last.run_id,
              }),
            ).toString("base64url")
          : null;

        return {
          items: page.map((r) => ({
            runId: r.run_id,
            projectId: r.project_id,
            projectName: r.project_name,
            variationName: r.variation_name,
            buildNumber: r.build_number,
            branch: r.branch,
            status: r.status,
            createdAt: new Date(r.created_at).toISOString(),
            thumbnailUrl: r.thumbnail_url,
            primarySignature: r.primary_signature,
            clusterRunCount: Number(r.cluster_run_count),
            clusterBuildCount: Number(r.cluster_build_count),
          })),
          nextCursor,
        };
      }

      // 5. Cursor: decode the opaque cursor string back to a (createdAt, id)
      //    pair for keyset pagination.
      let cursorFilter = sql`true`;
      if (input.cursor) {
        try {
          const { createdAt, id } = JSON.parse(
            Buffer.from(input.cursor, "base64url").toString("utf8"),
          ) as { createdAt: string; id: string };
          cursorFilter = sql`(${testRuns.createdAt}, ${testRuns.id}) < (${createdAt}::timestamptz, ${id}::uuid)`;
        } catch {
          // Malformed cursor — ignore and start from the top.
        }
      }

      // 6. Execute the query.
      const rows = (await ctx.db
        .select({
          runId: testRuns.id,
          projectId: testRuns.projectId,
          projectName: projects.name,
          // ADR-038: runs no longer have a single variation; use run name instead.
          variationName: testRuns.name,
          buildNumber: builds.number,
          branch: builds.branchName,
          status: testRuns.status,
          createdAt: testRuns.createdAt,
          thumbnailUrl: testRuns.thumbnailUrl,
        })
        .from(testRuns)
        .innerJoin(projects, eq(projects.id, testRuns.projectId))
        .innerJoin(builds, eq(builds.id, testRuns.buildId))
        .where(
          and(
            inArray(testRuns.projectId, filterProjects),
            statusFilter,
            windowFilter,
            cursorFilter,
          ),
        )
        .orderBy(desc(testRuns.createdAt), desc(testRuns.id))
        .limit(input.limit + 1)) as {
        runId: string;
        projectId: string;
        projectName: string;
        variationName: string;
        buildNumber: number | null;
        branch: string | null;
        status: RunStatus;
        createdAt: Date;
        thumbnailUrl: string | null;
      }[];

      // 7. Derive nextCursor from the last item if there are more results.
      const hasMore = rows.length > input.limit;
      const pageRows = hasMore ? rows.slice(0, input.limit) : rows;

      const lastRow = hasMore ? pageRows[pageRows.length - 1] : null;
      const nextCursor = lastRow
        ? Buffer.from(
            JSON.stringify({
              createdAt: lastRow.createdAt.toISOString(),
              id: lastRow.runId,
            }),
          ).toString("base64url")
        : null;

      const items = pageRows.map((r) => ({
        ...r,
        createdAt: r.createdAt.toISOString(),
      }));

      return { items, nextCursor };
    }),

  /**
   * Returns the total count of UNRESOLVED + FAILED test runs across all
   * projects the caller is a member of (admins see all projects).
   *
   * Used by the sidebar badge to show the number of open items.
   */
  count: t.procedure
    .input(inboxCountInput)
    .use(authed)
    .output(z.object({ total: z.number().int() }))
    .query(async ({ input, ctx }) => {
      const memberProjectIds = await listMemberProjectIds(ctx.db, ctx.user);
      if (memberProjectIds.length === 0) return { total: 0 };

      const interval = WINDOW_INTERVAL[input.window];
      const windowFilter =
        interval === null
          ? sql`true`
          : sql`${testRuns.createdAt} >= now() - ${interval}::interval`;

      const [row] = await ctx.db
        .select({ total: count() })
        .from(testRuns)
        .where(
          and(
            inArray(testRuns.projectId, memberProjectIds),
            sql`${testRuns.status} IN ('unresolved', 'failed')`,
            windowFilter,
          ),
        );

      return { total: Number(row?.total ?? 0) };
    }),

  /**
   * Approve a single test run from the inbox view. Delegates entirely to the
   * shared `approveRun` helper (same side effects as `runs.approve`): status
   * → passed, merge=true, baseline snapshot, broadcaster events.
   *
   * Project membership is resolved from the run row so callers only need to
   * supply the runId — consistent with how the inbox list surfaces items
   * without requiring the caller to track projectId separately.
   */
  approve: t.procedure
    .input(z.object({ runId: z.string().uuid() }))
    .use(authed)
    .use(
      projectMember<{ runId: string }>("write", {
        from: {
          resolver: async ({ input, ctx }) => {
            const rows = await ctx.db
              .select({ projectId: testRuns.projectId })
              .from(testRuns)
              .where(eq(testRuns.id, input.runId))
              .limit(1);
            return rows[0]?.projectId ?? null;
          },
        },
      }),
    )
    .mutation(async ({ input, ctx }) => {
      return approveRun(ctx, input.runId);
    }),

  /**
   * Mark a test run as rejected by inserting a `runReviewerDecisions` row with
   * decision="rejected". Re-rejecting the same (runId, userId) pair is an UPSERT
   * that updates the reason — idempotent by design.
   *
   * Critically, this procedure does NOT touch `test_runs.status`. The rejection
   * is a reviewer's marker only; status changes are driven by the approval/baseline
   * acceptance path or external CI signals.
   */
  reject: t.procedure
    .input(inboxRejectInput)
    .use(authed)
    .use(
      projectMember<{ runId: string; reason?: string | null }>("write", {
        from: {
          resolver: async ({ input, ctx }) => {
            const rows = await ctx.db
              .select({ projectId: testRuns.projectId })
              .from(testRuns)
              .where(eq(testRuns.id, input.runId))
              .limit(1);
            return rows[0]?.projectId ?? null;
          },
        },
      }),
    )
    .mutation(async ({ input, ctx }) => {
      await ctx.db
        .insert(runReviewerDecisions)
        .values({
          runId: input.runId,
          userId: ctx.user.id,
          decision: "rejected",
          reason: input.reason ?? null,
        })
        .onConflictDoUpdate({
          target: [runReviewerDecisions.runId, runReviewerDecisions.userId],
          set: {
            decision: "rejected",
            reason: input.reason ?? null,
          },
        });
      return { ok: true as const };
    }),
});
