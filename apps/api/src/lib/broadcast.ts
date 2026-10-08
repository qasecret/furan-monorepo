import type { Redis } from "@furan/queue";
import type { Telemetry } from "@furan/telemetry";

import { recordPublished } from "./broadcast-metrics.js";

/**
 * Broadcast event names emitted on the project SSE channel. The first six
 * are verbatim parity with the predecessor backend's Socket.io events gateway.
 * Dashboard SDK consumers porting from the legacy backend's `SocketProvider`
 * listen for exactly those strings.
 *
 * ADR-038 adds three checkpoint-lifecycle events so the dashboard's
 * CheckpointStrip and DiffViewer receive live updates without polling.
 */
export type ProjectEventName =
  | "build_created"
  | "build_updated"
  | "build_deleted"
  | "testRun_created"
  | "testRun_updated"
  | "testRun_deleted"
  // ADR-038: checkpoint lifecycle events
  | "run.checkpoint_added"
  | "run.checkpoint_diffed"
  | "run.completed";

export interface ProjectBroadcastEvent {
  event: ProjectEventName;
  data: unknown;
}

/**
 * ADR-038: per-run event types for the run-level SSE channel.
 * Phase 5 will tighten payload typing for the dashboard side.
 */
export type RunEventType =
  | "run.checkpoint_added"
  | "run.checkpoint_diffed"
  | "run.completed";

export interface RunBroadcastEvent {
  type: RunEventType;
  runId: string;
  payload: Record<string, unknown>;
}

export interface Broadcaster {
  publishProjectEvent(
    projectId: string,
    ev: ProjectBroadcastEvent,
  ): Promise<void>;
  /**
   * Best-effort per-run event publish. Used by the lifecycle routes
   * (complete, abort) and the screenshot upload path. Callers must not
   * fail their write path when this rejects — it is best-effort, same as
   * publishProjectEvent.
   */
  publishRunEvent?(ev: RunBroadcastEvent): Promise<void>;
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

    async publishRunEvent(ev) {
      const channel = `run:${ev.runId}:events`;
      const payload = JSON.stringify({
        type: ev.type,
        runId: ev.runId,
        payload: ev.payload,
        ts: Date.now(),
      });
      try {
        await redis.publish(channel, payload);
      } catch (err) {
        telemetry.logger.warn(
          { err, runId: ev.runId, type: ev.type },
          "broadcast_run_event_failed",
        );
      }
    },
  };
}
