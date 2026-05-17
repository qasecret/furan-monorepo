import type { Telemetry } from "@furan/telemetry";
import type { Redis } from "ioredis";
import type { App } from "octokit";

import { handleRunCompleted } from "./handle-run-completed.js";
import { parseRunEvent } from "./types.js";

type Logger = Telemetry["logger"];

export interface RunEventsSubscriber {
  close: () => Promise<void>;
}

/**
 * Subscribe to `run:*:events` on Redis Pub/Sub and dispatch on `type`.
 *
 * T8: handle `run.completed` by posting sticky PR comment + commit status
 * (when `githubApp` is configured AND the event payload carries the
 * required GitHub fields). Other event types just log at debug.
 *
 * Caller MUST pass a dedicated ioredis client — pub/sub mode blocks the
 * connection from issuing normal commands, so reusing the primary
 * connection would deadlock the rest of the app.
 *
 * If `githubApp` is undefined (no GitHub App credentials configured) the
 * subscriber still runs — it just no-ops on `run.completed`. That keeps
 * dev environments without an App installed working.
 */
export function startRunEventsSubscriber(
  redis: Redis,
  log: Logger,
  githubApp: App | undefined,
): RunEventsSubscriber {
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
      if (!githubApp) {
        log.debug({ channel }, "run_completed_skipped_no_github_app");
        return;
      }
      void handleRunCompleted({
        githubApp,
        event: event as Extract<typeof event, { type: "run.completed" }>,
        log,
      }).catch((err) => {
        log.error({ err, channel }, "run_completed_handler_threw");
      });
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
