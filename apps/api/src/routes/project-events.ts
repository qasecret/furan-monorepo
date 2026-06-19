import { eq, projects } from "@furan/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { requireProjectMember } from "../hooks/require-project-member.js";
import { decConnections, incConnections } from "../lib/broadcast-metrics.js";

import { openProjectEventStream } from "./project-event-stream.js";

export const paramsSchema = z.object({ id: z.string().uuid() });

/**
 * Project-scoped SSE channel for single-project pages (Builds, Runs, Build
 * detail, Variation detail). Subscribes to one `project:{id}:events:raw`
 * channel; the multiplexed inbox route (`inbox-events.ts`) shares the same
 * stream machinery via `openProjectEventStream`.
 *
 * Spec: furan-design/specs/2026-05-24-list-level-live-updates-design.md
 */
export async function registerProjectEventsRoute(
  app: FastifyInstance,
): Promise<void> {
  app.get(
    "/api/v1/projects/:id/events",
    {
      preHandler: [
        app.authenticate,
        requireProjectMember("read", { from: { params: "id" } }),
      ],
    },
    async (req, reply) => {
      const parsed = paramsSchema.safeParse(req.params);
      if (!parsed.success) {
        return reply.code(404).send({ error: "not_found" });
      }
      const { id } = parsed.data;

      // Defense-in-depth: requireProjectMember catches non-members, but a
      // deleted project shouldn't 200 here.
      const projectRows = await app.db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.id, id))
        .limit(1);
      if (!projectRows[0]) {
        return reply.code(404).send({ error: "not_found" });
      }

      await openProjectEventStream(
        app,
        req,
        reply,
        [`project:${id}:events:raw`],
        {
          onOpen: () => incConnections(app.telemetry.metrics),
          onClose: () => decConnections(app.telemetry.metrics),
        },
      );
    },
  );
}
