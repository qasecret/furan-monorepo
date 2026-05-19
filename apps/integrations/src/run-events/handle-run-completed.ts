import type { RunStatus } from "@furan/shared-types";
import type { Telemetry } from "@furan/telemetry";
import type { App } from "octokit";

import { createOrUpdateStickyComment } from "../github/pr-comment.js";
import { createOrUpdateStatusCheck } from "../github/status-check.js";
import { presentationFor } from "../status-mapping.js";

import type { RunEvent } from "./types.js";

type Logger = Telemetry["logger"];

/**
 * React to a `run.completed` event by posting a sticky PR comment +
 * commit status into GitHub.
 *
 * T8 is intentionally best-effort:
 * - If any required field on the event payload is missing
 *   (`installationId`, `repoOwner`, `repoName`, `sha`, `prNumber`) we log
 *   "skipped" and return. The dashboard SSE flow still works because the
 *   API just forwards the raw payload through.
 * - If the `installationId` doesn't map to an Octokit (no GitHub App
 *   token mintable), we log and return — same posture.
 *
 * Full event-payload reconciliation (publisher side adding the GitHub
 * fields) lands in T9/follow-ons. T8 puts the consumer in place so that
 * once publishers grow the payload, no code change is needed here.
 */
export async function handleRunCompleted(opts: {
  githubApp: App;
  event: Extract<RunEvent, { type: "run.completed" }>;
  log: Logger;
}): Promise<void> {
  const { event, githubApp, log } = opts;

  const missing: string[] = [];
  if (event.installationId === undefined) missing.push("installationId");
  if (!event.repoOwner) missing.push("repoOwner");
  if (!event.repoName) missing.push("repoName");
  if (!event.sha) missing.push("sha");
  if (event.prNumber === undefined) missing.push("prNumber");
  if (missing.length > 0) {
    log.debug(
      { runId: event.runId, missing },
      "run_completed_skipped_missing_github_fields",
    );
    return;
  }

  // After the missing-field check above, these are guaranteed defined.
  // Narrow with locals so TypeScript is happy.
  const installationId = event.installationId!;
  const owner = event.repoOwner!;
  const repo = event.repoName!;
  const sha = event.sha!;
  const prNumber = event.prNumber!;

  let octokit;
  try {
    octokit = await githubApp.getInstallationOctokit(installationId);
  } catch (err) {
    log.warn(
      { err, installationId, runId: event.runId },
      "run_completed_installation_octokit_failed",
    );
    return;
  }

  // Project the 7-value Furan `run_status` enum onto GitHub's 4-state
  // commit-status surface via the single source of truth in
  // `status-mapping.ts`. Fall back to `running` (→ `pending`) when the
  // event carries no status — better to leave the PR yellow than to
  // mis-report a non-result as success or failure.
  const status: RunStatus = (event.status as RunStatus) ?? "running";
  const {
    githubState,
    description: mappedDescription,
    emoji,
  } = presentationFor(status);

  // Append change-count context to the GitHub status description when
  // the diff-worker provided it — keeps the existing detail without
  // changing the load-bearing state/description policy.
  const description =
    event.numChanges !== undefined && event.numChanges > 0
      ? `${mappedDescription} (${event.numChanges} change${event.numChanges === 1 ? "" : "s"})`
      : mappedDescription;

  const body = `## ${emoji} ${mappedDescription}${
    event.numChanges !== undefined && event.numChanges > 0
      ? `\n\n${event.numChanges} change${event.numChanges === 1 ? "" : "s"} detected.`
      : ""
  }${
    event.dashboardUrl ? `\n\n[View run details](${event.dashboardUrl})` : ""
  }`;

  try {
    await Promise.all([
      createOrUpdateStickyComment({
        octokit,
        owner,
        repo,
        prNumber,
        runId: event.runId,
        body,
      }),
      createOrUpdateStatusCheck({
        octokit,
        owner,
        repo,
        sha,
        state: githubState,
        description,
        ...(event.dashboardUrl !== undefined
          ? { targetUrl: event.dashboardUrl }
          : {}),
      }),
    ]);
    log.info(
      { runId: event.runId, prNumber, sha, state: githubState, status },
      "run_completed_github_updated",
    );
  } catch (err) {
    log.error(
      { err, runId: event.runId, prNumber, sha },
      "run_completed_github_update_failed",
    );
  }
}
