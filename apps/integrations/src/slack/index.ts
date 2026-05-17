/**
 * Slack outbound (T9).
 *
 *   - `block-kit.ts` — pure renderer for the `run.completed` Slack payload.
 *   - `notifier.ts`  — branch between Slack vs generic webhook subscribers
 *                      and resolve severity counts from `diff_regions`.
 *
 * The actual HTTP POST happens through the generic outbound webhook worker
 * (`../webhooks/worker.ts`) — Slack incoming webhooks are just a flavour
 * of subscriber, distinguished by URL pattern (`hooks.slack.com`).
 */
export {
  runCompletedBlockKit,
  type RunCompletedBlockKitOpts,
  type SeverityCounts,
  type SlackPayload,
} from "./block-kit.js";
export {
  buildPayload,
  isSlackUrl,
  loadSeverityCounts,
  type BuildPayloadInput,
  type GenericRunCompletedPayload,
} from "./notifier.js";
