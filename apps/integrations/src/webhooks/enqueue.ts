import { and, eq, sql, webhooks, type DB } from "@furan/db";
import type { Queue, WebhookJob } from "@furan/queue";
import type { Telemetry } from "@furan/telemetry";

import type { RunEvent } from "../run-events/types.js";
import { buildPayload, loadSeverityCounts } from "../slack/notifier.js";

type Logger = Telemetry["logger"];

export interface EnqueueDeps {
  db: DB;
  logger: Logger;
  webhookQueue: Queue<WebhookJob>;
  /**
   * Base URL for the dashboard so we can render deep-links into Slack /
   * generic payloads. Defaults to "" — Slack will accept an empty button
   * URL but it's nicer to wire a real one in `server.ts`.
   */
  dashboardBaseUrl?: string;
}

/**
 * Called by the run-events subscriber on `run.completed`. Looks up all
 * active webhooks for the project whose `events` array contains
 * "run.completed", builds the per-subscriber payload (Slack-shaped or
 * generic), and enqueues one `webhook` BullMQ job per subscriber.
 *
 * Project scoping is enforced via the `webhooks.projectId` filter in the
 * query. No need for `withProjectScope` here — this is a read against an
 * indexed column, not a write that would benefit from the
 * `app.current_project_id` transaction marker.
 */
export async function enqueueWebhookDeliveries(
  event: Extract<RunEvent, { type: "run.completed" }>,
  deps: EnqueueDeps,
): Promise<{ enqueued: number }> {
  if (!event.projectId) {
    deps.logger.debug(
      { runId: event.runId },
      "webhook_enqueue_skipped_missing_project_id",
    );
    return { enqueued: 0 };
  }

  const hooks = await deps.db
    .select()
    .from(webhooks)
    .where(
      and(
        eq(webhooks.projectId, event.projectId),
        eq(webhooks.active, true),
        sql`${webhooks.events} @> ARRAY['run.completed']::text[]`,
      ),
    );

  if (hooks.length === 0) {
    deps.logger.debug(
      { runId: event.runId, projectId: event.projectId },
      "webhook_enqueue_no_subscribers",
    );
    return { enqueued: 0 };
  }

  // Severity tally is shared across all subscribers — load once.
  const severityCounts = await loadSeverityCounts(deps.db, event.runId);

  const dashboardUrl =
    event.dashboardUrl ??
    (deps.dashboardBaseUrl
      ? `${deps.dashboardBaseUrl}/projects/${event.projectId}/runs/${event.runId}`
      : "");

  let enqueued = 0;
  let skipped = 0;
  for (const hook of hooks) {
    const payload = buildPayload(hook.url, {
      event,
      branchName: event.branchName ?? "",
      severityCounts,
      dashboardUrl,
    });

    // `buildPayload` returns null when a Slack subscriber is asked to
    // notify on a non-terminal status (e.g. `running`). Skip silently.
    if (payload === null) {
      skipped++;
      continue;
    }

    await deps.webhookQueue.add("webhook", {
      projectId: event.projectId,
      webhookId: hook.id,
      event: "run.completed",
      payload,
    });
    enqueued++;
  }

  if (skipped > 0) {
    deps.logger.debug(
      {
        runId: event.runId,
        projectId: event.projectId,
        skipped,
        status: event.status,
      },
      "webhook_deliveries_skipped_non_terminal",
    );
  }

  deps.logger.info(
    {
      runId: event.runId,
      projectId: event.projectId,
      enqueued,
    },
    "webhook_deliveries_enqueued",
  );
  return { enqueued };
}
