import { eq, testRuns } from "@furan/db";
import { createRedisConnection } from "@furan/queue";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { requireProjectMember } from "../hooks/require-project-member.js";
import { sendError } from "../lib/errors.js";

export const paramsSchema = z.object({ id: z.string().uuid() });

export async function registerRunEventsRoute(
  app: FastifyInstance,
): Promise<void> {
  app.get(
    "/api/v1/runs/:id/events",
    {
      preHandler: [
        app.authenticate,
        requireProjectMember("read", {
          from: {
            resolver: async (req) => {
              const parsed = paramsSchema.safeParse(req.params);
              if (!parsed.success) return null;
              const row = await app.db
                .select({ projectId: testRuns.projectId })
                .from(testRuns)
                .where(eq(testRuns.id, parsed.data.id))
                .limit(1);
              return row[0]?.projectId ?? null;
            },
          },
        }),
      ],
    },
    async (req, reply) => {
      const parsed = paramsSchema.safeParse(req.params);
      if (!parsed.success) {
        return sendError(reply, 404, "not_found");
      }
      const { id } = parsed.data;

      // Take ownership of the raw socket — Fastify will not touch it.
      reply.hijack();

      // SSE responses bypass Fastify's onSend pipeline, so @fastify/cors
      // never adds Allow-Origin to the stream and the dashboard's
      // EventSource fails with "blocked by CORS policy: No
      // 'Access-Control-Allow-Origin' header is present on the requested
      // resource." Mirror what the cors plugin would have set — only when
      // the request's Origin actually matches the FURAN_DASHBOARD_ORIGIN
      // allowlist, so the SSE channel stays as locked-down as every other
      // route.
      const sseCorsHeaders: Record<string, string> = {};
      const reqOrigin = req.headers.origin;
      if (typeof reqOrigin === "string") {
        const allowed = app.env.FURAN_DASHBOARD_ORIGIN.split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        if (allowed.includes(reqOrigin)) {
          sseCorsHeaders["Access-Control-Allow-Origin"] = reqOrigin;
          sseCorsHeaders["Access-Control-Allow-Credentials"] = "true";
          sseCorsHeaders["Vary"] = "Origin";
        }
      }

      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        ...sseCorsHeaders,
      });
      // Flush headers immediately so clients see 200 before any frame.
      if (typeof reply.raw.flushHeaders === "function") {
        reply.raw.flushHeaders();
      }

      // Disable socket idle timeout (per P2-R4: SSE may sit idle for minutes).
      req.raw.socket?.setTimeout?.(0);

      const subscriber = createRedisConnection();
      const channel = `run:${id}:events`;

      const onMessage = (_channel: string, payload: string): void => {
        reply.raw.write(`event: progress\ndata: ${payload}\n\n`);
      };
      subscriber.on("message", onMessage);

      try {
        await subscriber.subscribe(channel);
      } catch (err) {
        req.log.error({ err, channel }, "sse_subscribe_failed");
        reply.raw.end();
        await subscriber.quit().catch(() => undefined);
        return;
      }

      const keepalive = setInterval(() => {
        reply.raw.write(":\n\n");
      }, 15_000);

      const cleanup = async (): Promise<void> => {
        clearInterval(keepalive);
        subscriber.off("message", onMessage);
        try {
          await subscriber.unsubscribe(channel);
        } catch {
          /* ignore */
        }
        await subscriber.quit().catch(() => undefined);
      };

      req.raw.on("close", () => {
        void cleanup();
      });
    },
  );
}
