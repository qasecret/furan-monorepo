import http, { type Server } from "node:http";

import type { Telemetry } from "@furan/telemetry";

export interface HealthOpts {
  port: number;
  telemetry: Telemetry;
  ready: () => Promise<boolean>;
}

export function startHealthServer(opts: HealthOpts): Server {
  const server = http.createServer(async (req, res) => {
    const url = req.url ?? "";
    if (url === "/livez") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ status: "ok" }));
    }
    if (url === "/readyz") {
      const ok = await opts.ready();
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
