import { asc, eq, installations, sql, testRuns, type DB } from "@furan/db";
import type { RunStatus } from "@furan/shared-types";

import type { RunStatusCounts } from "../build-status.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What a `run.completed` event needs from the database to reach GitHub. */
export interface RunContextRow {
  projectId: string;
  buildId: string;
  /** The run's status as stored now. */
  status: RunStatus;
  repoOwner: string | null;
  repoName: string | null;
  prNumber: number | null;
  commitSha: string | null;
}

/**
 * The run's project, build, status and the repository / pull request / commit
 * the SDK reported for it (`POST /runs`). Null when the run is unknown or the
 * id is not a uuid. The integrations service connects with the table owner's
 * credentials, as the Slack notifier's reads already rely on, so this needs no
 * project scope.
 */
export async function loadRunContext(
  db: DB,
  runId: string,
): Promise<RunContextRow | null> {
  if (!UUID_RE.test(runId)) return null;
  const [row] = await db
    .select({
      projectId: testRuns.projectId,
      buildId: testRuns.buildId,
      status: testRuns.status,
      repoOwner: testRuns.repoOwner,
      repoName: testRuns.repoName,
      prNumber: testRuns.prNumber,
      commitSha: testRuns.commitSha,
    })
    .from(testRuns)
    .where(eq(testRuns.id, runId))
    .limit(1);
  return row ?? null;
}

/**
 * The GitHub App installation linked to the project (`/admin/installations`).
 * A project may have several (one per account that installed the App); the one
 * whose account is the repository owner wins, else the oldest link, so the
 * answer is deterministic. Null when none is linked.
 */
export async function resolveInstallationId(
  db: DB,
  projectId: string,
  repoOwner: string | null,
): Promise<number | null> {
  const rows = await db
    .select({
      installationId: installations.installationId,
      accountLogin: installations.accountLogin,
    })
    .from(installations)
    .where(eq(installations.projectId, projectId))
    .orderBy(asc(installations.createdAt), asc(installations.id));
  if (rows.length === 0) return null;
  const owner = repoOwner?.toLowerCase();
  const match = owner
    ? rows.find((r) => r.accountLogin.toLowerCase() === owner)
    : undefined;
  return (match ?? rows[0]!).installationId;
}

/**
 * How many of the build's tests are in each status, counting only the latest
 * run of each test name: a CI re-run of the same build adds a new run per test,
 * and an earlier `aborted` or `unresolved` run must not hold the commit status
 * down once the test has since passed.
 */
export async function loadBuildStatusCounts(
  db: DB,
  buildId: string,
): Promise<RunStatusCounts> {
  const rows = await db.execute<{ status: RunStatus; n: number }>(sql`
    select status, count(*)::int as n
    from (
      select distinct on (name) status
      from ${testRuns}
      where build_id = ${buildId}
      order by name, created_at desc, id desc
    ) latest
    group by status
  `);
  const counts: RunStatusCounts = {};
  for (const r of Array.from(rows)) counts[r.status] = r.n;
  return counts;
}
