/**
 * Slack Block Kit shapes — narrowly typed to what we actually emit. We
 * intentionally don't pull in `@slack/web-api`'s `KnownBlock` because the
 * incoming-webhook surface is just a JSON POST and the wider SDK types
 * carry transport concerns we don't need.
 *
 * See https://api.slack.com/block-kit for the reference.
 */
export interface SlackPayload {
  blocks: unknown[];
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
  status: string; // "passed" | "failed" | etc.
  diffPercent: number | null;
  branchName: string;
  severityCounts: SeverityCounts;
  dashboardUrl: string;
}

/**
 * Render a `run.completed` event as a 4-block Slack payload:
 *   1. Header section — branch context.
 *   2. Status + diff% two-column fields.
 *   3. Severity counts (single mrkdwn line with coloured dot emojis).
 *   4. Actions row with a single "View in dashboard" button.
 *
 * Pure / deterministic: no fetch, no Date.now, no Math.random. Tests pin
 * the exact block array shape so any subtle drift surfaces immediately.
 */
export function runCompletedBlockKit(
  opts: RunCompletedBlockKitOpts,
): SlackPayload {
  const passed = opts.status === "passed";
  const diffPercentText =
    opts.diffPercent != null ? `${opts.diffPercent.toFixed(2)}%` : "—";

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
            text: `*Status:* ${passed ? ":white_check_mark:" : ":x:"} ${opts.status}`,
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
  };
}
