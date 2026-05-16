import { eq, testRuns } from "@furan/db";
import { createRedisConnection } from "@furan/queue";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { requireProjectMember } from "../hooks/require-project-member.js";

const paramsSchema = z.object({ id: z.string().uuid() });

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
        return reply.code(404).send({ error: "not_found" });
      }
      const { id } = parsed.data;

      // Take ownership of the raw socket — Fastify will not touch it.
      reply.hijack();

      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
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
