import {
  and,
  builds,
  desc,
  eq,
  inArray,
  projectMembers,
  projects,
  sql,
  testRuns,
  testVariations,
  type DB,
  type RunStatus,
} from "@furan/db";
import { inboxListInput, inboxListOutput } from "@furan/shared-types";

import { authed } from "../middlewares/authed.js";
import { t } from "../trpc.js";

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
          variationName: testVariations.name,
          buildNumber: builds.number,
          branch: builds.branchName,
          status: testRuns.status,
          createdAt: testRuns.createdAt,
          thumbnailUrl: testRuns.thumbnailUrl,
        })
        .from(testRuns)
        .innerJoin(projects, eq(projects.id, testRuns.projectId))
        .innerJoin(builds, eq(builds.id, testRuns.buildId))
        .innerJoin(
          testVariations,
          eq(testVariations.id, testRuns.testVariationId),
        )
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
});
