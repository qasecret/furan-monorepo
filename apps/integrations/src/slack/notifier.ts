import { diffRegions, eq, type DB } from "@furan/db";

import type { RunEvent } from "../run-events/types.js";

import {
  runCompletedBlockKit,
  type SeverityCounts,
  type SlackPayload,
} from "./block-kit.js";

/**
 * URL-based Slack detection. Spec §4.3: "the Slack incoming webhook URL
 * is stored as a `webhooks` row with the URL pre-configured" — there's no
 * `kind` column today, so we sniff by URL prefix. Slack's incoming webhook
 * URLs all live under hooks.slack.com.
 *
 * Documented as a T9 deviation in the commit message — a follow-up can
 * add a `webhooks.kind` enum once we know how many other
 * URL-pattern-distinguished subscribers we end up with (Discord, MS Teams, …).
 */
export function isSlackUrl(url: string): boolean {
  return url.startsWith("https://hooks.slack.com/");
}

/** Generic-webhook envelope for non-Slack subscribers. */
export interface GenericRunCompletedPayload {
  event: "run.completed";
  runId: string;
  projectId?: string;
  status?: string;
  diffPercent?: number;
  branchName?: string;
  numChanges?: number;
  dashboardUrl?: string;
  severityCounts: SeverityCounts;
}

export interface BuildPayloadInput {
  event: Extract<RunEvent, { type: "run.completed" }>;
  branchName: string;
  severityCounts: SeverityCounts;
  dashboardUrl: string;
}

/**
 * Branch on URL shape and return either a Slack Block Kit payload or a
 * generic envelope. Both consume the same `RunEvent` arm so the run-events
 * subscriber doesn't need to know which downstream it's targeting.
 */
export function buildPayload(
  hookUrl: string,
  input: BuildPayloadInput,
): SlackPayload | GenericRunCompletedPayload {
  if (isSlackUrl(hookUrl)) {
    return runCompletedBlockKit({
      runId: input.event.runId,
      projectId: input.event.projectId ?? "",
      status: input.event.status ?? "unknown",
      diffPercent:
        input.event.diffPercent !== undefined ? input.event.diffPercent : null,
      branchName: input.branchName,
      severityCounts: input.severityCounts,
      dashboardUrl: input.dashboardUrl,
    });
  }

  const out: GenericRunCompletedPayload = {
    event: "run.completed",
    runId: input.event.runId,
    severityCounts: input.severityCounts,
  };
  if (input.event.projectId !== undefined)
    out.projectId = input.event.projectId;
  if (input.event.status !== undefined) out.status = input.event.status;
  if (input.event.diffPercent !== undefined)
    out.diffPercent = input.event.diffPercent;
  if (input.branchName) out.branchName = input.branchName;
  if (input.event.numChanges !== undefined)
    out.numChanges = input.event.numChanges;
  if (input.dashboardUrl) out.dashboardUrl = input.dashboardUrl;
  return out;
}

/**
 * Tally `diff_regions.severity` for a given run.
 *
 * Defensive: any severity values outside the expected set are ignored
 * (they'd surface in the table via a category mismatch, not via this fn).
 */
export async function loadSeverityCounts(
  db: DB,
  runId: string,
): Promise<SeverityCounts> {
  const regions = await db
    .select({ severity: diffRegions.severity })
    .from(diffRegions)
    .where(eq(diffRegions.runId, runId));

  const counts: SeverityCounts = {
    breaking: 0,
    major: 0,
    minor: 0,
    cosmetic: 0,
  };
  for (const r of regions) {
    if (r.severity === "breaking") counts.breaking++;
    else if (r.severity === "major") counts.major++;
    else if (r.severity === "minor") counts.minor++;
    else if (r.severity === "cosmetic") counts.cosmetic++;
  }
  return counts;
}
