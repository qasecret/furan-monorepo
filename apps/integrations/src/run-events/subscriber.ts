import type { DB } from "@furan/db";
import type { Queue, WebhookJob } from "@furan/queue";
import type { Telemetry } from "@furan/telemetry";
import type { Redis } from "ioredis";
import type { App } from "octokit";

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
 *     the GitHub fields on the event are present — best-effort).
 *   - T9: enqueue outbound webhook deliveries for every active
 *     subscriber matching the project + "run.completed" event (when
 *     `db` AND `webhookQueue` are wired).
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
