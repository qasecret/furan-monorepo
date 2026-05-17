import type { Telemetry } from "@furan/telemetry";
import type { App } from "octokit";

import { createOrUpdateStickyComment } from "../github/pr-comment.js";
import { createOrUpdateStatusCheck } from "../github/status-check.js";

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

  const state: "success" | "failure" =
    event.status === "passed" ? "success" : "failure";
  const description =
    event.status === "passed"
      ? "Visual regression: no breaking changes"
      : `Visual regression: ${event.numChanges ?? "?"} change(s)`;

  const body =
    event.status === "passed"
      ? `**Furan**: visual regression passed.${
          event.dashboardUrl ? `\n\n[View run](${event.dashboardUrl})` : ""
        }`
      : `**Furan**: visual regression detected ${
          event.numChanges ?? "?"
        } change(s).${
          event.dashboardUrl
            ? `\n\n[Review in dashboard](${event.dashboardUrl})`
            : ""
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
        state,
        description,
        ...(event.dashboardUrl !== undefined
          ? { targetUrl: event.dashboardUrl }
          : {}),
      }),
    ]);
    log.info(
      { runId: event.runId, prNumber, sha, state },
      "run_completed_github_updated",
    );
  } catch (err) {
    log.error(
      { err, runId: event.runId, prNumber, sha },
      "run_completed_github_update_failed",
    );
  }
}
