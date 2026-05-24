import type { Redis } from "@furan/queue";
import type { Telemetry } from "@furan/telemetry";

import { recordPublished } from "./broadcast-metrics.js";

/**
 * Six broadcast event names — verbatim parity with the predecessor's
 * Socket.io gateway (`/Users/rabindrabiswal/Workspace/backend/src/shared/events/events.gateway.ts`).
 * Dashboard SDK consumers porting from the legacy backend's
 * `SocketProvider` listen for exactly these strings.
 */
export type ProjectEventName =
  | "build_created"
  | "build_updated"
  | "build_deleted"
  | "testRun_created"
  | "testRun_updated"
  | "testRun_deleted";

export interface ProjectBroadcastEvent {
  event: ProjectEventName;
  data: unknown;
}

export interface Broadcaster {
  publishProjectEvent(
    projectId: string,
    ev: ProjectBroadcastEvent,
  ): Promise<void>;
}

/**
 * Build the broadcaster that producers (REST routes, tRPC mutations,
 * branch-merge helper, diff worker via its own redis client) call to
 * push raw events onto the project channel.
 *
 * Channel naming: `project:{projectId}:events:raw`. The `:raw` suffix
 * distinguishes from the per-run channel (`run:{runId}:events`) and
 * leaves room for a hypothetical centralized-debounce variant later;
 * the current design debounces per-connection in the SSE route, so
 * there's nothing reading from a non-raw project channel right now.
 *
 * Failure semantics: best-effort. List-level liveness is a UX feature,
 * not a correctness one — if Redis is unreachable for 30 seconds, runs
 * still complete, baselines still resolve, the diff worker still
 * persists results. Producers must never have their write paths fail
 * because a broadcast couldn't deliver. We log and swallow.
 *
 * Spec: furan-design/specs/2026-05-24-list-level-live-updates-design.md
 */
export function createBroadcaster(
  redis: Redis,
  telemetry: Telemetry,
): Broadcaster {
  return {
    async publishProjectEvent(projectId, ev) {
      const channel = `project:${projectId}:events:raw`;
      const payload = JSON.stringify({
        event: ev.event,
        data: ev.data,
        ts: Date.now(),
      });
      try {
        await redis.publish(channel, payload);
      } catch (err) {
        telemetry.logger.warn(
          { err, projectId, event: ev.event },
          "broadcast_publish_failed",
        );
        return;
      }
      // Metric recording is best-effort separate from the publish — a
      // duplicate-Registry registration in tests, or a prom-client
      // throwing on label cardinality limits in production, must NOT
      // be reported as `broadcast_publish_failed` (the publish actually
      // succeeded). Log under its own key so operators can tell the
      // difference.
      try {
        recordPublished(telemetry.metrics, ev.event);
      } catch (err) {
        telemetry.logger.warn(
          { err, projectId, event: ev.event },
          "broadcast_metric_record_failed",
        );
      }
    },
  };
}
