import http, { type Server } from "node:http";

import type { Telemetry } from "@furan/telemetry";

export interface HealthOpts {
  port: number;
  telemetry: Telemetry;
  /**
   * Readiness probe. T7 always returns true; T8/T9 will plug in Redis
   * connectivity + GitHub App auth checks.
   */
  ready?: () => Promise<boolean>;
}

/**
 * Separate `node:http` health server, mirrors the worker pattern (see
 * apps/diff-worker/src/health.ts). Lives on its own port so orchestrators
 * (kube probes, fly health checks) can probe liveness/readiness without
 * touching the Fastify port, which may be busy serving webhook deliveries.
 *
 * Routes:
 *   GET /livez   → 200 {status:"ok"}
 *   GET /healthz → 200 "ok"            (T7 plain-text alias for portability)
 *   GET /readyz  → 200/503 {status, …}
 *   GET /metrics → prom-client registry
 */
export function startHealthServer(opts: HealthOpts): Server {
  const ready = opts.ready ?? (async () => true);
  const server = http.createServer(async (req, res) => {
    const url = req.url ?? "";
    if (url === "/livez") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ status: "ok" }));
    }
    if (url === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      return res.end("ok");
    }
    if (url === "/readyz") {
      let ok = false;
      try {
        ok = await ready();
      } catch {
        ok = false;
      }
      res.writeHead(ok ? 200 : 503, { "content-type": "application/json" });
      return res.end(JSON.stringify({ status: ok ? "ok" : "not_ready" }));
    }
    if (url === "/metrics") {
      const body = await opts.telemetry.metrics.metrics();
      res.writeHead(200, {
        "content-type": "text/plain; version=0.0.4; charset=utf-8",
      });
      return res.end(body);
    }
    res.writeHead(404);
    return res.end();
  });
  server.listen(opts.port);
  return server;
}
