import type { RunStatus } from "@furan/shared-types";

import { type GitHubStatusState, presentationFor } from "../status-mapping.js";

/**
 * Slack Block Kit shapes — narrowly typed to what we actually emit. We
 * intentionally don't pull in `@slack/web-api`'s `KnownBlock` because the
 * incoming-webhook surface is just a JSON POST and the wider SDK types
 * carry transport concerns we don't need.
 *
 * See https://api.slack.com/block-kit for the reference.
 *
 * `attachments[].color` is the legacy-attachment field Slack still
 * renders as a left-border swatch even for Block Kit content. We use it
 * to telegraph status at a glance — see `colorByState` below.
 */
export interface SlackPayload {
  blocks: unknown[];
  attachments?: Array<{ color: string; blocks?: unknown[] }>;
}

export interface SeverityCounts {
  breaking: number;
  major: number;
  minor: number;
  cosmetic: number;
}

export interface RunCompletedBlockKitOpts {
  runId: string;
  projectId: string;
  status: RunStatus;
  diffPercent: number | null;
  branchName: string;
  severityCounts: SeverityCounts;
  dashboardUrl: string;
}

/**
 * Map Furan's 4-value projection onto a Slack attachment colour. Hex
 * codes match Tailwind 500-shade tokens used elsewhere in the
 * dashboard so the visual language is consistent across surfaces.
 */
const colorByState: Record<GitHubStatusState, string> = {
  pending: "#3b82f6", // blue-500
  success: "#22c55e", // green-500
  failure: "#ef4444", // red-500
  error: "#eab308", // yellow-500
};

/**
 * Render a `run.completed` event as a 4-block Slack payload:
 *   1. Header section — branch context.
 *   2. Status + diff% two-column fields.
 *   3. Severity counts (single mrkdwn line with coloured dot emojis).
 *   4. Actions row with a single "View in dashboard" button.
 *
 * The 7-status emoji + description come from `presentationFor` so this
 * surface stays in lock-step with GitHub commit-status and PR comment.
 *
 * Pure / deterministic: no fetch, no Date.now, no Math.random. Tests pin
 * the exact block array shape so any subtle drift surfaces immediately.
 */
export function runCompletedBlockKit(
  opts: RunCompletedBlockKitOpts,
): SlackPayload {
  const { emoji, description, githubState } = presentationFor(opts.status);
  const diffPercentText =
    opts.diffPercent != null ? `${opts.diffPercent.toFixed(2)}%` : "—";
  const color = colorByState[githubState];

  return {
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Furan visual regression* — Run on \`${opts.branchName}\``,
        },
      },
      {
        type: "section",
        fields: [
          {
            type: "mrkdwn",
            text: `*Status:* ${emoji} ${description}`,
          },
          {
            type: "mrkdwn",
            text: `*Diff %:* ${diffPercentText}`,
          },
        ],
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            `:red_circle: ${opts.severityCounts.breaking}  ` +
            `:large_orange_circle: ${opts.severityCounts.major}  ` +
            `:large_yellow_circle: ${opts.severityCounts.minor}  ` +
            `:large_blue_circle: ${opts.severityCounts.cosmetic}`,
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "View in dashboard" },
            url: opts.dashboardUrl,
          },
        ],
      },
    ],
    attachments: [{ color }],
  };
}
