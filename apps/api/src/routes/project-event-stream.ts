import { createRedisConnection } from "@furan/queue";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { recordFlushed } from "../lib/broadcast-metrics.js";
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

// Match legacy gateway (`events.gateway.ts:14-15`).
const DEBOUNCE_WAIT_MS = 1500;
const DEBOUNCE_MAX_WAIT_MS = 3000;

export interface ProjectEventStreamOptions {
  /** Called once after the SSE response headers are written. */
  onOpen?: () => void;
  /** Called once when the connection is torn down (also on subscribe failure). */
  onClose?: () => void;
}

/**
 * Open an SSE stream that fans Redis `project:{id}:events:raw` messages from a
 * set of channels into per-event-name debounced frames. Shared by the
 * per-project route (one channel) and the multiplexed inbox route (N channels
 * — every project the caller can access). The wire frame is identical for both:
 * `event: <name>\ndata: <JSON arr>\n\n`.
 *
 * Caller owns auth + any channel-set computation before calling this; the
 * helper hijacks the reply and never returns control of the socket.
 *
 * Spec: furan-design/specs/2026-06-19-multiplexed-inbox-sse-design.md
 */
export async function openProjectEventStream(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
  channels: string[],
  opts: ProjectEventStreamOptions = {},
): Promise<void> {
  reply.hijack();

  // SSE bypasses Fastify's onSend pipeline, so @fastify/cors never attaches
  // Allow-Origin. Mirror it ourselves, but only for an allowlisted Origin.
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
  opts.onOpen?.();

  // Per-connection state: 9 buffers + 9 debouncers, keyed by event name.
  const buffers: Record<ProjectEventName, unknown[]> = {
    build_created: [],
    build_updated: [],
    build_deleted: [],
    testRun_created: [],
    testRun_updated: [],
    testRun_deleted: [],
    "run.checkpoint_added": [],
    "run.checkpoint_diffed": [],
    "run.completed": [],
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
    "run.checkpoint_added": makeFlush("run.checkpoint_added"),
    "run.checkpoint_diffed": makeFlush("run.checkpoint_diffed"),
    "run.completed": makeFlush("run.completed"),
  } satisfies Record<ProjectEventName, ReturnType<typeof makeFlush>>;

  const subscriber = createRedisConnection();

  const onMessage = (_channel: string, payload: string): void => {
    let parsedMsg: { event?: string; data?: unknown };
    try {
      parsedMsg = JSON.parse(payload);
    } catch (err) {
      req.log.warn({ err, channels }, "project_sse_invalid_payload");
      return;
    }
    const ev = parsedMsg.event as ProjectEventName | undefined;
    if (!ev || !(ev in buffers)) return;
    buffers[ev].push(parsedMsg.data);
    flushers[ev]();
  };
  subscriber.on("message", onMessage);

  if (channels.length > 0) {
    try {
      await subscriber.subscribe(...channels);
    } catch (err) {
      req.log.error({ err, channels }, "project_sse_subscribe_failed");
      opts.onClose?.();
      reply.raw.end();
      await subscriber.quit().catch(() => undefined);
      return;
    }
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
    if (channels.length > 0) {
      try {
        await subscriber.unsubscribe(...channels);
      } catch {
        /* ignore */
      }
    }
    await subscriber.quit().catch(() => undefined);
    opts.onClose?.();
  };

  req.raw.on("close", () => void cleanup());
  req.raw.on("aborted", () => void cleanup());
}
