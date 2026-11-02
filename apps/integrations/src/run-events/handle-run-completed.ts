import type { DB } from "@furan/db";
import type { RunStatus } from "@furan/shared-types";
import type { Telemetry } from "@furan/telemetry";
import type { App } from "octokit";

import {
  aggregateBuildStatus,
  describeBuildStatus,
  type BuildStatusAggregate,
} from "../build-status.js";
import type { PostMemo } from "../github/post-memo.js";
import { createOrUpdateStickyComment } from "../github/pr-comment.js";
import {
  loadBuildStatusCounts,
  loadRunContext,
  resolveInstallationId,
  type RunContextRow,
} from "../github/run-context.js";
import { createOrUpdateStatusCheck } from "../github/status-check.js";
import { presentationFor } from "../status-mapping.js";

import type { RunEvent } from "./types.js";

type Logger = Telemetry["logger"];

/**
 * React to a `run.completed` event by posting a sticky PR comment +
 * commit status into GitHub. The subscriber also calls it, with just the run
 * id, when a review (approve, reject, undo, force passed or failed) moved a
 * run's status: the status is then read from the stored run.
 *
 * Best-effort throughout:
 * - The GitHub context (`installationId`, `repoOwner`, `repoName`, `sha`,
 *   `prNumber`) is taken from the event when it carries it, and otherwise from
 *   the database (when `db` is given): the repository, pull request and commit
 *   the SDK reported for the run (`test_runs`), and the installation linked to
 *   the run's project (`installations.project_id`). The publishers send none of
 *   it, so the consumer is the one place that resolves it.
 * - If `installationId`, the repository or the commit cannot be found we log
 *   "skipped" and return. The dashboard SSE flow still works because the API
 *   just forwards the raw payload through.
 * - `prNumber` is optional: a push build has a commit but no pull request, and
 *   gets the commit status without the comment.
 * - A failed lookup is a warning, never a throw; if the `installationId`
 *   doesn't map to an Octokit (no GitHub App token mintable) we log and return.
 *
 * The comment is about this run. The commit status is about the whole build:
 * it is one value per commit and gates merges, so it is the worst status among
 * the build's tests (the latest run of each), not whichever test finished last.
 */
