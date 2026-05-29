import { eq, testRuns } from "@furan/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { requireProjectMember } from "../hooks/require-project-member.js";
import { rollupRunStatus } from "../lib/checkpoint-rollup.js";

const runIdParam = z.object({ id: z.string().uuid() });

/**
 * Looks up the projectId for a run by its UUID. Returns null when the UUID
 * is malformed or no matching row exists — the requireProjectMember gate
 * will return 400 in that case (missing_project_scope).
 */
async function resolveRunProjectId(
  app: FastifyInstance,
  runId: string,
): Promise<string | null> {
  const parsed = runIdParam.safeParse({ id: runId });
  if (!parsed.success) return null;
  const rows = await app.db
    .select({ projectId: testRuns.projectId })
    .from(testRuns)
    .where(eq(testRuns.id, parsed.data.id))
    .limit(1);
  return rows[0]?.projectId ?? null;
}

export async function registerRunLifecycleRoutes(
  app: FastifyInstance,
): Promise<void> {
  // POST /runs/:id/complete — explicit close from SDK 2.0.x.
  app.post(
    "/runs/:id/complete",
    {
      preHandler: [
        app.authenticate,
        requireProjectMember("write", {
          from: {
            resolver: async (req) => {
              const params = req.params as Record<string, unknown>;
              const id = typeof params.id === "string" ? params.id : "";
              return resolveRunProjectId(app, id);
            },
          },
        }),
      ],
    },
    async (req, reply) => {
      const params = runIdParam.safeParse(req.params);
      if (!params.success) return reply.code(400).send({ error: "invalid_id" });

      // Roll up the current diff_regions state into a run status. We do
      // NOT block here on outstanding diff jobs — earlier drafts polled
      // for `rollup.status === "running"`, which rollupRunStatus never
      // returns (it surfaces empty / passed / unresolved). The dashboard
      // SSE (run.checkpoint_diffed / run.completed) refreshes the row
      // as each checkpoint's diff settles, so the SDK gets a fast
      // "synchronous-looking" reply here and the eventual final status
      // arrives via the live channel.
      //
      // Tightening this to a real synchronous wait requires either a
      // per-checkpoint diff_outcome column or a queue.getJobs filter on
      // the BullMQ side — both deferred as v1.1.2+ polish.
      const rollup = await rollupRunStatus(app.db, params.data.id);

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
    {
      preHandler: [
        app.authenticate,
        requireProjectMember("write", {
          from: {
            resolver: async (req) => {
              const params = req.params as Record<string, unknown>;
              const id = typeof params.id === "string" ? params.id : "";
              return resolveRunProjectId(app, id);
            },
          },
        }),
      ],
    },
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
