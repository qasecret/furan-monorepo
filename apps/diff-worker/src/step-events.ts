import {
  and,
  autoRuleApplications,
  count,
  diffRegions,
  eq,
  testRuns,
  withProjectScope,
  type DB,
  type RunStatus,
} from "@furan/db";
import { SEVERITY, type Action } from "@furan/rules-engine";
import type { Telemetry } from "@furan/telemetry";
import type { Redis } from "ioredis";

type Logger = Telemetry["logger"];

/** The policy rank an application stores (`action_priority`) back to its action. */
const ACTION_BY_PRIORITY = new Map<number, Action>(
  (Object.entries(SEVERITY) as Array<[Action, number]>).map(
    ([action, rank]) => [rank, action],
  ),
);

/**
 * Best-effort publish of one frame: a Redis failure is logged and swallowed,
 * so one failing event neither fails a committed job nor stops the events
 * after it.
 */
async function publishFrame(
  redis: Redis,
  logger: Logger,
  channel: string,
  event: string,
  frame: unknown,
  context: { runId: string },
): Promise<void> {
  try {
    await redis.publish(channel, JSON.stringify(frame));
  } catch (err) {
    logger.warn(
      { err, ...context, channel, event },
      "diff_step_event_publish_failed",
    );
  }
}

/**
 * Best-effort publish on the project's raw channel
 * (`project:<id>:events:raw`), which the api's project SSE route forwards to
 * the dashboard's list pages (`apps/api/src/lib/broadcast.ts` writes the same
 * channel and envelope: `{ event, data, ts }`). The dashboard invalidates its
 * queries on receipt and refetches the row, so `data` stays minimal. Spec
 * furan-design/specs/2026-05-24-list-level-live-updates-design.md §6.5.
 */
export async function publishProjectEvent(
  redis: Redis,
  logger: Logger,
  args: { projectId: string; runId: string; event: string; data: unknown },
): Promise<void> {
  await publishFrame(
    redis,
    logger,
    `project:${args.projectId}:events:raw`,
    args.event,
    { event: args.event, data: args.data, ts: Date.now() },
    { runId: args.runId },
  );
}

/** What `run.completed` reports of the run, as stored once the step committed. */
interface RunFacts {
  buildId: string | null;
  branchName: string | null;
  diffPercent: number | null;
  resolutionSource: "rule" | null;
  /** The run's `diff_regions` count. */
  numChanges: number;
  /** Counts by action of the run's winning rule applications; null when it has none. */
  rulesSummary: Record<Action, number> | null;
}

/**
 * The run's stored totals, region count and winning rule applications, in one
 * project-scoped transaction. `null` when the run is gone.
 */
async function readRunFacts(
  db: DB,
  projectId: string,
  runId: string,
): Promise<RunFacts | null> {
  return withProjectScope(db, projectId, async (tx) => {
    const [run] = await tx
      .select({
        buildId: testRuns.buildId,
        branchName: testRuns.branchName,
        diffPercent: testRuns.diffPercent,
        resolutionSource: testRuns.resolutionSource,
      })
      .from(testRuns)
      .where(and(eq(testRuns.id, runId), eq(testRuns.projectId, projectId)));
    if (!run) return null;

    const [regions] = await tx
      .select({ n: count() })
      .from(diffRegions)
      .where(
        and(eq(diffRegions.runId, runId), eq(diffRegions.projectId, projectId)),
      );
    const won = await tx
      .select({ priority: autoRuleApplications.actionPriority, n: count() })
      .from(autoRuleApplications)
      .where(
        and(
          eq(autoRuleApplications.testRunId, runId),
          eq(autoRuleApplications.won, true),
        ),
      )
      .groupBy(autoRuleApplications.actionPriority);

    let rulesSummary: Record<Action, number> | null = null;
    for (const { priority, n } of won) {
      const action = ACTION_BY_PRIORITY.get(priority);
      if (!action) continue;
      rulesSummary ??= { auto_approve: 0, flag: 0 };
      rulesSummary[action] += n;
    }

    return { ...run, numChanges: regions?.n ?? 0, rulesSummary };
  });
}

/**
 * The events a step job publishes once its step has settled, whether it
 * committed a result or failed for good (spec 2026-10-23 §8). The caller runs
 * it after the commit AND after the step's rule applications are stored, since
 * `rulesSummary` reads them.
 *
 * Always:
 *  - run channel: `run.checkpoint_diffed { runId, screenshotId, verdict, failed }`;
 *  - project channel: `run.checkpoint_diffed { runId, screenshotId }`.
 *
 * Only when the commit moved the run's status (`rollup.before !== rollup.after`):
 *  - run channel: `run.completed` with the new status and the run's stored
 *    totals, which the integrations subscriber fans out (GitHub status, Slack,
 *    outbound webhooks). GitHub-side fields (installationId, repoOwner,
 *    repoName, sha, prNumber) are omitted; both consumers cope without them;
 *  - project channel: `testRun_updated { id, status }` and `build_updated { id }`.
 * The common per-step commit leaves the status alone and so reads nothing.
 *
 * Best-effort: it logs and never throws, and one failing event does not stop
 * the others. If the stored totals cannot be read, the status events are
 * skipped (logged); the per-step events do not need them.
 */
export async function publishStepEvents(
  redis: Redis,
  args: {
    runId: string;
    projectId: string;
    screenshotId: string;
    /** The step's verdict. */
    verdict: string;
    /** True when the step's diff failed for good (its final attempt). */
    failed: boolean;
    /** The run's status before and after the step's commit. */
    rollup: { before: RunStatus; after: RunStatus };
    db: DB;
    logger: Logger;
  },
): Promise<void> {
  const {
    runId,
    projectId,
    screenshotId,
    verdict,
    failed,
    rollup,
    db,
    logger,
  } = args;
  const context = { runId };
  const runChannel = `run:${runId}:events`;

  await publishFrame(
    redis,
    logger,
    runChannel,
    "run.checkpoint_diffed",
    { type: "run.checkpoint_diffed", runId, screenshotId, verdict, failed },
    context,
  );
  await publishProjectEvent(redis, logger, {
    projectId,
    runId,
    event: "run.checkpoint_diffed",
    data: { runId, screenshotId },
  });
  if (rollup.before === rollup.after) return;

  let facts: RunFacts | null;
  try {
    facts = await readRunFacts(db, projectId, runId);
  } catch (err) {
    logger.warn(
      { err, runId, projectId, screenshotId },
      "diff_step_event_read_failed",
    );
    return;
  }
  // The run was deleted since the commit: there is no status to announce.
  if (!facts) return;

  await publishFrame(
    redis,
    logger,
    runChannel,
    "run.completed",
    {
      type: "run.completed",
      runId,
      projectId,
      status: rollup.after,
      // Omitted (not null) when no step was compared, as the optional field of
      // the consumers' event type.
      diffPercent: facts.diffPercent ?? undefined,
      branchName: facts.branchName,
      numChanges: facts.numChanges,
      resolutionSource: facts.resolutionSource,
      rulesSummary: facts.rulesSummary,
    },
    context,
  );
  await publishProjectEvent(redis, logger, {
    projectId,
    runId,
    event: "testRun_updated",
    data: { id: runId, status: rollup.after },
  });
  if (facts.buildId) {
    await publishProjectEvent(redis, logger, {
      projectId,
      runId,
      event: "build_updated",
      data: { id: facts.buildId },
    });
  }
}
