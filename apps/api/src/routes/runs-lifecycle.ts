import { eq, screenshots, testRuns } from "@furan/db";
import { TRPCError } from "@trpc/server";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { requireProjectMember } from "../hooks/require-project-member.js";
import { approveRun } from "../trpc/v1/runs.js";

const runIdParam = z.object({ id: z.string().uuid() });

/**
 * Counts the run's persisted checkpoints (one screenshots row per
 * checkpoint). Used by /complete to decide `empty` vs leave-to-pipeline,
 * and to stamp `checkpointCount`.
 */
async function checkpointCountForRun(
  app: FastifyInstance,
  runId: string,
): Promise<number> {
  const rows = await app.db
    .select({ id: screenshots.id })
    .from(screenshots)
    .where(eq(screenshots.runId, runId));
  return rows.length;
}

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

      // Contract (post eyes-compat fix): /complete stamps the run as
      // *closed by the SDK* but does NOT decide the diff verdict — the
      // diff pipeline owns `test_runs.status`. Earlier drafts computed a
      // rollup status here and wrote it, but that rollup never returns
      // `running` (only empty / passed / unresolved). For a run
      // whose async diff jobs are still in flight that produced a
      // premature `passed` (checkpoints exist, no diff_regions yet),
      // which the SDK's completeAndAwaitRun fast-returned as a false
      // PASS — never polling for the true verdict and never reaching the
      // `new` state that saveNewTests keys on.
      //
      // New behavior, two cases keyed on checkpoint count:
      //   * 0 checkpoints  → genuinely terminal `empty` (the diff-worker
      //     will never run for this run), stamp status + completedAt.
      //   * >=1 checkpoint  → stamp ONLY completedAt + checkpointCount;
      //     leave `status` untouched (it stays `running` until the
      //     diff-worker writes new/unresolved/passed/aborted). Re-read
      //     and return the CURRENT status so the SDK sees `running` and
      //     polls getRun until the worker settles it.
      //
      // The dashboard does NOT depend on a synchronous status here — it
      // refreshes the row from the worker's `run.completed` /
      // `run.checkpoint_diffed` SSE — so leaving the verdict to the
      // pipeline is safe.
      const checkpointCount = await checkpointCountForRun(app, params.data.id);

      let status: string;
      if (checkpointCount === 0) {
        await app.db
          .update(testRuns)
          .set({
            status: "empty",
            checkpointCount,
            completedAt: new Date(),
          })
          .where(eq(testRuns.id, params.data.id));
        status = "empty";
      } else {
        // Stamp completion only — the diff pipeline owns `status`.
        await app.db
          .update(testRuns)
          .set({
            checkpointCount,
            completedAt: new Date(),
          })
          .where(eq(testRuns.id, params.data.id));
        // Re-read the live status so the payload + reply reflect reality
        // (running until diffs settle), never a premature rollup.
        const rows = await app.db
          .select({ status: testRuns.status })
          .from(testRuns)
          .where(eq(testRuns.id, params.data.id))
          .limit(1);
        status = rows[0]?.status ?? "running";
      }

      // Preserve the existing `run.completed` broadcast (the dashboard +
      // integrations listen for it), but its payload status now reflects
      // the actual current status rather than a premature rollup.
      await app.broadcaster.publishRunEvent?.({
        type: "run.completed",
        runId: params.data.id,
        payload: {
          status,
          checkpointCount,
        },
      });

      return reply.code(200).send({
        runId: params.data.id,
        status,
        checkpointCount,
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

  // POST /runs/:id/approve — REST wrapper over approveRun (SDK saveNewTests).
  app.post(
    "/runs/:id/approve",
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
      if (!req.auth) return reply.code(401).send({ error: "unauthenticated" });
      try {
        const out = await approveRun(
          {
            db: app.db,
            broadcaster: app.broadcaster,
            user: { id: req.auth.id },
          },
          params.data.id,
        );
        return reply.code(200).send(out);
      } catch (err) {
        if (err instanceof TRPCError) {
          switch (err.code) {
            case "NOT_FOUND":
              return reply.code(404).send({ error: "not_found" });
            case "BAD_REQUEST":
              // Run is in a non-approvable state → 409 Conflict
              return reply.code(409).send({ error: "approve_failed" });
            case "FORBIDDEN":
              return reply.code(403).send({ error: "forbidden" });
            case "UNAUTHORIZED":
              return reply.code(401).send({ error: "unauthorized" });
            default:
              req.log.error({ err }, "rest_approve_unexpected_trpc_error");
              return reply.code(500).send({ error: "internal_error" });
          }
        }
        req.log.error({ err }, "rest_approve_failed");
        return reply.code(500).send({ error: "internal_error" });
      }
    },
  );
}