export async function handleRunCompleted(opts: {
  githubApp: App;
  event: Extract<RunEvent, { type: "run.completed" }>;
  log: Logger;
  /** Resolves what the event lacks; without it the event must carry it all. */
  db?: DB;
  /** The dashboard origin, for the links in the comment and the status. */
  dashboardBaseUrl?: string;
  /**
   * What was last posted per commit. When given, a commit status identical to
   * the last one posted for the commit is not posted again.
   */
  postMemo?: PostMemo;
}): Promise<void> {
  const { event, githubApp, log, db } = opts;
  const base = opts.dashboardBaseUrl?.replace(/\/+$/, "");

  let row: RunContextRow | null = null;
  if (db) {
    try {
      row = await loadRunContext(db, event.runId);
    } catch (err) {
      log.warn(
        { err, runId: event.runId },
        "run_completed_context_lookup_failed",
      );
    }
  }

  const owner = event.repoOwner || row?.repoOwner || undefined;
  const repo = event.repoName || row?.repoName || undefined;
  const sha = event.sha || row?.commitSha || undefined;
  const prNumber = event.prNumber ?? row?.prNumber ?? undefined;
  const projectId = event.projectId ?? row?.projectId;

  const missing: string[] = [];
  if (!owner) missing.push("repoOwner");
  if (!repo) missing.push("repoName");
  if (!sha) missing.push("sha");

  let installationId = event.installationId;
  if (installationId === undefined && missing.length === 0 && db && projectId) {
    try {
      installationId =
        (await resolveInstallationId(db, projectId, owner ?? null)) ??
        undefined;
    } catch (err) {
      log.warn(
        { err, runId: event.runId, projectId },
        "run_completed_installation_lookup_failed",
      );
    }
  }
  if (installationId === undefined) missing.unshift("installationId");

  if (missing.length > 0) {
    log.debug(
      { runId: event.runId, missing },
      "run_completed_skipped_missing_github_fields",
    );
    return;
  }

  // After the missing-field check above, these are guaranteed defined.
  // Narrow with locals so TypeScript is happy.
  const octokitInstallationId = installationId!;
  const repoOwner = owner!;
  const repoName = repo!;
  const commitSha = sha!;

  let octokit;
  try {
    octokit = await githubApp.getInstallationOctokit(octokitInstallationId);
  } catch (err) {
    log.warn(
      { err, installationId: octokitInstallationId, runId: event.runId },
      "run_completed_installation_octokit_failed",
    );
    return;
  }

  const runUrl =
    event.dashboardUrl ??
    (base && projectId
      ? `${base}/projects/${projectId}/runs/${event.runId}`
      : undefined);

  // Project the 7-value Furan `run_status` enum onto GitHub's 4-state
  // commit-status surface via the single source of truth in
  // `status-mapping.ts`. Fall back to `running` (→ `pending`) when neither the
  // event nor the stored run has a status — better to leave the PR yellow than
  // to mis-report a non-result as success or failure.
  const runStatus: RunStatus =
    (event.status as RunStatus | undefined) ?? row?.status ?? "running";
  const { description: mappedDescription, emoji } = presentationFor(runStatus);

  const body = `## ${emoji} ${mappedDescription}${
    event.numChanges !== undefined && event.numChanges > 0
      ? `\n\n${event.numChanges} change${event.numChanges === 1 ? "" : "s"} detected.`
      : ""
  }${runUrl ? `\n\n[View run details](${runUrl})` : ""}`;

  // The commit status speaks for the whole build once it has several tests.
  let aggregate: BuildStatusAggregate | null = null;
  if (db && row?.buildId) {
    try {
      aggregate = aggregateBuildStatus(
        await loadBuildStatusCounts(db, row.buildId),
      );
    } catch (err) {
      log.warn(
        { err, runId: event.runId, buildId: row.buildId },
        "run_completed_build_status_failed",
      );
    }
  }

  let githubState;
  let description: string;
  let targetUrl: string | undefined;
  let status: RunStatus;
  if (aggregate && aggregate.total > 1) {
    status = aggregate.status;
    githubState = presentationFor(status).githubState;
    description = describeBuildStatus(aggregate);
    targetUrl =
      base && projectId && row
        ? `${base}/projects/${projectId}/builds/${row.buildId}`
        : runUrl;
  } else {
    status = runStatus;
    githubState = presentationFor(status).githubState;
    // Append change-count context to the GitHub status description when
    // the diff-worker provided it — keeps the existing detail without
    // changing the load-bearing state/description policy.
    description =
      event.numChanges !== undefined && event.numChanges > 0
        ? `${mappedDescription} (${event.numChanges} change${event.numChanges === 1 ? "" : "s"})`
        : mappedDescription;
    targetUrl = runUrl;
  }

  // GitHub keeps every status posted (at most 1000 per commit and context), so
  // one identical to the last post for this commit is not posted again.
  const memoKey = `${repoOwner}/${repoName}@${commitSha}`;
  const memoValue = `${githubState}|${description}|${targetUrl ?? ""}`;
  const statusUnchanged = opts.postMemo?.unchanged(memoKey, memoValue) ?? false;
  if (statusUnchanged) {
    log.debug(
      { runId: event.runId, sha: commitSha, state: githubState },
      "run_completed_status_unchanged",
    );
  }

  // The two calls are independent: one failing (say the repository is outside
  // the installation's access) must not stop the other from completing.
  const results = await Promise.allSettled([
    prNumber !== undefined
      ? createOrUpdateStickyComment({
          octokit,
          owner: repoOwner,
          repo: repoName,
          prNumber,
          runId: event.runId,
          body,
        })
      : Promise.resolve(),
    statusUnchanged
      ? Promise.resolve()
      : createOrUpdateStatusCheck({
          octokit,
          owner: repoOwner,
          repo: repoName,
          sha: commitSha,
          state: githubState,
          description,
          ...(targetUrl !== undefined ? { targetUrl } : {}),
        }).then(() => opts.postMemo?.remember(memoKey, memoValue)),
  ]);
  const failures = results.filter(
    (r): r is PromiseRejectedResult => r.status === "rejected",
  );
  for (const failure of failures) {
    log.error(
      { err: failure.reason, runId: event.runId, prNumber, sha: commitSha },
      "run_completed_github_update_failed",
    );
  }
  if (failures.length === 0) {
    log.info(
      {
        runId: event.runId,
        prNumber,
        sha: commitSha,
        state: githubState,
        status,
      },
      "run_completed_github_updated",
    );
  }
}
