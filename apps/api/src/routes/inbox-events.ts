import type { FastifyInstance } from "fastify";

import {
  decInboxConnections,
  incInboxConnections,
} from "../lib/broadcast-metrics.js";
import { listAccessibleProjectIds } from "../lib/project-membership.js";

import { openProjectEventStream } from "./project-event-stream.js";

/**
 * Multiplexed, caller-scoped SSE channel for the cross-project inbox.
 *
 * One connection streams events for EVERY project the caller can access,
 * sidestepping the browser's ~6-per-origin HTTP/1.1 connection cap that the
 * inbox's old one-EventSource-per-project fan-out saturated (which also
 * starved every other XHR to the API origin). Reuses the same Redis channels
 * (`project:{id}:events:raw`), debounce buffers, and SSE wire frames as the
 * per-project route — only the channel SET and the auth differ.
 *
 * Membership is enumerated at connect time; a project added mid-session is
 * picked up when the client reconnects (InboxRealtime reopens on project-list
 * change).
 *
 * Spec: furan-design/specs/2026-06-19-multiplexed-inbox-sse-design.md
 */
export async function registerInboxEventsRoute(
  app: FastifyInstance,
): Promise<void> {
  app.get(
    "/api/v1/events",
    { preHandler: [app.authenticate] },
    async (req, reply) => {
      if (!req.auth) {
        return reply.code(401).send({ error: "unauthenticated" });
      }
      const projectIds = await listAccessibleProjectIds(app.db, req.auth);
      const channels = projectIds.map((id) => `project:${id}:events:raw`);
      await openProjectEventStream(app, req, reply, channels, {
        onOpen: () => incInboxConnections(app.telemetry.metrics),
        onClose: () => decInboxConnections(app.telemetry.metrics),
      });
    },
  );
}
