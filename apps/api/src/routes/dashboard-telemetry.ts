import { dashboardTelemetryEvents } from "@furan/db";
import { dashboardTelemetryRecordInput } from "@furan/shared-types";
import type { FastifyInstance } from "fastify";

import { sendError } from "../lib/errors.js";

export async function registerDashboardTelemetryRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.post(
    "/dashboard/telemetry",
    { preHandler: app.authenticate },
    async (req, reply) => {
      const parsed = dashboardTelemetryRecordInput.safeParse(req.body);
      if (!parsed.success) {
        return sendError(
          reply,
          400,
          "invalid_body",
          undefined,
          parsed.error.flatten(),
        );
      }

      try {
        await app.db.insert(dashboardTelemetryEvents).values({
          userId: req.auth!.id,
          event: parsed.data.event,
          props: parsed.data.props,
        });
      } catch (err) {
        // Best-effort: never fail the user's session over a telemetry write.
        // Log + 204 anyway so the client never retries (the operation isn't
        // idempotent from the client's perspective).
        req.log.warn(
          { err, event: parsed.data.event },
          "dashboard_telemetry_write_failed",
        );
      }
      return reply.status(204).send();
    },
  );
}
