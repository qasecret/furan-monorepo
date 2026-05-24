import { eq, projects } from "@furan/db";
import { createRedisConnection } from "@furan/queue";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { requireProjectMember } from "../hooks/require-project-member.js";
import {
  decConnections,
  incConnections,
  recordFlushed,
} from "../lib/broadcast-metrics.js";
import type { ProjectEventName } from "../lib/broadcast.js";

/**
 * Tiny debounce with leading + maxWait semantics — same shape as
 * `lodash.debounce(fn, wait, { leading: true, maxWait })`. We avoid a
 * new dep (the monorepo has no lodash) by inlining ~25 LOC.
 *
 * Behavior:
 *  - First call fires `fn()` synchronously when `leading: true`.
 *  - Subsequent calls within `wait` ms reset the trailing timer.
 *  - `maxWait` guarantees `fn()` runs at most once every `maxWait` ms
 *    even under continuous bursts.
 *  - `.cancel()` clears pending timers so connection cleanup is clean.
 */
function debounce(
  fn: () => void,
  wait: number,
  opts: { leading: boolean; maxWait: number },
): (() => void) & { cancel: () => void } {
  let trailing: NodeJS.Timeout | null = null;
  let maxWaitTimer: NodeJS.Timeout | null = null;
  let lastInvoke = 0;

  const invoke = (): void => {
    lastInvoke = Date.now();
    if (trailing) {
      clearTimeout(trailing);
      trailing = null;
    }
    if (maxWaitTimer) {
      clearTimeout(maxWaitTimer);
      maxWaitTimer = null;
    }
    fn();
  };

  const debounced = (): void => {
    const now = Date.now();
    const sinceLast = now - lastInvoke;
    if (opts.leading && sinceLast >= wait && !trailing && !maxWaitTimer) {
      invoke();
      return;
    }
    if (trailing) clearTimeout(trailing);
    trailing = setTimeout(invoke, wait);
    if (!maxWaitTimer) {
      const remaining = Math.max(0, opts.maxWait - sinceLast);
      maxWaitTimer = setTimeout(invoke, remaining);
    }
  };

  debounced.cancel = (): void => {
    if (trailing) {
      clearTimeout(trailing);
      trailing = null;
    }
    if (maxWaitTimer) {
      clearTimeout(maxWaitTimer);
      maxWaitTimer = null;
    }
  };

  return debounced;
}

export const paramsSchema = z.object({ id: z.string().uuid() });

// Match legacy gateway (`events.gateway.ts:14-15`).
const DEBOUNCE_WAIT_MS = 1500;
const DEBOUNCE_MAX_WAIT_MS = 3000;

/**
 * Project-scoped SSE channel.
 *
 * Each open connection holds 6 per-event debounce buffers + flushers
 * (one per legacy event name). Raw events arrive via Redis pub/sub on
 * `project:{id}:events:raw`, get sorted into the matching buffer by
 * event name, and the lodash-debounced flusher fires as
 * `event: <name>\ndata: <JSON arr>\n\n` after 1.5s (or sooner via the
 * leading edge / 3s max-wait — matches the legacy backend's
 * `EventsGateway` shape one-for-one).
 *
 * Per-connection debouncing (vs centralized) keeps the design simple:
 * no shared buffer state across api replicas, no coordination, slow
 * clients self-isolate when their TCP write buffer fills.
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

      reply.hijack();

      // Same CORS allowlist mirror as `run-events.ts` — SSE bypasses the
      // onSend pipeline so the cors plugin's Allow-Origin header isn't
      // attached automatically.
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
      if (typeof reply.raw.flushHeaders === "function") {
        reply.raw.flushHeaders();
      }
      req.raw.socket?.setTimeout?.(0);
      incConnections(app.telemetry.metrics);

      // Per-connection state: 6 buffers + 6 debouncers, keyed by event name.
      const buffers: Record<ProjectEventName, unknown[]> = {
        build_created: [],
        build_updated: [],
        build_deleted: [],
        testRun_created: [],
        testRun_updated: [],
        testRun_deleted: [],
      };

      const makeFlush = (ev: ProjectEventName) =>
        debounce(
          () => {
            const arr = buffers[ev];
            if (arr.length === 0) return;
            const count = arr.length;
            const frame = `event: ${ev}\ndata: ${JSON.stringify(arr)}\n\n`;
            try {
              reply.raw.write(frame);
              recordFlushed(app.telemetry.metrics, ev, count);
            } catch (err) {
              req.log.warn({ err, event: ev }, "project_sse_write_failed");
            }
            buffers[ev] = [];
          },
          DEBOUNCE_WAIT_MS,
          { leading: true, maxWait: DEBOUNCE_MAX_WAIT_MS },
        );

      const flushers = {
        build_created: makeFlush("build_created"),
        build_updated: makeFlush("build_updated"),
        build_deleted: makeFlush("build_deleted"),
        testRun_created: makeFlush("testRun_created"),
        testRun_updated: makeFlush("testRun_updated"),
        testRun_deleted: makeFlush("testRun_deleted"),
      } satisfies Record<ProjectEventName, ReturnType<typeof makeFlush>>;

      const subscriber = createRedisConnection();
      const channel = `project:${id}:events:raw`;

      const onMessage = (_channel: string, payload: string): void => {
        let parsedMsg: { event?: string; data?: unknown };
        try {
          parsedMsg = JSON.parse(payload);
        } catch (err) {
          req.log.warn({ err, channel }, "project_sse_invalid_payload");
          return;
        }
        const ev = parsedMsg.event as ProjectEventName | undefined;
        if (!ev || !(ev in buffers)) return;
        buffers[ev].push(parsedMsg.data);
        flushers[ev]();
      };
      subscriber.on("message", onMessage);

      try {
        await subscriber.subscribe(channel);
      } catch (err) {
        req.log.error({ err, channel }, "project_sse_subscribe_failed");
        decConnections(app.telemetry.metrics);
        reply.raw.end();
        await subscriber.quit().catch(() => undefined);
        return;
      }

      const keepalive = setInterval(() => {
        try {
          reply.raw.write(":\n\n");
        } catch {
          // Client gone — the close handler will clean up.
        }
      }, 15_000);

      let cleanedUp = false;
      const cleanup = async (): Promise<void> => {
        if (cleanedUp) return;
        cleanedUp = true;
        clearInterval(keepalive);
        for (const f of Object.values(flushers)) {
          f.cancel();
        }
        subscriber.off("message", onMessage);
        try {
          await subscriber.unsubscribe(channel);
        } catch {
          /* ignore */
        }
        await subscriber.quit().catch(() => undefined);
        decConnections(app.telemetry.metrics);
      };

      req.raw.on("close", () => void cleanup());
      req.raw.on("aborted", () => void cleanup());
    },
  );
}
