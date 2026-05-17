import type { Telemetry } from "@furan/telemetry";
import type { Redis } from "ioredis";

type Logger = Telemetry["logger"];

export interface RunEventsSubscriber {
  close: () => Promise<void>;
}

/**
 * Subscribe to `run:*:events` on Redis Pub/Sub. T7 is a no-op stub that
 * just logs; T8 (GitHub commit-status updater) and T9 (outbound webhooks
 * + Slack notifier) will register real handlers here.
 *
 * Caller MUST pass a dedicated ioredis client — pub/sub mode blocks the
 * connection from issuing normal commands, so reusing the primary
 * connection would deadlock the rest of the app.
 */
export function startRunEventsSubscriber(
  redis: Redis,
  log: Logger,
): RunEventsSubscriber {
  redis.psubscribe("run:*:events", (err, count) => {
    if (err) {
      log.error({ err }, "run_events_subscribe_failed");
      return;
    }
    log.info({ count }, "run_events_subscribed");
  });

  redis.on("pmessage", (_pattern, channel, message) => {
    log.debug({ channel, message }, "run_event_received");
    // T8/T9 plug handlers here.
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
