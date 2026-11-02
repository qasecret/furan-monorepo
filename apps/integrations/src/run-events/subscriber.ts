import type { DB } from "@furan/db";
import type { Queue, WebhookJob } from "@furan/queue";
import type { Telemetry } from "@furan/telemetry";
import type { Redis } from "ioredis";
import type { App } from "octokit";

import { createPostMemo } from "../github/post-memo.js";
import { enqueueWebhookDeliveries } from "../webhooks/enqueue.js";

import { handleRunCompleted } from "./handle-run-completed.js";
import { parseRunEvent } from "./types.js";

type Logger = Telemetry["logger"];

export interface RunEventsSubscriber {
  close: () => Promise<void>;
}

export interface StartRunEventsSubscriberDeps {
  redis: Redis;
  logger: Logger;
  githubApp?: App;
  db?: DB;
  webhookQueue?: Queue<WebhookJob>;
  dashboardBaseUrl?: string;
}

/**
 * Subscribe to `run:*:events` on Redis Pub/Sub and dispatch on `type`.
 *
 * On `run.completed`:
 *   - T8: post sticky PR comment + commit status (when `githubApp` AND
 *     the GitHub context resolves — from the event, else from the run row
 *     and the project's installation link via `db`; best-effort).
 *   - T9: enqueue outbound webhook deliveries for every active
 *     subscriber matching the project + "run.completed" event (when
 *     `db` AND `webhookQueue` are wired).
 *
 * On `run.reviewed` (published by the api after a review action): refresh the
 * GitHub comment and commit status only. It never reaches Slack or the
 * outbound webhooks.
 *
 * Both handlers are independent and best-effort — if one fails it logs
 * and continues. Other event types just log at debug.
 *
 * Caller MUST pass a dedicated ioredis client — pub/sub mode blocks the
 * connection from issuing normal commands, so reusing the primary
 * connection would deadlock the rest of the app.
 */
export function startRunEventsSubscriber(
  deps: StartRunEventsSubscriberDeps,
): RunEventsSubscriber {
  const { redis, logger: log, githubApp, db, webhookQueue } = deps;
  // What was last posted per commit, shared by every call of this subscriber so
  // an unchanged commit status is not posted again.
  const postMemo = createPostMemo();

  redis.psubscribe("run:*:events", (err, count) => {
    if (err) {
      log.error({ err }, "run_events_subscribe_failed");
      return;
    }
    log.info({ count }, "run_events_subscribed");
  });

  redis.on("pmessage", (_pattern, channel, message) => {
    const event = parseRunEvent(message);
    if (!event) {
      log.warn({ channel }, "run_event_unparseable");
      return;
    }
    log.debug({ channel, type: event.type }, "run_event_received");

    if (event.type === "run.completed") {
      const completed = event as Extract<
        typeof event,
        { type: "run.completed" }
      >;

      if (githubApp) {
        void handleRunCompleted({
          githubApp,
          event: completed,
          log,
          ...(db ? { db } : {}),
          ...(deps.dashboardBaseUrl
            ? { dashboardBaseUrl: deps.dashboardBaseUrl }
            : {}),
          postMemo,
        }).catch((err) => {
          log.error({ err, channel }, "run_completed_handler_threw");
        });
      } else {
        log.debug({ channel }, "run_completed_skipped_no_github_app");
      }

      if (db && webhookQueue) {
        void enqueueWebhookDeliveries(completed, {
          db,
          logger: log,
          webhookQueue,
          ...(deps.dashboardBaseUrl
            ? { dashboardBaseUrl: deps.dashboardBaseUrl }
            : {}),
        }).catch((err) => {
          log.error({ err, channel }, "webhook_enqueue_threw");
        });
      } else {
        log.debug({ channel }, "webhook_enqueue_skipped_no_db_or_queue");
      }
    } else if (event.type === "run.reviewed") {
      // A reviewer's action moved a run's status, which no diff announces.
      // Only the GitHub comment and commit status follow it; Slack and the
      // outbound webhooks keep to `run.completed`. The frame carries nothing
      // but the run id: the handler reads the status from the stored run.
      if (githubApp && typeof event.runId === "string") {
        void handleRunCompleted({
          githubApp,
          event: { type: "run.completed", runId: event.runId },
          log,
          ...(db ? { db } : {}),
          ...(deps.dashboardBaseUrl
            ? { dashboardBaseUrl: deps.dashboardBaseUrl }
            : {}),
          postMemo,
        }).catch((err) => {
          log.error({ err, channel }, "run_reviewed_handler_threw");
        });
      }
    }
  });

  return {
    close: async () => {
      try {
        await redis.punsubscribe("run:*:events");
      } catch (err) {
        log.warn({ err }, "run_events_unsubscribe_failed");
      }
    },
  };
}
