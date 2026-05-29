import { eq, testRuns } from "@furan/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { rollupRunStatus } from "../lib/checkpoint-rollup.js";

const runIdParam = z.object({ id: z.string().uuid() });

export async function registerRunLifecycleRoutes(
  app: FastifyInstance,
): Promise<void> {
  // POST /runs/:id/complete — explicit close from SDK 2.0.x.
  app.post(
    "/runs/:id/complete",
    { preHandler: app.authenticate },
    async (req, reply) => {
      const params = runIdParam.safeParse(req.params);
      if (!params.success) return reply.code(400).send({ error: "invalid_id" });

      // Wait up to 60s for outstanding diff jobs (best-effort poll).
      const deadline = Date.now() + 60_000;
      let rollup = await rollupRunStatus(app.db, params.data.id);
      while (rollup.status === "running" && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500));
        rollup = await rollupRunStatus(app.db, params.data.id);
      }

      await app.db
        .update(testRuns)
        .set({
          status: rollup.status,
          checkpointCount: rollup.checkpointCount,
          completedAt: new Date(),
        })
        .where(eq(testRuns.id, params.data.id));

      await app.broadcaster.publishRunEvent?.({
        type: "run.completed",
        runId: params.data.id,
        payload: {
          status: rollup.status,
          checkpointCount: rollup.checkpointCount,
        },
      });

      return reply.code(200).send({
        runId: params.data.id,
        status: rollup.status,
        checkpointCount: rollup.checkpointCount,
      });
    },
  );

  // POST /runs/:id/abort — explicit abort from SDK 2.0.x.
  app.post(
    "/runs/:id/abort",
    { preHandler: app.authenticate },
    async (req, reply) => {
      const params = runIdParam.safeParse(req.params);
      if (!params.success) return reply.code(400).send({ error: "invalid_id" });

      await app.db
        .update(testRuns)
        .set({ status: "aborted", completedAt: new Date() })
        .where(eq(testRuns.id, params.data.id));

      await app.broadcaster.publishRunEvent?.({
        type: "run.completed",
        runId: params.data.id,
        payload: { status: "aborted" },
      });

      return reply.code(200).send({ runId: params.data.id, status: "aborted" });
    },
  );
}
